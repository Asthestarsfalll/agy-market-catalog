// Multi-source Discovery, Aggregator Parser, All-4-Layout Scanner & Zero-Quota Snapshot Resolver
// (`scripts/lib/discovery-sources.mjs`).
//
// Strictly static & zero untrusted code execution:
// - Channel A: High-SNR GitHub Repo Search (singular + plural topics, name queries, noise-reduced broad queries;
//              NEVER unscoped bare `topic:antigravity`) + Fail-Open throttled Code Search.
// - Channel B: Declarative `data/aggregators.json` parser (Markdown Awesome lists + JSON indexes + Monorepos)
//              with strict GitHub URL allowlist sanitization, 2 MB / 15s fetch caps, and 4-layout archive scanning.
// - Channel C: Immutable 3-tier snapshot resolver (Release -> SemVer Tag -> Default-branch 40-hex Commit SHA)
//              with zero-REST-API-quota fallback (`HEAD /releases/latest` + `git-upload-pack` `info/refs` + `.atom`).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pruneNestedCandidateRoots } from './authenticity-scorer.mjs';
import {
  buildSourceArchiveUrl,
  compareSemver,
  FIRST_PARTY_REPO_OWNERS,
  MAX_TARBALL_BYTES,
  normalizeRelPosix,
  parseSemver,
  toScopedPluginName,
} from './constants.mjs';
import { validateSafeArchivePath } from './tar-stream.mjs';

export const MAX_AGGREGATOR_DOC_BYTES = 2 * 1024 * 1024; // 2 MB
export const AGGREGATOR_FETCH_TIMEOUT_MS = 15_000; // 15s
export const TARBALL_FETCH_TIMEOUT_MS = 60_000; // 60s
export const MAX_CANDIDATES_PER_AGGREGATOR = 200;
export const DEFAULT_MAX_PLUGINS_PER_REPO = 30;
export const CODE_SEARCH_DELAY_MS = 6_500;
export const REPO_SEARCH_DELAY_MS = 2_200;

export const GITHUB_NON_REPO_OWNERS = new Set([
  'features',
  'topics',
  'orgs',
  'sponsors',
  'marketplace',
  'settings',
  'about',
  'explore',
  'login',
  'logout',
  'signup',
  'join',
  'pricing',
  'collections',
  'events',
  'apps',
  'security',
  'solutions',
  'enterprise',
  'site',
  'contact',
  'customer-stories',
  'readme',
  'trending',
  'notifications',
  'pulls',
  'issues',
  'codespaces',
  'copilot',
  'models',
  'advisories',
  'new',
  'organizations',
  'users',
  'search',
  'blog',
  'docs',
]);

export const GITHUB_NON_CODE_SUBPATHS = new Set([
  'issues',
  'pull',
  'pulls',
  'discussions',
  'wiki',
  'actions',
  'releases',
  'commits',
  'stargazers',
  'forks',
  'watchers',
  'network',
  'graphs',
  'pulse',
  'projects',
  'security',
  'settings',
  'branches',
  'tags',
  'compare',
  'packages',
  'sponsors',
  'milestones',
  'labels',
  'archive',
]);

// Explicitly preserves `.agents`, `.agent`, `.antigravity-plugin`, and `host_resources`.
// Synced with `EXCLUDED_SCAN_DIR_SEGMENTS_V2` (`templates`/`template`/`starter` handled via
// `pruneNestedCandidateRoots` + `scoreAntigravityAuthenticity` so genuine `templates/plugin/agent-guard`
// survives while placeholder stubs are rejected).
export const EXCLUDED_SCAN_DIR_SEGMENTS = new Set([
  'node_modules',
  '.git',
  '.github',
  '.vscode',
  '.idea',
  '.tmp',
  'test',
  'tests',
  '__tests__',
  'fixtures',
  'mocks',
  '__fixtures__',
  'vendor',
  'target',
  'dist',
  'build',
  '.claude-plugin',
  '.claude',
  '.cursor',
  '.cursor-plugin',
  '.codex',
  '.codex-plugin',
  '.opencode',
  'copilot',
  'dsh',
  'examples',
  'example',
  'samples',
  'sample',
  'demo',
  'demos',
  'boilerplate',
  'archive',
  'archived',
  'deprecated',
  'docs',
  'website',
  'site',
  'locales',
  'plugin-src',
]);

const PLATFORM_SPECIFIC_ASSET_RE =
  /(?:^|[-_.])(?:darwin|macos|osx|apple|win32|win64|windows|msvc|linux|gnu|musl|aarch64|arm64|x86_64|amd64|x64|i686|armv7)(?:[-_.]|$)/i;

const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPO_RE = /^[A-Za-z0-9._-]+$/;
const OWNER_REPO_SHORTHAND_RE = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)$/;
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/i;

export const CHANNEL_A_CODE_QUERIES = [
  { id: 'C1-schema', query: 'filename:plugin.json "https://antigravity.google/schemas/v1/plugin.json"', maxPages: 2 },
  { id: 'C2-sidecar', query: 'filename:sidecar.json "SIDECAR_UI_ENTRYPOINT_AUX_PANE"', maxPages: 2 },
  { id: 'C3-companion', query: 'filename:agy-market.json "schemaVersion"', maxPages: 2 },
  { id: 'C4a-antigravity', query: 'filename:plugin.json "antigravity"', maxPages: 2 },
  { id: 'C4b-prompts', query: 'filename:plugin.json "suggestedPrompts"', maxPages: 2 },
];

export function buildShardedDateWindows(nowMs = Date.now(), windowCount = 4, windowDays = 90) {
  const windows = [];
  const dayMs = 86_400_000;
  let cursorEnd = nowMs;
  for (let i = 0; i < windowCount; i++) {
    const start = cursorEnd - windowDays * dayMs;
    const fromDate = new Date(start).toISOString().slice(0, 10);
    const toDate = new Date(cursorEnd).toISOString().slice(0, 10);
    windows.push(`pushed:${fromDate}..${toDate}`);
    cursorEnd = start - dayMs;
  }
  const oldestCutoff = new Date(cursorEnd).toISOString().slice(0, 10);
  windows.push(`pushed:<=${oldestCutoff}`);
  return windows;
}

/**
 * Channel A high-SNR GitHub Repository Search queries.
 * Intentionally NEVER runs an unqualified `topic:antigravity archived:false` blind scan (~5,891 noisy repos).
 */
export function buildChannelARepoQueries(nowMs = Date.now()) {
  const windows = buildShardedDateWindows(nowMs);
  const recent90dCutoff = new Date(nowMs - 90 * 86_400_000).toISOString().slice(0, 10);
  const queries = [];

  // Q1: Core singular + plural plugin topics
  for (const w of windows) {
    queries.push({
      id: `Q1-topic-singular:${w}`,
      query: `topic:antigravity-plugin archived:false ${w}`,
      sort: 'updated',
      perPage: 100,
      maxPages: 5,
    });
  }
  queries.push({
    id: 'Q1-topic-plural',
    query: 'topic:antigravity-plugins archived:false',
    sort: 'updated',
    perPage: 100,
    maxPages: 3,
  });

  // Q2: High-SNR repository name queries
  for (const w of windows) {
    queries.push({
      id: `Q2-name-singular:${w}`,
      query: `antigravity-plugin in:name archived:false ${w}`,
      sort: 'updated',
      perPage: 100,
      maxPages: 5,
    });
  }
  queries.push({
    id: 'Q2-name-plural',
    query: 'antigravity-plugins in:name archived:false',
    sort: 'updated',
    perPage: 100,
    maxPages: 3,
  });
  queries.push({
    id: 'Q2-name-agy-prefix',
    query: 'agy- in:name antigravity archived:false',
    sort: 'updated',
    perPage: 100,
    maxPages: 2,
  });

  // Noise-reduced structural qualifiers (broad topics strictly paired with "plugin.json" in:readme,
  // with a 90-day pushed shard so newly pushed 0-star plugins are never buried behind 5,800+ older repos)
  queries.push({
    id: `Q2-readme-plugin-json:pushed>=${recent90dCutoff}`,
    query: `"antigravity" "plugin.json" in:readme archived:false pushed:>=${recent90dCutoff}`,
    sort: 'updated',
    perPage: 100,
    maxPages: 2,
  });
  queries.push({
    id: `Q2-readme-plugin-json:pushed<${recent90dCutoff}`,
    query: `"antigravity" "plugin.json" in:readme archived:false pushed:<${recent90dCutoff}`,
    sort: 'updated',
    perPage: 100,
    maxPages: 1,
  });
  queries.push({
    id: 'Q2-topic-antigravity-qualified',
    query: 'topic:antigravity "plugin.json" in:readme archived:false',
    sort: 'updated',
    perPage: 100,
    maxPages: 2,
  });
  queries.push({
    id: 'Q2-topic-google-antigravity-qualified',
    query: 'topic:google-antigravity "plugin.json" in:readme archived:false',
    sort: 'updated',
    perPage: 100,
    maxPages: 2,
  });

  // High-SNR Antigravity component README queries for pure `git push` repositories
  // without manual GitHub Topics or literal "plugin.json" mentions in README.
  // Note: GitHub Repo Search treats `in:` globally (trailing `in:readme` overrides `in:name`)
  // and returns 0 for parenthesized `(...) in:readme` OR groups, so each component archetype
  // uses flat quoted phrases scoped to `in:readme` with a recent 90-day pushed window.
  queries.push({
    id: 'Q2-readme-antigravity-sidecar',
    query: '"antigravity" "sidecar.json" in:readme archived:false',
    sort: 'updated',
    perPage: 100,
    maxPages: 3,
  });
  queries.push({
    id: `Q2-readme-antigravity-mcp-rules:pushed>=${recent90dCutoff}`,
    query: `"antigravity" "mcp_config.json" "rules/AGENTS.md" in:readme archived:false pushed:>=${recent90dCutoff}`,
    sort: 'updated',
    perPage: 100,
    maxPages: 2,
  });
  queries.push({
    id: `Q2-readme-antigravity-mcp-plugins-dir:pushed>=${recent90dCutoff}`,
    query: `"antigravity" "mcp_config.json" ".gemini/config/plugins" in:readme archived:false pushed:>=${recent90dCutoff}`,
    sort: 'updated',
    perPage: 100,
    maxPages: 2,
  });

  return queries;
}

/**
 * Unsharded base Repo Search arms for `AdaptiveRangeSlicer` + `DiscountedUcb1Cost`.
 * Date/star/size partitioning is managed dynamically by `AdaptiveRangeSlicer`.
 */
export const CHANNEL_A_ADAPTIVE_BASE_QUERIES = Object.freeze([
  { id: 'Q1-topic-singular', baseQuery: 'topic:antigravity-plugin archived:false', maxUnits: 6 },
  { id: 'Q1-topic-plural', baseQuery: 'topic:antigravity-plugins archived:false', maxUnits: 4 },
  { id: 'Q2-name-singular', baseQuery: 'antigravity-plugin in:name archived:false', maxUnits: 6 },
  { id: 'Q2-name-plural', baseQuery: 'antigravity-plugins in:name archived:false', maxUnits: 4 },
  { id: 'Q2-name-agy-prefix', baseQuery: 'agy- in:name antigravity archived:false', maxUnits: 4 },
  { id: 'Q2-readme-plugin-json', baseQuery: '"antigravity" "plugin.json" in:readme archived:false', maxUnits: 5 },
  { id: 'Q2-topic-antigravity-qualified', baseQuery: 'topic:antigravity "plugin.json" in:readme archived:false', maxUnits: 4 },
  { id: 'Q2-topic-google-antigravity-qualified', baseQuery: 'topic:google-antigravity "plugin.json" in:readme archived:false', maxUnits: 4 },
  { id: 'Q2-readme-antigravity-sidecar', baseQuery: '"antigravity" "sidecar.json" in:readme archived:false', maxUnits: 4 },
  { id: 'Q2-readme-antigravity-mcp-rules', baseQuery: '"antigravity" "mcp_config.json" "rules/AGENTS.md" in:readme archived:false', maxUnits: 3 },
  { id: 'Q2-readme-antigravity-mcp-plugins-dir', baseQuery: '"antigravity" "mcp_config.json" ".gemini/config/plugins" in:readme archived:false', maxUnits: 3 },
]);

export function loadAggregatorsConfig(repoRoot) {
  const filePath = join(repoRoot, 'data', 'aggregators.json');
  if (!existsSync(filePath)) return [];
  const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.aggregators)) {
    throw new Error('ERR_AGGREGATORS_CONFIG: data/aggregators.json must declare schemaVersion=1 and aggregators[]');
  }
  return parsed.aggregators
    .filter((a) => a && a.enabled !== false && typeof a.repo === 'string' && OWNER_REPO_SHORTHAND_RE.test(a.repo.trim()))
    .map((a) => ({
      id: String(a.id || a.repo.toLowerCase().replace('/', '__')),
      repo: a.repo.trim(),
      kind: String(a.kind || 'awesome-list'),
      files: Array.isArray(a.files) ? a.files.filter((f) => typeof f === 'string' && f.trim()) : [],
      subdirGlobs: Array.isArray(a.subdirGlobs) ? a.subdirGlobs.filter((g) => typeof g === 'string' && g.trim()) : [],
      maxPlugins: Number.isFinite(Number(a.maxPlugins)) && Number(a.maxPlugins) > 0
        ? Math.floor(Number(a.maxPlugins))
        : DEFAULT_MAX_PLUGINS_PER_REPO,
      scanSubdirs: Boolean(a.scanSubdirs || a.kind === 'monorepo'),
    }));
}

function normalizeManifestTailToPluginRoot(safeSubpath, mode) {
  const norm = normalizeRelPosix(safeSubpath);
  if (norm === 'plugin.json' || norm === '.antigravity-plugin/plugin.json' || norm === 'agy-market.json') {
    return '.';
  }
  if (norm.endsWith('/.antigravity-plugin/plugin.json')) {
    return normalizeRelPosix(norm.slice(0, -'/.antigravity-plugin/plugin.json'.length));
  }
  if (norm.endsWith('/plugin.json')) {
    return normalizeRelPosix(norm.slice(0, -'/plugin.json'.length));
  }
  if (norm.endsWith('/agy-market.json')) {
    return normalizeRelPosix(norm.slice(0, -'/agy-market.json'.length));
  }
  if (/^sidecars\/[^/]+\/sidecar\.json$/.test(norm)) {
    return '.';
  }
  const nestedSidecar = /^(.+)\/sidecars\/[^/]+\/sidecar\.json$/.exec(norm);
  if (nestedSidecar) {
    return normalizeRelPosix(nestedSidecar[1]);
  }
  if (mode === 'blob') {
    // Non-manifest blob links (e.g. /blob/main/README.md) still reference the repo without a bogus pluginRoot
    return null;
  }
  return norm;
}

/**
 * Strict GitHub repository URL parser & SSRF/traversal filter.
 * Only permits `https://github.com/<owner>/<repo>[/(tree|blob)/<ref>/<safe-subpath>]`.
 */
export function parseSafeGitHubCandidateUrl(rawUrl, { allowFirstParty = false } = {}) {
  if (typeof rawUrl !== 'string') return null;
  const cleaned = rawUrl
    .trim()
    .replace(/^[<("'`]+/, '')
    .replace(/[)>\].,;'"`]+$/, '');
  if (!cleaned.startsWith('https://github.com/')) return null;

  let u;
  try {
    u = new URL(cleaned);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'github.com') return null;
  if (u.username || u.password || u.port) return null;

  const segments = u.pathname.split('/').filter(Boolean);
  if (segments.length < 2) return null;

  const owner = segments[0];
  let repo = segments[1].replace(/\.git$/i, '');
  if (!GITHUB_OWNER_RE.test(owner) || !GITHUB_REPO_RE.test(repo) || repo === '.' || repo === '..') {
    return null;
  }
  const ownerLower = owner.toLowerCase();
  if (GITHUB_NON_REPO_OWNERS.has(ownerLower)) return null;
  if (!allowFirstParty && FIRST_PARTY_REPO_OWNERS.has(ownerLower)) return null;

  const fullName = `${owner}/${repo}`;
  if (segments.length === 2) {
    return { owner, repo, fullName, explicitSubpath: null };
  }

  const subKind = segments[2].toLowerCase();
  if (GITHUB_NON_CODE_SUBPATHS.has(subKind)) return null;

  if (subKind === 'tree' || subKind === 'blob') {
    if (segments.length <= 4) {
      return { owner, repo, fullName, explicitSubpath: null };
    }
    let decodedParts;
    try {
      decodedParts = segments.slice(4).map((s) => decodeURIComponent(s));
    } catch {
      return null;
    }
    let safeSub;
    try {
      safeSub = validateSafeArchivePath(decodedParts.join('/'));
    } catch {
      return null;
    }
    if (!safeSub) {
      return { owner, repo, fullName, explicitSubpath: null };
    }
    const explicitSubpath = normalizeManifestTailToPluginRoot(safeSub, subKind);
    return { owner, repo, fullName, explicitSubpath };
  }

  return null;
}

function addExtractedCandidate(map, parsed, { sourceRepoLower = '', maxCandidates = MAX_CANDIDATES_PER_AGGREGATOR } = {}) {
  if (!parsed) return;
  const key = parsed.fullName.toLowerCase();
  if (sourceRepoLower && key === sourceRepoLower && !parsed.explicitSubpath) {
    return;
  }
  if (!map.has(key)) {
    if (map.size >= maxCandidates) return;
    map.set(key, {
      fullName: parsed.fullName,
      explicitSubpaths: new Set(),
    });
  }
  if (parsed.explicitSubpath) {
    map.get(key).explicitSubpaths.add(parsed.explicitSubpath);
  }
}

export function extractGitHubCandidatesFromMarkdown(
  mdText,
  { sourceRepo = '', maxCandidates = MAX_CANDIDATES_PER_AGGREGATOR } = {},
) {
  const sourceRepoLower = String(sourceRepo || '').toLowerCase();
  const candidates = new Map();
  const text = String(mdText || '');
  const urlRe = /https:\/\/github\.com\/[^\s<>()"'`[\]]+/gi;
  let match;
  while ((match = urlRe.exec(text)) !== null) {
    const parsed = parseSafeGitHubCandidateUrl(match[0]);
    addExtractedCandidate(candidates, parsed, { sourceRepoLower, maxCandidates });
  }
  return [...candidates.values()].map((c) => ({
    fullName: c.fullName,
    explicitSubpaths: [...c.explicitSubpaths].sort(),
  }));
}

export function extractGitHubCandidatesFromJson(
  jsonObj,
  { sourceRepo = '', maxCandidates = MAX_CANDIDATES_PER_AGGREGATOR } = {},
) {
  const sourceRepoLower = String(sourceRepo || '').toLowerCase();
  const candidates = new Map();
  const localSubpaths = new Set();

  const visit = (node, keyName = '') => {
    if (typeof node === 'string') {
      const trimmed = node.trim();
      if (!trimmed) return;
      if (trimmed.includes('https://github.com/')) {
        const urlRe = /https:\/\/github\.com\/[^\s<>()"'`[\]]+/gi;
        let match;
        while ((match = urlRe.exec(trimmed)) !== null) {
          addExtractedCandidate(candidates, parseSafeGitHubCandidateUrl(match[0]), { sourceRepoLower, maxCandidates });
        }
      } else if ((keyName === 'repo' || keyName === 'repository') && OWNER_REPO_SHORTHAND_RE.test(trimmed)) {
        addExtractedCandidate(candidates, parseSafeGitHubCandidateUrl(`https://github.com/${trimmed}`), {
          sourceRepoLower,
          maxCandidates,
        });
      } else if (
        sourceRepo &&
        (keyName === 'pluginRoot' || keyName === 'path' || keyName === 'dir' || keyName === 'directory' || keyName === 'source') &&
        !/^(?:https?:|\/|[A-Za-z]:)/.test(trimmed)
      ) {
        try {
          const safe = validateSafeArchivePath(trimmed);
          const norm = normalizeManifestTailToPluginRoot(safe, 'tree');
          if (norm && norm !== '.') {
            localSubpaths.add(norm);
          }
        } catch {
          /* ignore unsafe relative path */
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, keyName);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        visit(v, k);
      }
    }
  };

  visit(jsonObj, '');

  const out = [...candidates.values()].map((c) => ({
    fullName: c.fullName,
    explicitSubpaths: [...c.explicitSubpaths].sort(),
  }));
  if (sourceRepo && localSubpaths.size > 0) {
    out.push({
      fullName: sourceRepo,
      explicitSubpaths: [...localSubpaths].sort(),
    });
  }
  return out;
}

export function isExcludedScanPath(relDir) {
  const norm = normalizeRelPosix(relDir);
  if (norm === '.') return false;
  const segs = norm.split('/');
  return segs.some((seg) => EXCLUDED_SCAN_DIR_SEGMENTS.has(seg.toLowerCase()));
}

export function deriveExplicitSubpathFromCodePath(itemPath) {
  if (typeof itemPath !== 'string' || !itemPath.trim()) return null;
  let safe;
  try {
    safe = validateSafeArchivePath(itemPath.trim());
  } catch {
    return null;
  }
  const root = normalizeManifestTailToPluginRoot(safe, 'blob');
  if (!root) return null;
  if (root !== '.' && isExcludedScanPath(root)) return null;
  return root;
}

function globToRegex(globPattern) {
  const norm = normalizeRelPosix(globPattern);
  const escaped = norm.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]+');
  return new RegExp(`^${escaped}$`);
}

function isStandardMonorepoSubpath(relDir) {
  return /^(?:plugins|packages|extensions|\.agents\/plugins|\.agent\/plugins)\/[^/]+(?:\/[^/]+)?$/i.test(relDir);
}

/**
 * Discovers all candidate `pluginRoot` paths inside an already-unpacked tarball (`tarInfo.files`),
 * covering all 4 real-world layouts:
 *   1. Root `plugin.json` and `.antigravity-plugin/plugin.json` (kept as `pluginRoot: "."`)
 *   2. `.agents/plugins/<name>/plugin.json` & `.agent/plugins/<name>/plugin.json`
 *   3. `plugins/<name>/plugin.json`, `packages/<name>/plugin.json`, `extensions/<name>/plugin.json`
 *   4. Named single subdir (`agy-capsule/plugin.json`) or flat multi-subdir (`<name>/plugin.json`) at depth 1..4
 */
export function discoverPluginRootsInArchive(
  filesMap,
  { explicitSubpaths = [], subdirGlobs = [], isMonorepo = false, maxPlugins = DEFAULT_MAX_PLUGINS_PER_REPO } = {},
) {
  const foundRoots = new Set();
  for (const relPath of filesMap.keys()) {
    if (relPath === 'plugin.json' || relPath === '.antigravity-plugin/plugin.json') {
      foundRoots.add('.');
    } else if (relPath.endsWith('/.antigravity-plugin/plugin.json')) {
      const dir = normalizeRelPosix(relPath.slice(0, -'/.antigravity-plugin/plugin.json'.length));
      if (dir && dir !== '.') foundRoots.add(dir);
    } else if (relPath.endsWith('/plugin.json')) {
      const dir = normalizeRelPosix(relPath.slice(0, -'/plugin.json'.length));
      if (dir && dir !== '.') foundRoots.add(dir);
    }
  }

  const explicitSet = new Set(
    (explicitSubpaths || []).map((p) => normalizeRelPosix(p)).filter((p) => p && !isExcludedScanPath(p)),
  );
  const globRegexes = (subdirGlobs || []).map((g) => globToRegex(g));

  const hasRoot = foundRoots.has('.');
  const nestedValid = [];
  for (const dir of foundRoots) {
    if (dir === '.') continue;
    const depth = dir.split('/').length;
    if (depth < 1 || depth > 4) continue;
    if (isExcludedScanPath(dir)) continue;
    nestedValid.push(dir);
  }
  nestedValid.sort((a, b) => a.localeCompare(b));

  const selected = [];
  if (!hasRoot) {
    if (globRegexes.length > 0) {
      const globMatched = nestedValid.filter((d) => explicitSet.has(d) || globRegexes.some((re) => re.test(d)));
      selected.push(...(globMatched.length > 0 ? globMatched : nestedValid));
    } else {
      selected.push(...nestedValid);
    }
  } else {
    selected.push('.');
    for (const dir of nestedValid) {
      const matchesGlob = globRegexes.some((re) => re.test(dir));
      const isExplicit = explicitSet.has(dir);
      const isStandard = isStandardMonorepoSubpath(dir);
      if (isMonorepo) {
        if (globRegexes.length > 0 ? matchesGlob || isExplicit : isStandard || isExplicit) {
          selected.push(dir);
        }
      } else if (isExplicit || isStandard) {
        selected.push(dir);
      }
    }
  }

  const uniqueSelected = [...new Set(selected)];
  const pruned = pruneNestedCandidateRoots(uniqueSelected, filesMap, { isMonorepo });

  // Preserve real non-placeholder `templates/plugin/<name>` roots (e.g., `anksarvesh-lgtm/agent-guard`)
  // ONLY when no non-template plugin roots exist in the repo; placeholder stubs are rejected downstream
  // by `scoreAntigravityAuthenticity`.
  const finalRoots =
    pruned.length > 0
      ? pruned
      : uniqueSelected.filter(
          (dir) =>
            /^templates\/plugin\/[^/]+$/i.test(dir) &&
            !/__name__|\{\{[^}]+\}\}|starter-plugin|example-plugin|default-bundle|template-plugin/i.test(dir),
        );

  return finalRoots.slice(0, Math.max(1, maxPlugins));
}

export function normalizeSubpathSlug(pluginRoot) {
  const norm = normalizeRelPosix(pluginRoot);
  if (norm === '.') return '';
  const cleaned = norm
    .split('/')
    .map((seg) => seg.replace(/^\.+/, ''))
    .filter(Boolean)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/__+/g, '-')
    .replace(/--+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned || 'subplugin';
}

export function buildTrack2EntryIdentity({
  ownerLogin,
  repoName,
  pluginRoot = '.',
  manifestName,
  totalValidRootsInRepo = 1,
  usedScopedNames = null,
}) {
  const normRoot = normalizeRelPosix(pluginRoot);
  const ownerLower = String(ownerLogin || 'community').toLowerCase();
  const repoLower = String(repoName || manifestName || 'plugin').toLowerCase();
  const subpathSlug = normalizeSubpathSlug(normRoot);

  const isSingleMatchingSubdir =
    normRoot !== '.' &&
    totalValidRootsInRepo === 1 &&
    (normRoot.toLowerCase() === repoLower || subpathSlug === repoLower);

  const entryId =
    normRoot === '.' || isSingleMatchingSubdir
      ? `${ownerLower}__${repoLower}`
      : `${ownerLower}__${repoLower}--${subpathSlug}`;

  const rawBaseSlug = String(manifestName || repoLower).includes('--')
    ? String(manifestName).split('--').pop()
    : String(manifestName || repoLower);

  let scopedName = toScopedPluginName(ownerLogin, rawBaseSlug);
  if (usedScopedNames && usedScopedNames.has(scopedName) && subpathSlug) {
    scopedName = toScopedPluginName(ownerLogin, `${subpathSlug}-${rawBaseSlug}`);
  }
  if (usedScopedNames) {
    usedScopedNames.add(scopedName);
  }

  return {
    id: entryId,
    pluginRoot: normRoot,
    subpathSlug,
    canonicalName: rawBaseSlug,
    scopedName,
  };
}

/**
 * Selects a universal (cross-platform) `.tar.gz`/`.tgz` release asset if present,
 * intentionally skipping single-platform binary packages (e.g. `*-aarch64-apple-darwin.tar.gz`).
 */
export function selectReleaseTarballAsset(assets = []) {
  if (!Array.isArray(assets)) return null;
  const tarAssets = assets.filter(
    (a) => a && typeof a.name === 'string' && /\.(?:tar\.gz|tgz)$/i.test(a.name) && typeof a.browser_download_url === 'string',
  );
  if (tarAssets.length === 0) return null;
  const universal = tarAssets.find((a) => !PLATFORM_SPECIFIC_ASSET_RE.test(a.name));
  return universal || null;
}

/**
 * Synthesizes a monotonic SemVer string for Channel C tagless default-branch snapshots:
 * `<baseVer>-git.<YYYYMMDDHHmmss>.<short7>`
 */
export function synthesizeGitCommitVersion(manifestVersion, commitDateIso, commitSha) {
  let baseVer = '0.0.0';
  const parsed = parseSemver(manifestVersion);
  if (parsed) {
    baseVer = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  } else {
    const twoPart = /^v?(\d+)\.(\d+)$/i.exec(String(manifestVersion || '').trim());
    if (twoPart) {
      baseVer = `${Number(twoPart[1])}.${Number(twoPart[2])}.0`;
    }
  }
  const tsDate = commitDateIso && !Number.isNaN(Date.parse(commitDateIso)) ? new Date(commitDateIso) : new Date();
  const pad2 = (n) => String(n).padStart(2, '0');
  const ts14 =
    `${tsDate.getUTCFullYear()}${pad2(tsDate.getUTCMonth() + 1)}${pad2(tsDate.getUTCDate())}` +
    `${pad2(tsDate.getUTCHours())}${pad2(tsDate.getUTCMinutes())}${pad2(tsDate.getUTCSeconds())}`;
  const short7 = String(commitSha || '0000000').toLowerCase().slice(0, 7);
  return `${baseVer}-git.${ts14}.${short7}`;
}

/**
 * Pure parser for Git Smart-HTTP `info/refs?service=git-upload-pack` response.
 * Extracts `headSha`, `defaultBranch`, `branches`, and `tags` (with `^{}` peeled commit SHAs preferred).
 */
export function parseGitUploadPackRefs(rawText) {
  const text = String(rawText || '');
  const branches = new Map();
  const tags = new Map();
  const peeledTags = new Map();
  let headSha = null;
  let defaultBranch = 'main';

  let pos = 0;
  const lines = [];
  while (pos + 4 <= text.length) {
    const hexLen = text.slice(pos, pos + 4);
    if (!/^[0-9a-f]{4}$/i.test(hexLen)) {
      // Fallback for plain line-delimited mock text
      lines.push(...text.slice(pos).split(/\r?\n/));
      break;
    }
    const len = parseInt(hexLen, 16);
    if (len === 0) {
      pos += 4;
      continue;
    }
    if (len < 4 || pos + len > text.length) break;
    lines.push(text.slice(pos + 4, pos + len).replace(/\r?\n$/, ''));
    pos += len;
  }

  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const nulIdx = line.indexOf('\0');
    const mainPart = nulIdx === -1 ? line : line.slice(0, nulIdx);
    const capsPart = nulIdx === -1 ? '' : line.slice(nulIdx + 1);

    const m = /^([0-9a-f]{40})\s+(\S+)$/i.exec(mainPart.trim());
    if (!m) continue;
    const sha = m[1].toLowerCase();
    const ref = m[2];

    if (ref === 'HEAD') {
      headSha = sha;
      const sym = /symref=HEAD:refs\/heads\/([^\s]+)/.exec(capsPart);
      if (sym) defaultBranch = sym[1];
    } else if (ref.startsWith('refs/heads/')) {
      branches.set(ref.slice('refs/heads/'.length), sha);
    } else if (ref.startsWith('refs/tags/')) {
      const tagRaw = ref.slice('refs/tags/'.length);
      if (tagRaw.endsWith('^{}')) {
        peeledTags.set(tagRaw.slice(0, -3), sha);
      } else {
        tags.set(tagRaw, sha);
      }
    }
  }

  for (const [tagName, peeledSha] of peeledTags.entries()) {
    tags.set(tagName, peeledSha);
  }
  if (!headSha && branches.has(defaultBranch)) {
    headSha = branches.get(defaultBranch);
  }
  if (!headSha && branches.size > 0) {
    const [firstBranch, firstSha] = branches.entries().next().value;
    defaultBranch = firstBranch;
    headSha = firstSha;
  }

  return { headSha, defaultBranch, branches, tags };
}

export function parseGitHubAtomLatestUpdated(atomXml) {
  const xml = String(atomXml || '');
  const entryMatch = /<entry\b[\s\S]*?<updated>([^<]+)<\/updated>/i.exec(xml);
  const candidate = entryMatch ? entryMatch[1].trim() : '';
  if (candidate && !Number.isNaN(Date.parse(candidate))) {
    return new Date(candidate).toISOString();
  }
  const feedMatch = /<updated>([^<]+)<\/updated>/i.exec(xml);
  if (feedMatch && !Number.isNaN(Date.parse(feedMatch[1].trim()))) {
    return new Date(feedMatch[1].trim()).toISOString();
  }
  return null;
}

export function parseGitHubRepoHtmlMeta(htmlText, fullName) {
  const html = String(htmlText || '');
  const repoIdMatch = /<meta\s+name="octolytics-dimension-repository_id"\s+content="(\d+)"/i.exec(html);
  const userIdMatch = /<meta\s+name="octolytics-dimension-user_id"\s+content="(\d+)"/i.exec(html);
  const descMatch = /<meta\s+name="description"\s+content="([^"]*)"/i.exec(html);
  const archived = /This repository has been archived by the owner/i.test(html);
  const [ownerLogin, repoName] = String(fullName || '').split('/');
  const rawDesc = descMatch
    ? descMatch[1]
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
        .replace(/\s*-\s*Contribute to [^\s]+ development by creating an account on GitHub\.?$/i, '')
        .trim()
    : '';
  return {
    id: repoIdMatch ? Number(repoIdMatch[1]) : 0,
    name: repoName || '',
    full_name: fullName,
    html_url: `https://github.com/${fullName}`,
    description: rawDesc,
    archived,
    disabled: false,
    stargazers_count: 0,
    owner: {
      id: userIdMatch ? Number(userIdMatch[1]) : 0,
      login: ownerLogin || 'community',
    },
    topics: [],
  };
}

export async function fetchWithLimit(
  url,
  {
    headers = {},
    timeoutMs = AGGREGATOR_FETCH_TIMEOUT_MS,
    stallTimeoutMs = 0,
    maxBytes = MAX_AGGREGATOR_DOC_BYTES,
    method = 'GET',
    redirect = 'follow',
    fetchImpl = fetch,
  } = {},
) {
  const hasMaxBytes = Number.isFinite(maxBytes) && maxBytes > 0;
  const useStall = Number.isFinite(stallTimeoutMs) && stallTimeoutMs > 0;
  const controller = new AbortController();
  let timer = null;
  const resetTimer = (ms) => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (Number.isFinite(ms) && ms > 0) {
      timer = setTimeout(
        () => controller.abort(new Error(`ERR_TIMEOUT: Request timed out after ${ms}ms (${url})`)),
        ms,
      );
    }
  };
  resetTimer(useStall ? stallTimeoutMs : timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method,
      headers,
      redirect,
      signal: controller.signal,
    });
    if (method === 'HEAD') {
      return { ok: res.ok, status: res.status, headers: res.headers, url: res.url, buffer: Buffer.alloc(0) };
    }
    const contentLen = Number(res.headers.get('content-length') || 0);
    if (hasMaxBytes && contentLen > maxBytes) {
      throw new Error(`ERR_RESPONSE_TOO_LARGE: Content-Length ${contentLen} exceeds ${maxBytes} for ${url}`);
    }
    if (!res.body) {
      if (useStall) {
        resetTimer(Math.max(stallTimeoutMs, 300_000));
      }
      const ab = await res.arrayBuffer();
      const buf = Buffer.from(ab);
      if (hasMaxBytes && buf.length > maxBytes) {
        throw new Error(`ERR_RESPONSE_TOO_LARGE: Body size ${buf.length} exceeds ${maxBytes} for ${url}`);
      }
      return { ok: res.ok, status: res.status, headers: res.headers, url: res.url, buffer: buf };
    }
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    let abortReject = null;
    const abortPromise = new Promise((_, reject) => {
      abortReject = reject;
    });
    abortPromise.catch(() => {});
    const onAbort = () => {
      const reason =
        controller.signal.reason ||
        new Error(`ERR_TIMEOUT: Download stalled for ${useStall ? stallTimeoutMs : timeoutMs}ms (${url})`);
      abortReject(reason instanceof Error ? reason : new Error(String(reason)));
    };
    if (controller.signal.aborted) {
      onAbort();
    } else {
      controller.signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      while (true) {
        if (useStall) resetTimer(stallTimeoutMs);
        const { done, value } = await Promise.race([reader.read(), abortPromise]);
        if (controller.signal.aborted) {
          const reason =
            controller.signal.reason ||
            new Error(`ERR_TIMEOUT: Download stalled for ${useStall ? stallTimeoutMs : timeoutMs}ms (${url})`);
          throw reason instanceof Error ? reason : new Error(String(reason));
        }
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (hasMaxBytes && total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error(`ERR_RESPONSE_TOO_LARGE: Stream size exceeds ${maxBytes} for ${url}`);
        }
        chunks.push(chunk);
      }
    } catch (err) {
      await reader.cancel().catch(() => {});
      throw err;
    } finally {
      controller.signal.removeEventListener('abort', onAbort);
    }
    return {
      ok: res.ok,
      status: res.status,
      headers: res.headers,
      url: res.url,
      buffer: Buffer.concat(chunks, total),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function pickHighestStableSemverTag(tagNames = []) {
  const stable = [];
  for (const name of tagNames) {
    const parsed = parseSemver(name);
    if (!parsed || parsed.prerelease.length > 0) continue;
    stable.push(name);
  }
  if (stable.length === 0) return null;
  stable.sort((a, b) => compareSemver(b, a));
  return stable[0];
}

/**
 * Zero-REST-API-quota repository snapshot resolver:
 * Uses `HEAD /releases/latest` + `GET /info/refs?service=git-upload-pack` (+ optional `.atom` timestamp).
 */
export async function resolveRepoSnapshotZeroQuota(
  fullName,
  { fetchImpl = fetch, userAgent = 'agy-market-topic-crawler/1.4', preferFullRepoArchive = false } = {},
) {
  let canonicalFullName = fullName;
  let latestReleaseTag = null;

  const headRes = await fetchWithLimit(`https://github.com/${canonicalFullName}/releases/latest`, {
    method: 'HEAD',
    redirect: 'manual',
    timeoutMs: AGGREGATOR_FETCH_TIMEOUT_MS,
    headers: { 'User-Agent': userAgent },
    fetchImpl,
  });

  if (headRes.status === 404) {
    throw new Error(`ERR_REPO_NOT_FOUND: Repository "${fullName}" returned HTTP 404`);
  }
  if (headRes.status >= 300 && headRes.status < 400) {
    const loc = headRes.headers.get('location') || '';
    const tagMatch = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/tag\/([^/?#]+)/i.exec(loc);
    if (tagMatch) {
      canonicalFullName = tagMatch[1];
      latestReleaseTag = decodeURIComponent(tagMatch[2]);
    } else {
      const repoRedirectMatch = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/?$/i.exec(loc);
      if (repoRedirectMatch) {
        canonicalFullName = repoRedirectMatch[1];
      }
    }
  }

  const refsRes = await fetchWithLimit(
    `https://github.com/${canonicalFullName}.git/info/refs?service=git-upload-pack`,
    {
      timeoutMs: AGGREGATOR_FETCH_TIMEOUT_MS,
      maxBytes: MAX_AGGREGATOR_DOC_BYTES,
      headers: { 'User-Agent': 'git/2.43.0' },
      fetchImpl,
    },
  );

  if (refsRes.status === 401 || refsRes.status === 403 || refsRes.status === 404) {
    throw new Error(`ERR_REPO_NOT_FOUND: Git refs unavailable for "${canonicalFullName}" (HTTP ${refsRes.status})`);
  }
  if (!refsRes.ok) {
    throw new Error(`ERR_TRANSIENT_HTTP: Git info/refs HTTP ${refsRes.status} for "${canonicalFullName}"`);
  }

  const refs = parseGitUploadPackRefs(refsRes.buffer.toString('utf8'));
  const useReleaseTag =
    latestReleaseTag &&
    refs.tags.has(latestReleaseTag) &&
    (!preferFullRepoArchive || Boolean(parseSemver(latestReleaseTag)));

  if (useReleaseTag) {
    const commitSha = refs.tags.get(latestReleaseTag);
    return {
      fullName: canonicalFullName,
      defaultBranch: refs.defaultBranch,
      tier: 'release',
      tagName: latestReleaseTag,
      commitSha,
      tarballUrl: buildSourceArchiveUrl(canonicalFullName, commitSha, latestReleaseTag),
      publishedAt: null,
      requireSelfContained: true,
    };
  }

  const bestSemverTag = pickHighestStableSemverTag([...refs.tags.keys()]);
  if (bestSemverTag && refs.tags.has(bestSemverTag)) {
    const commitSha = refs.tags.get(bestSemverTag);
    return {
      fullName: canonicalFullName,
      defaultBranch: refs.defaultBranch,
      tier: 'tag',
      tagName: bestSemverTag,
      commitSha,
      tarballUrl: buildSourceArchiveUrl(canonicalFullName, commitSha, bestSemverTag),
      publishedAt: null,
      requireSelfContained: true,
    };
  }

  if (!refs.headSha || !COMMIT_SHA_RE.test(refs.headSha)) {
    throw new Error(`ERR_EMPTY_REPOSITORY: No commit HEAD found for "${canonicalFullName}"`);
  }

  let publishedAt = null;
  try {
    const atomRes = await fetchWithLimit(
      `https://github.com/${canonicalFullName}/commits/${encodeURIComponent(refs.defaultBranch)}.atom`,
      {
        timeoutMs: 8_000,
        maxBytes: 512 * 1024,
        headers: { 'User-Agent': userAgent },
        fetchImpl,
      },
    );
    if (atomRes.ok) {
      publishedAt = parseGitHubAtomLatestUpdated(atomRes.buffer.toString('utf8'));
    }
  } catch {
    /* fail-open on atom timestamp */
  }

  return {
    fullName: canonicalFullName,
    defaultBranch: refs.defaultBranch,
    tier: 'commit',
    tagName: null,
    commitSha: refs.headSha,
    tarballUrl: `https://github.com/${canonicalFullName}/archive/${refs.headSha}.tar.gz`,
    publishedAt: publishedAt || new Date().toISOString(),
    requireSelfContained: true,
  };
}

/**
 * Fetches an aggregator document (README.md, data/tools.json, registry.json, etc.)
 * via commit-pinned `raw.githubusercontent.com` (zero REST API quota!) with 2 MB / 15s hard caps.
 */
export async function fetchAggregatorCandidates(
  aggregator,
  { fetchImpl = fetch, userAgent = 'agy-market-topic-crawler/1.4' } = {},
) {
  const results = new Map();
  let headSha = null;
  let defaultBranch = 'main';

  try {
    const refsRes = await fetchWithLimit(
      `https://github.com/${aggregator.repo}.git/info/refs?service=git-upload-pack`,
      {
        timeoutMs: AGGREGATOR_FETCH_TIMEOUT_MS,
        maxBytes: MAX_AGGREGATOR_DOC_BYTES,
        headers: { 'User-Agent': 'git/2.43.0' },
        fetchImpl,
      },
    );
    if (refsRes.ok) {
      const parsedRefs = parseGitUploadPackRefs(refsRes.buffer.toString('utf8'));
      headSha = parsedRefs.headSha;
      defaultBranch = parsedRefs.defaultBranch || 'main';
    }
  } catch {
    /* fallback to default branch name */
  }

  const refPin = headSha || defaultBranch;

  for (const relFile of aggregator.files || []) {
    const safeFile = normalizeRelPosix(relFile);
    if (!safeFile || safeFile === '.' || safeFile.includes('..') || safeFile.startsWith('/')) continue;
    const rawUrl = `https://raw.githubusercontent.com/${aggregator.repo}/${encodeURIComponent(refPin)}/${safeFile}`;
    try {
      const docRes = await fetchWithLimit(rawUrl, {
        timeoutMs: AGGREGATOR_FETCH_TIMEOUT_MS,
        maxBytes: MAX_AGGREGATOR_DOC_BYTES,
        headers: { 'User-Agent': userAgent },
        fetchImpl,
      });
      if (!docRes.ok) continue;
      const text = docRes.buffer.toString('utf8');
      let extracted = [];
      if (safeFile.toLowerCase().endsWith('.json')) {
        try {
          const parsed = JSON.parse(text);
          extracted = extractGitHubCandidatesFromJson(parsed, {
            sourceRepo: aggregator.repo,
            maxCandidates: MAX_CANDIDATES_PER_AGGREGATOR,
          });
        } catch {
          extracted = extractGitHubCandidatesFromMarkdown(text, {
            sourceRepo: aggregator.repo,
            maxCandidates: MAX_CANDIDATES_PER_AGGREGATOR,
          });
        }
      } else {
        extracted = extractGitHubCandidatesFromMarkdown(text, {
          sourceRepo: aggregator.repo,
          maxCandidates: MAX_CANDIDATES_PER_AGGREGATOR,
        });
      }

      for (const item of extracted) {
        const key = item.fullName.toLowerCase();
        if (!results.has(key)) {
          if (results.size >= MAX_CANDIDATES_PER_AGGREGATOR) break;
          results.set(key, {
            fullName: item.fullName,
            explicitSubpaths: new Set(),
          });
        }
        for (const sp of item.explicitSubpaths || []) {
          results.get(key).explicitSubpaths.add(sp);
        }
      }
    } catch {
      /* individual doc fail-open */
    }
  }

  return {
    aggregatorId: aggregator.id,
    repo: aggregator.repo,
    headSha,
    defaultBranch,
    candidates: [...results.values()].map((c) => ({
      fullName: c.fullName,
      explicitSubpaths: [...c.explicitSubpaths].sort(),
    })),
  };
}

export async function downloadTarballBuffer(
  tarballUrl,
  {
    fetchImpl = fetch,
    userAgent = 'agy-market-topic-crawler/1.4',
    maxBytes = MAX_TARBALL_BYTES,
    stallTimeoutMs = TARBALL_FETCH_TIMEOUT_MS,
  } = {},
) {
  const res = await fetchWithLimit(tarballUrl, {
    timeoutMs: stallTimeoutMs,
    stallTimeoutMs,
    maxBytes,
    headers: { 'User-Agent': userAgent },
    fetchImpl,
  });
  if (res.status === 404) {
    throw new Error(`ERR_TARBALL_NOT_FOUND: HTTP 404 downloading ${tarballUrl}`);
  }
  if (!res.ok) {
    throw new Error(`ERR_TRANSIENT_HTTP: HTTP ${res.status} downloading ${tarballUrl}`);
  }
  return res.buffer;
}
