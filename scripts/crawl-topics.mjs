#!/usr/bin/env node
// Track-2 Multi-Source + Adaptive Discovery + Two-Stage GraphQL Crawler (`scripts/crawl-topics.mjs`).
//
// Channels & Pipeline:
//   - Channel B: Declarative `data/aggregators.json` + auto-promoted `state/discovered-aggregators.json`
//                (zero REST API quota!) + all-4-layout archive scanning with Trie pruning.
//   - Channel A: AdaptiveRangeSlicer + DiscountedUcb1Cost Repo Search + concurrent CodeSearchPacer
//                (with validated flat fingerprints & `<=250` char `-repo:` exclusions) +
//                Author-centric GraphQL snowball (`E_author`), 1-hop README link frontier,
//                npm Search bridge (0 GitHub quota), and Topic co-occurrence auto-arm miner.
//   - Stage 2A/2B GraphQL: Batch heartbeat (`B=50`), novel structural triage (`B=20`, 99.1% recall),
//                and batch snapshot inspection (`B=20`), with seamless REST / zero-quota fallback.
//   - Downstream: Scoped symlink safety (`minClientVersion: "1.6.0"`), calibrated Authenticity Scorer,
//                3-Layer Dedup Engine (`state/fingerprints.json`), Taxonomy v2 + bilingual summary
//                extraction, Neg-Cache v2 activity-aware backoff, decoupled retention (ZERO silent
//                evictions!), and storage split (per-plugin `dist/readmes/<id>.json`).
//
// Security invariants:
//   - Zero untrusted code execution; strictly streaming/static inspection.
//   - Forces `forceScopedInstall: true` & `<owner>--<slug>` scoped isolation.
//   - Never modifies Track-1 `state/ledger.json` or `state/versions-lock.json`.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  AdaptiveRangeSlicer,
  buildCodeSearchQueryWithExclusions,
  classifyPositiveRecrawlTier,
  CodeSearchPacer,
  CURRENT_VALIDATOR_VERSION,
  DiscountedUcb1Cost,
  discoverFromNpmSearch,
  mineCooccurringTopics,
  mineReadmeFrontier,
  normalizeDiscoveryState,
  pruneNegativeCacheEntries,
  shouldSkipNegativeCache,
  updateNegativeCacheEntry,
  VALIDATED_CODE_SEARCH_QUERIES,
} from './lib/adaptive-discovery.mjs';
import { AUTHENTICITY_SCORER_VERSION } from './lib/authenticity-scorer.mjs';
import {
  buildSourceArchiveUrl,
  DEFAULT_CATALOG_BASE_URL,
  FIRST_PARTY_REPO_OWNERS,
  normalizeRelPosix,
  parseSemver,
} from './lib/constants.mjs';
import { deduplicateCatalogPlugins } from './lib/dedup-engine.mjs';
import {
  buildChannelARepoQueries,
  buildShardedDateWindows,
  buildTrack2EntryIdentity,
  CHANNEL_A_ADAPTIVE_BASE_QUERIES,
  CODE_SEARCH_DELAY_MS,
  DEFAULT_MAX_PLUGINS_PER_REPO,
  deriveExplicitSubpathFromCodePath,
  discoverPluginRootsInArchive,
  downloadTarballBuffer,
  fetchAggregatorCandidates,
  fetchWithLimit,
  loadAggregatorsConfig,
  parseGitHubRepoHtmlMeta,
  parseSafeGitHubCandidateUrl,
  pickHighestStableSemverTag,
  REPO_SEARCH_DELAY_MS,
  resolveRepoSnapshotZeroQuota,
  selectReleaseTarballAsset,
  synthesizeGitCommitVersion,
} from './lib/discovery-sources.mjs';
import {
  batchAuthorExpansion,
  batchHeartbeatStage2A,
  batchInspectStage2B,
  batchNovelStage2A,
  passesNovelStage2ATriage,
  resolveSnapshotFromStage2BNode,
  selectAuthorsForExpansion,
  toRestCompatRepoMeta,
} from './lib/graphql-batch.mjs';
import { inspectTarGzBuffer, inspectTarGzStream } from './lib/tar-stream.mjs';
import {
  CURATED_TAXONOMY_OVERRIDES,
  extractBilingualSummaryFromReadmes,
  inferPluginTaxonomy,
  TAXONOMY_VERSION,
} from './lib/taxonomy-classifier.mjs';
import { validatePluginTarball } from './validate-plugin-tarball.mjs';

export { buildShardedDateWindows };

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const USER_AGENT = 'agy-market-topic-crawler/1.6';
const EVICT_404_MIN_STRIKES = 3;
const EVICT_404_MIN_ELAPSED_MS = 72 * 3_600_000; // 72 hours

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function extractErrorCode(err) {
  const msg = String(err?.message || err || 'ERR_UNKNOWN');
  const m = /^([A-Z][A-Z0-9_]+):/.exec(msg);
  if (m) return m[1];
  if (err?.name === 'AbortError' || /abort|timeout|ETIMEDOUT/i.test(msg)) return 'ERR_TIMEOUT';
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EACCES|socket|network|TLS/i.test(msg)) {
    return 'ERR_NETWORK';
  }
  return 'ERR_UNKNOWN';
}

function isTransientErrorCode(code) {
  return (
    code === 'ERR_TRANSIENT_HTTP' ||
    code === 'ERR_TIMEOUT' ||
    code === 'ERR_NETWORK' ||
    code === 'ERR_GRAPHQL_TIMEOUT' ||
    code === 'ERR_GRAPHQL_PARTIAL' ||
    code === 'ERR_GRAPHQL_RATE_LIMITED'
  );
}

function sortRecordKeys(obj) {
  const sorted = {};
  for (const k of Object.keys(obj || {}).sort((a, b) => a.localeCompare(b))) {
    sorted[k] = obj[k];
  }
  return sorted;
}

function repoKeyFromUrl(url) {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\/|\.git)?$/i.exec(String(url || '').trim());
  return m ? m[1].toLowerCase() : '';
}

function isFirstPartyRepoMeta(repoMeta) {
  const ownerLogin = String(repoMeta?.owner?.login || '').toLowerCase();
  if (FIRST_PARTY_REPO_OWNERS.has(ownerLogin)) return true;
  if (repoMeta?.fork && repoMeta?.parent?.owner?.login) {
    if (FIRST_PARTY_REPO_OWNERS.has(String(repoMeta.parent.owner.login).toLowerCase())) {
      return true;
    }
  }
  return false;
}

function computeReadmeMeta({ readmeMarkdown = '', readmeZhMarkdown = '', readmeEnMarkdown = '' } = {}) {
  const defaultBytes = Buffer.byteLength(String(readmeMarkdown || ''), 'utf8');
  const zhBytes = Buffer.byteLength(String(readmeZhMarkdown || ''), 'utf8');
  const enBytes = Buffer.byteLength(String(readmeEnMarkdown || ''), 'utf8');
  return {
    defaultBytes,
    zhBytes,
    enBytes,
    isBilingual: zhBytes > 0 && enBytes > 0,
  };
}

function safeReadmeFilename(id) {
  return String(id || '').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function writePerPluginReadmeFile(outDir, id, { readmeMarkdown = '', readmeZhMarkdown = '', readmeEnMarkdown = '' }) {
  if (!outDir || !id) return;
  if (!readmeMarkdown && !readmeZhMarkdown && !readmeEnMarkdown) return;
  mkdirSync(outDir, { recursive: true });
  const payload = {
    id,
    default: readmeMarkdown || '',
    zh: readmeZhMarkdown || '',
    en: readmeEnMarkdown || '',
  };
  writeFileSync(join(outDir, `${safeReadmeFilename(id)}.json`), `${JSON.stringify(payload)}\n`, 'utf8');
}

function readPerPluginReadmeDir(dirPath) {
  const out = new Map();
  if (!dirPath || !existsSync(dirPath)) return out;
  for (const file of readdirSync(dirPath)) {
    if (!file.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dirPath, file), 'utf8'));
      const id = String(parsed?.id || file.slice(0, -5));
      if (!id) continue;
      out.set(id, {
        default: typeof parsed?.default === 'string' ? parsed.default : '',
        zh: typeof parsed?.zh === 'string' ? parsed.zh : '',
        en: typeof parsed?.en === 'string' ? parsed.en : '',
      });
    } catch {
      /* skip corrupt readme cache file */
    }
  }
  return out;
}

function buildForkMeta(repoMeta) {
  if (!repoMeta || !repoMeta.fork) return null;
  return {
    isFork: true,
    parentFullName: repoMeta.parent?.full_name || null,
    parentArchived: Boolean(repoMeta.parent?.archived),
    parentPushedAt: repoMeta.parent?.pushed_at || null,
  };
}

/**
 * Pure builder for a single Track-2 unverified plugin entry (backward-compatible with root & subdir plugins).
 * Always sets `forceScopedInstall: true` and `scopedName: <owner-lower>--<slug>`.
 */
export function buildTrack2PluginRecord({
  repoMeta,
  releaseInfo,
  tarballBuffer,
  tarInfo = null,
  pluginRoot = '.',
  totalValidRootsInRepo = 1,
  usedScopedNames = null,
  track1RepoIds = null,
  track1RepoRoots = null,
  track1RepoUrlRoots = null,
  discoverySources = [],
  catalogBaseUrl = process.env.AGY_MARKET_CATALOG_BASE_URL || DEFAULT_CATALOG_BASE_URL,
}) {
  if (!repoMeta) return null;
  if (repoMeta.archived || repoMeta.disabled || repoMeta.is_template) return null;
  if (isFirstPartyRepoMeta(repoMeta)) return null;

  const normRoot = normalizeRelPosix(pluginRoot);
  const repoId = Number(repoMeta.id || 0);
  const ownerLogin = String(repoMeta.owner?.login || 'community');
  const repoName = String(repoMeta.name || (repoMeta.full_name ? String(repoMeta.full_name).split('/')[1] : '') || '');
  const fullName = String(repoMeta.full_name || `${ownerLogin}/${repoName}`);
  const repoUrl = repoMeta.html_url || `https://github.com/${fullName}`;

  if (track1RepoRoots && repoId > 0 && track1RepoRoots.has(`${repoId}:${normRoot}`)) {
    return null;
  }
  if (!track1RepoRoots && track1RepoIds && repoId > 0 && track1RepoIds.has(repoId)) {
    return null;
  }
  if (track1RepoUrlRoots && track1RepoUrlRoots.has(`${fullName.toLowerCase()}:${normRoot}`)) {
    return null;
  }

  const fallbackName = normRoot === '.' ? repoName : normRoot.split('/').pop() || repoName;
  const inspected = validatePluginTarball(tarballBuffer, {
    pluginRoot: normRoot,
    allowScopedName: true,
    allowExternalSymlinks: true,
    fallbackVersion: releaseInfo?.tagName || '',
    requireSelfContained: Boolean(releaseInfo?.requireSelfContained),
    lenientManifest: true,
    requireAntigravityComponent: true,
    fallbackDescription: String(repoMeta.description || ''),
    fallbackName,
    affinityContext: {
      repoName,
      repoFullName: fullName,
      repoDescription: String(repoMeta.description || ''),
      topics: Array.isArray(repoMeta.topics) ? repoMeta.topics : [],
      licenseSpdxId: repoMeta.license?.spdx_id || null,
      isTemplate: Boolean(repoMeta.is_template),
    },
    tarInfo,
  });

  const identity = buildTrack2EntryIdentity({
    ownerLogin,
    repoName: repoName || inspected.manifest.name,
    pluginRoot: normRoot,
    manifestName: inspected.manifest.name,
    totalValidRootsInRepo,
    usedScopedNames,
  });

  const hasTag = typeof releaseInfo?.tagName === 'string' && releaseInfo.tagName.trim().length > 0;
  const gitTag = hasTag ? releaseInfo.tagName.trim() : null;
  const commitSha = String(releaseInfo?.commitSha || '');

  let version = inspected.version;
  if (!gitTag) {
    version = synthesizeGitCommitVersion(inspected.manifest.version, releaseInfo?.publishedAt, commitSha);
  } else if (!parseSemver(inspected.manifest.version) && !parseSemver(gitTag) && commitSha) {
    version = synthesizeGitCommitVersion(null, releaseInfo?.publishedAt, commitSha);
  }

  const companion = inspected.companion || {};
  const rawDesc = String(inspected.manifest.description || repoMeta.description || '').trim();
  const bilingualSummary = extractBilingualSummaryFromReadmes({
    description: rawDesc,
    readmeZh: inspected.readmeZhMarkdown,
    readmeEn: inspected.readmeEnMarkdown,
  });
  const displayName = inspected.manifest.displayName || inspected.manifest.name;
  const inferredTaxonomy = inferPluginTaxonomy({
    id: identity.id,
    canonicalName: identity.canonicalName,
    displayName,
    description: { zh: bilingualSummary.zh || rawDesc, en: bilingualSummary.en || rawDesc },
    topics: Array.isArray(repoMeta.topics) ? repoMeta.topics : [],
    capabilities: inspected.capabilities,
    existingCategories: companion.categories || [],
    existingTags: companion.tags || [],
    readmeText: inspected.readmeMarkdown || '',
    skillDescriptions: inspected.skillDescriptions || [],
  });

  const forkMeta = buildForkMeta(repoMeta);
  const sortedSources = [...new Set((discoverySources || []).filter(Boolean))].sort();

  const pluginEntry = {
    id: identity.id,
    canonicalName: identity.canonicalName,
    scopedName: identity.scopedName,
    forceScopedInstall: true,
    displayName,
    description: {
      zh: bilingualSummary.zh || rawDesc,
      en: bilingualSummary.en || rawDesc,
    },
    version,
    gitTag,
    commitSha,
    repository: {
      url: repoUrl,
      repositoryId: repoId,
      ownerId: Number(repoMeta.owner?.id || 0),
      stars: Number(repoMeta.stargazers_count || 0),
      pluginRoot: normRoot,
      ...(repoMeta.pushed_at ? { pushedAt: repoMeta.pushed_at } : {}),
      ...(repoMeta.created_at ? { createdAt: repoMeta.created_at } : {}),
      ...(repoMeta.fork ? { isFork: true } : {}),
      ...(repoMeta.parent?.full_name ? { parentFullName: repoMeta.parent.full_name } : {}),
    },
    distribution: {
      tarballUrl: releaseInfo.tarballUrl,
      sha256: inspected.sha256,
      sizeBytes: inspected.sizeBytes,
      npmMirrorPkg: null,
      preservePaths: companion.preservePaths || [],
      ...(inspected.hasExternalSymlinks ? { minClientVersion: '1.6.0' } : {}),
    },
    media: {
      iconUrl: inspected.iconArtifact ? `${catalogBaseUrl}/icons/${identity.id}${inspected.iconArtifact.ext}` : null,
      screenshots: companion.screenshots || [],
    },
    taxonomy: {
      categories: inferredTaxonomy.categories,
      tags: inferredTaxonomy.tags,
      platforms: companion.platforms?.length ? companion.platforms : ['win32', 'darwin', 'linux'],
      taxonomyVersion: inferredTaxonomy.taxonomyVersion || TAXONOMY_VERSION,
    },
    capabilities: inspected.capabilities,
    authenticity: {
      score: inspected.authenticity?.score ?? 1,
      compatTier: inspected.authenticity?.compatTier || 'compatible',
      scorerVersion: AUTHENTICITY_SCORER_VERSION,
    },
    structuralMeta: inspected.structuralMeta,
    ...(forkMeta ? { forkMeta } : {}),
    ...(sortedSources.length > 0 ? { discoverySources: sortedSources } : {}),
    ...(inspected.hasExternalSymlinks ? { minClientVersion: '1.6.0' } : {}),
    updatedAt: releaseInfo?.publishedAt || new Date().toISOString(),
  };

  return {
    pluginEntry,
    readmeMarkdown: inspected.readmeMarkdown,
    readmeZhMarkdown: inspected.readmeZhMarkdown || '',
    readmeEnMarkdown: inspected.readmeEnMarkdown || '',
    readmeMeta: computeReadmeMeta(inspected),
    iconArtifact: inspected.iconArtifact,
    fingerprint: inspected.fingerprint,
    skillDescriptions: inspected.skillDescriptions || [],
    topics: Array.isArray(repoMeta.topics) ? repoMeta.topics : [],
  };
}

/**
 * Unpacks a repository tarball ONCE in memory (with scoped external symlink collection),
 * discovers all candidate plugin roots across all 4 layouts (pruned via Trie),
 * validates each root independently, and returns `{ records, skipped, candidateRoots }`.
 */
export function buildTrack2PluginRecordsForArchive({
  repoMeta,
  releaseInfo,
  tarballBuffer,
  tarInfo: preInspectedTarInfo = null,
  explicitSubpaths = [],
  subdirGlobs = [],
  isMonorepo = false,
  maxPlugins = DEFAULT_MAX_PLUGINS_PER_REPO,
  track1RepoRoots = null,
  track1RepoUrlRoots = null,
  discoverySources = [],
  catalogBaseUrl = process.env.AGY_MARKET_CATALOG_BASE_URL || DEFAULT_CATALOG_BASE_URL,
}) {
  if (!repoMeta || repoMeta.archived || repoMeta.disabled || repoMeta.is_template || isFirstPartyRepoMeta(repoMeta)) {
    return { records: [], skipped: [{ pluginRoot: '.', code: 'ERR_REPO_INELIGIBLE' }], candidateRoots: [] };
  }

  const tarInfo = preInspectedTarInfo || inspectTarGzBuffer(tarballBuffer, { allowExternalSymlinks: true });
  const candidateRoots = discoverPluginRootsInArchive(tarInfo.files, {
    explicitSubpaths,
    subdirGlobs,
    isMonorepo,
    maxPlugins,
  });

  if (candidateRoots.length === 0) {
    throw new Error('ERR_MISSING_PLUGIN_JSON: No plugin.json or .antigravity-plugin/plugin.json found in archive');
  }

  // Pass 1: validate every candidate root so we know the exact count of valid roots for single-subdir ID simplification.
  const validDrafts = [];
  const skipped = [];
  for (const pluginRoot of candidateRoots) {
    try {
      const built = buildTrack2PluginRecord({
        repoMeta,
        releaseInfo,
        tarballBuffer,
        tarInfo,
        pluginRoot,
        totalValidRootsInRepo: candidateRoots.length,
        track1RepoRoots,
        track1RepoUrlRoots,
        discoverySources,
        catalogBaseUrl,
      });
      if (built) {
        validDrafts.push({ pluginRoot, built });
      } else {
        skipped.push({ pluginRoot, code: 'SKIP_TRACK1_OR_INELIGIBLE' });
      }
    } catch (err) {
      skipped.push({
        pluginRoot,
        code: extractErrorCode(err),
        message: String(err?.message || err),
      });
    }
  }

  if (validDrafts.length === 0) {
    return { records: [], skipped, candidateRoots };
  }

  // Pass 2: finalize IDs & collision-free scopedNames using exact `validDrafts.length`.
  const ownerLogin = String(repoMeta.owner?.login || 'community');
  const repoName = String(repoMeta.name || (repoMeta.full_name ? String(repoMeta.full_name).split('/')[1] : '') || '');
  const usedScopedNames = new Set();
  const records = validDrafts.map(({ pluginRoot, built }) => {
    const identity = buildTrack2EntryIdentity({
      ownerLogin,
      repoName: repoName || built.pluginEntry.canonicalName,
      pluginRoot,
      manifestName: built.pluginEntry.canonicalName,
      totalValidRootsInRepo: validDrafts.length,
      usedScopedNames,
    });
    let nextTaxonomy = built.pluginEntry.taxonomy;
    if (
      identity.id !== built.pluginEntry.id &&
      (CURATED_TAXONOMY_OVERRIDES[identity.id] ||
        !Array.isArray(built.pluginEntry.taxonomy?.categories) ||
        built.pluginEntry.taxonomy.categories.length === 0 ||
        built.pluginEntry.taxonomy.categories.every((c) => c === 'other'))
    ) {
      const reInferred = inferPluginTaxonomy({
        id: identity.id,
        canonicalName: identity.canonicalName,
        displayName: built.pluginEntry.displayName,
        description: built.pluginEntry.description,
        topics: Array.isArray(repoMeta.topics) ? repoMeta.topics : [],
        capabilities: built.pluginEntry.capabilities,
        existingCategories: [],
        existingTags: [],
        readmeText: built.readmeMarkdown || '',
        skillDescriptions: built.skillDescriptions || [],
      });
      nextTaxonomy = {
        ...built.pluginEntry.taxonomy,
        categories: reInferred.categories,
        tags: reInferred.tags,
        platforms: built.pluginEntry.taxonomy?.platforms?.length
          ? built.pluginEntry.taxonomy.platforms
          : ['win32', 'darwin', 'linux'],
        taxonomyVersion: reInferred.taxonomyVersion || TAXONOMY_VERSION,
      };
    }
    const nextEntry = {
      ...built.pluginEntry,
      id: identity.id,
      canonicalName: identity.canonicalName,
      scopedName: identity.scopedName,
      media: {
        ...built.pluginEntry.media,
        iconUrl: built.iconArtifact ? `${catalogBaseUrl}/icons/${identity.id}${built.iconArtifact.ext}` : null,
      },
      taxonomy: nextTaxonomy,
    };
    return {
      ...built,
      pluginEntry: nextEntry,
    };
  });

  return { records, skipped, candidateRoots };
}

export function parseCrawlerCliArgs(argv = process.argv.slice(2)) {
  const opts = {
    aggregatorsFlag: false,
    searchFlag: false,
    repos: [],
    maxNew: 0,
    maxRepos: 0,
    concurrency: 4,
    ignoreNegCache: false,
    forceRefresh: false,
    zeroQuota: false,
    noGraphql: false,
    backfill: false,
    outReadmesDir: '',
    seedReadmesDir: '',
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--aggregators' || arg === '--aggregators-only') {
      opts.aggregatorsFlag = true;
    } else if (arg === '--search') {
      opts.searchFlag = true;
    } else if (arg === '--repos' && i + 1 < argv.length) {
      const raw = argv[++i];
      for (const part of raw.split(',')) {
        const trimmed = part.trim();
        if (trimmed) opts.repos.push(trimmed);
      }
    } else if (arg.startsWith('--repos=')) {
      const raw = arg.slice('--repos='.length);
      for (const part of raw.split(',')) {
        const trimmed = part.trim();
        if (trimmed) opts.repos.push(trimmed);
      }
    } else if (arg === '--max-new' && i + 1 < argv.length) {
      opts.maxNew = Math.max(0, parseInt(argv[++i], 10) || 0);
    } else if (arg.startsWith('--max-new=')) {
      opts.maxNew = Math.max(0, parseInt(arg.slice('--max-new='.length), 10) || 0);
    } else if (arg === '--max-repos' && i + 1 < argv.length) {
      opts.maxRepos = Math.max(0, parseInt(argv[++i], 10) || 0);
    } else if (arg.startsWith('--max-repos=')) {
      opts.maxRepos = Math.max(0, parseInt(arg.slice('--max-repos='.length), 10) || 0);
    } else if (arg === '--concurrency' && i + 1 < argv.length) {
      opts.concurrency = Math.min(8, Math.max(1, parseInt(argv[++i], 10) || 4));
    } else if (arg.startsWith('--concurrency=')) {
      opts.concurrency = Math.min(8, Math.max(1, parseInt(arg.slice('--concurrency='.length), 10) || 4));
    } else if (arg === '--out-readmes-dir' && i + 1 < argv.length) {
      opts.outReadmesDir = argv[++i];
    } else if (arg.startsWith('--out-readmes-dir=')) {
      opts.outReadmesDir = arg.slice('--out-readmes-dir='.length);
    } else if (arg === '--seed-readmes-dir' && i + 1 < argv.length) {
      opts.seedReadmesDir = argv[++i];
    } else if (arg.startsWith('--seed-readmes-dir=')) {
      opts.seedReadmesDir = arg.slice('--seed-readmes-dir='.length);
    } else if (arg === '--no-neg-cache') {
      opts.ignoreNegCache = true;
    } else if (arg === '--force-refresh') {
      opts.forceRefresh = true;
    } else if (arg === '--zero-quota') {
      opts.zeroQuota = true;
    } else if (arg === '--no-graphql') {
      opts.noGraphql = true;
    } else if (arg === '--backfill') {
      opts.backfill = true;
    }
  }

  const hasExplicitScope = opts.aggregatorsFlag || opts.searchFlag || opts.repos.length > 0;
  return {
    enableSearch: hasExplicitScope ? opts.searchFlag : true,
    enableAggregators: hasExplicitScope ? opts.aggregatorsFlag : true,
    explicitRepos: opts.repos,
    maxNew: opts.maxNew,
    maxRepos: opts.maxRepos,
    concurrency: opts.concurrency,
    ignoreNegCache: opts.ignoreNegCache,
    forceRefresh: opts.forceRefresh,
    zeroQuota: opts.zeroQuota,
    noGraphql: opts.noGraphql,
    backfill: opts.backfill,
    outReadmesDir: opts.outReadmesDir,
    seedReadmesDir: opts.seedReadmesDir,
  };
}

function loadJsonFileSafe(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function crawlExperimentalTopics({
  repoRoot = REPO_ROOT,
  enableSearch = true,
  enableAggregators = true,
  explicitRepos = [],
  maxNew = 0,
  maxRepos = 0,
  concurrency = 4,
  ignoreNegCache = false,
  forceRefresh = false,
  zeroQuota = false,
  noGraphql = false,
  backfill = false,
  repoSearchPoolBudget = 45,
  codeSearchPoolBudget = 25,
  outReadmesDir = '',
  seedReadmesDir = '',
  token = process.env.GITHUB_TOKEN || '',
  fetchImpl = fetch,
  nowMs = Date.now(),
  searchDelayMs = REPO_SEARCH_DELAY_MS,
  codeSearchDelayMs = CODE_SEARCH_DELAY_MS,
  catalogBaseUrl = process.env.AGY_MARKET_CATALOG_BASE_URL || DEFAULT_CATALOG_BASE_URL,
} = {}) {
  const ledgerPath = join(repoRoot, 'state', 'ledger.json');
  const cachePath = join(repoRoot, 'state', 'unverified-cache.json');
  const negCachePath = join(repoRoot, 'state', 'crawl-negative-cache.json');
  const discoveryStatePath = join(repoRoot, 'state', 'discovery-state.json');
  const banditStatePath = join(repoRoot, 'state', 'bandit-state.json');
  const fingerprintsPath = join(repoRoot, 'state', 'fingerprints.json');
  const discoveredAggsPath = join(repoRoot, 'state', 'discovered-aggregators.json');

  const resolvedOutReadmesDir = outReadmesDir ? resolve(repoRoot, outReadmesDir) : join(repoRoot, 'dist', 'readmes');
  const resolvedSeedReadmesDir = seedReadmesDir ? resolve(repoRoot, seedReadmesDir) : '';

  const ledger = loadJsonFileSafe(ledgerPath, { schemaVersion: 1, entries: {} });
  const existingCache = loadJsonFileSafe(cachePath, {
    schemaVersion: 2,
    plugins: [],
    readmeMeta: {},
  });
  const negCache = loadJsonFileSafe(negCachePath, { schemaVersion: 2, entries: {} });
  if (!negCache.entries || typeof negCache.entries !== 'object') {
    negCache.entries = {};
  }

  const discoveryState = normalizeDiscoveryState(loadJsonFileSafe(discoveryStatePath, null));
  const storedBandit = loadJsonFileSafe(banditStatePath, null);
  let banditState = storedBandit?.arms ? storedBandit : discoveryState.bandit;
  const existingFingerprints = loadJsonFileSafe(fingerprintsPath, { schemaVersion: 1, fingerprints: {} });
  const fingerprintsById = { ...(existingFingerprints?.fingerprints || {}) };
  const discoveredAggsDoc = loadJsonFileSafe(discoveredAggsPath, { schemaVersion: 1, aggregators: [] });

  const nowIso = new Date(nowMs).toISOString();
  const runSlot = discoveryState.runCount;
  if (enableSearch) {
    discoveryState.runCount += 1;
  }

  // Build Track-1 composite dedup indices (never modifying ledger.json!)
  const track1RepoRoots = new Set();
  const track1RepoUrlRoots = new Set();
  const track1Ids = new Set();
  for (const e of Object.values(ledger.entries || {})) {
    const normRoot = normalizeRelPosix(e.pluginRoot || '.');
    if (e.entrySlug) track1Ids.add(e.entrySlug);
    if (Number(e.repositoryId) > 0) {
      track1RepoRoots.add(`${e.repositoryId}:${normRoot}`);
    }
    if (e.repoFullName) {
      track1RepoUrlRoots.add(`${String(e.repoFullName).toLowerCase()}:${normRoot}`);
    }
    for (const prev of e.previousRepoFullNames || []) {
      track1RepoUrlRoots.add(`${String(prev).toLowerCase()}:${normRoot}`);
    }
  }

  // Index existing positive cache by repoKey and repositoryId
  const cachedByRepoKey = new Map();
  const cachedByRepoId = new Map();
  const knownValidRepoKeys = new Set();
  const ownerRepoCounts = new Map();
  for (const p of existingCache.plugins || []) {
    const rk = repoKeyFromUrl(p?.repository?.url);
    if (rk) {
      if (!cachedByRepoKey.has(rk)) cachedByRepoKey.set(rk, []);
      cachedByRepoKey.get(rk).push(p);
      knownValidRepoKeys.add(rk);
      const owner = rk.split('/')[0];
      if (owner) {
        if (!ownerRepoCounts.has(owner)) ownerRepoCounts.set(owner, new Set());
        ownerRepoCounts.get(owner).add(rk);
      }
    }
    const rid = Number(p?.repository?.repositoryId || 0);
    if (rid > 0) {
      if (!cachedByRepoId.has(rid)) cachedByRepoId.set(rid, []);
      cachedByRepoId.get(rid).push(p);
    }
  }
  const ownerRepoCountInts = new Map([...ownerRepoCounts.entries()].map(([o, s]) => [o, s.size]));

  const stateIconsDir = join(repoRoot, 'state', 'icons');
  const iconsDir = join(repoRoot, 'dist', 'icons');
  mkdirSync(dirname(cachePath), { recursive: true });
  mkdirSync(stateIconsDir, { recursive: true });
  mkdirSync(iconsDir, { recursive: true });
  mkdirSync(resolvedOutReadmesDir, { recursive: true });

  // Load any seeded per-plugin READMEs for frontier mining & migration
  const seededReadmesById = new Map();
  for (const dir of [resolvedSeedReadmesDir, resolvedOutReadmesDir]) {
    if (!dir) continue;
    for (const [id, rec] of readPerPluginReadmeDir(dir).entries()) {
      seededReadmesById.set(id, rec);
    }
  }

  const apiHeaders = {
    Accept: 'application/vnd.github+json',
    'User-Agent': USER_AGENT,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  const restState = {
    disabled: Boolean(zeroQuota),
    rateLimited: false,
    codeSearchDisabled: !token || Boolean(zeroQuota),
  };

  const useGraphql = Boolean(token) && !zeroQuota && !noGraphql;

  async function githubApiGetJson(url, { isCodeSearch = false } = {}) {
    if (restState.disabled || restState.rateLimited) {
      return { ok: false, status: 403, rateLimited: true, data: null };
    }
    if (isCodeSearch && restState.codeSearchDisabled) {
      return { ok: false, status: 401, rateLimited: false, data: null };
    }
    try {
      const res = await fetchWithLimit(url, {
        headers: apiHeaders,
        timeoutMs: 15_000,
        maxBytes: 4 * 1024 * 1024,
        fetchImpl,
      });
      const remaining = res.headers.get('x-ratelimit-remaining');
      if (remaining === '0') {
        if (isCodeSearch) {
          restState.codeSearchDisabled = true;
        } else {
          restState.rateLimited = true;
        }
      }
      if (res.status === 401 || res.status === 403 || res.status === 422 || res.status === 429) {
        const bodyText = res.buffer.toString('utf8');
        if (isCodeSearch) {
          restState.codeSearchDisabled = true;
          console.warn(`[crawl-topics] Code Search fail-open (HTTP ${res.status}); continuing with Repo Search & Aggregators.`);
          return { ok: false, status: res.status, rateLimited: res.status === 429 || res.status === 403, data: null };
        }
        if (res.status === 429 || remaining === '0' || /rate limit/i.test(bodyText)) {
          restState.rateLimited = true;
          console.warn(`[crawl-topics] GitHub REST API rate-limited (HTTP ${res.status}); switching remaining repos to zero-quota fallback.`);
          return { ok: false, status: res.status, rateLimited: true, data: null };
        }
        return { ok: false, status: res.status, rateLimited: false, data: null };
      }
      if (!res.ok) {
        return { ok: false, status: res.status, rateLimited: false, data: null };
      }
      return { ok: true, status: res.status, rateLimited: false, data: JSON.parse(res.buffer.toString('utf8')) };
    } catch {
      return { ok: false, status: 0, rateLimited: false, data: null };
    }
  }

  // Stage 1: Multi-channel candidate discovery & deduplication
  const candidates = new Map();
  const skipStats = {};
  const bumpSkip = (code) => {
    skipStats[code] = (skipStats[code] || 0) + 1;
  };
  const armRepoHits = new Map();
  const armCosts = new Map();
  const recordArmHit = (armId, repoKey) => {
    if (!armId || !repoKey) return;
    if (!armRepoHits.has(armId)) armRepoHits.set(armId, new Set());
    armRepoHits.get(armId).add(repoKey.toLowerCase());
  };

  function upsertCandidate(
    fullName,
    {
      repoMeta = null,
      explicitSubpaths = [],
      subdirGlobs = [],
      isMonorepo = false,
      maxPlugins = DEFAULT_MAX_PLUGINS_PER_REPO,
      source = 'unknown',
      priority = 50,
    } = {},
  ) {
    const cleanFull = String(fullName || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '');
    const parts = cleanFull.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return;
    if (FIRST_PARTY_REPO_OWNERS.has(parts[0].toLowerCase())) return;
    if (repoMeta && (repoMeta.archived || repoMeta.disabled || repoMeta.is_template || isFirstPartyRepoMeta(repoMeta))) {
      return;
    }

    const key = cleanFull.toLowerCase();
    if (!candidates.has(key)) {
      candidates.set(key, {
        key,
        fullName: cleanFull,
        repoMeta: repoMeta || null,
        explicitSubpaths: new Set(),
        subdirGlobs: new Set(),
        isMonorepo: Boolean(isMonorepo),
        maxPlugins: maxPlugins || DEFAULT_MAX_PLUGINS_PER_REPO,
        discoverySources: new Set(),
        priority,
      });
    }
    const entry = candidates.get(key);
    if (repoMeta && (!entry.repoMeta || (!entry.repoMeta.id && repoMeta.id))) {
      entry.repoMeta = repoMeta;
      if (repoMeta.full_name) entry.fullName = repoMeta.full_name;
    }
    for (const sp of explicitSubpaths || []) {
      if (sp) entry.explicitSubpaths.add(normalizeRelPosix(sp));
    }
    for (const g of subdirGlobs || []) {
      if (g) entry.subdirGlobs.add(normalizeRelPosix(g));
    }
    if (isMonorepo) entry.isMonorepo = true;
    if (maxPlugins && maxPlugins > entry.maxPlugins) entry.maxPlugins = maxPlugins;
    if (source) entry.discoverySources.add(source);
    if (priority < entry.priority) entry.priority = priority;
  }

  // Priority 0: Explicit CLI `--repos`
  for (const rawRepo of explicitRepos || []) {
    const parsedUrl = rawRepo.startsWith('https://')
      ? parseSafeGitHubCandidateUrl(rawRepo)
      : parseSafeGitHubCandidateUrl(`https://github.com/${rawRepo}`);
    if (!parsedUrl) continue;
    upsertCandidate(parsedUrl.fullName, {
      explicitSubpaths: parsedUrl.explicitSubpath ? [parsedUrl.explicitSubpath] : [],
      source: 'cli-repo',
      priority: 0,
    });
  }

  // Priority 10-20: Channel B (`data/aggregators.json` + auto-promoted `state/discovered-aggregators.json`) — zero REST quota!
  const curatedAggregatorRepos = new Set();
  if (enableAggregators) {
    const curatedAggs = loadAggregatorsConfig(repoRoot);
    for (const agg of curatedAggs) curatedAggregatorRepos.add(agg.repo.toLowerCase());

    const autoAggs = (Array.isArray(discoveredAggsDoc?.aggregators) ? discoveredAggsDoc.aggregators : [])
      .filter((a) => a && typeof a.repo === 'string' && !curatedAggregatorRepos.has(a.repo.toLowerCase()))
      .map((a) => ({
        id: String(a.id || a.repo.toLowerCase().replace('/', '__')),
        repo: a.repo.trim(),
        kind: String(a.kind || 'awesome-list'),
        files: Array.isArray(a.files) && a.files.length ? a.files : ['README.md'],
        subdirGlobs: Array.isArray(a.subdirGlobs) ? a.subdirGlobs : [],
        maxPlugins: DEFAULT_MAX_PLUGINS_PER_REPO,
        scanSubdirs: false,
      }));

    const allAggregators = [...curatedAggs, ...autoAggs];
    for (const agg of allAggregators) {
      if (agg.kind === 'monorepo' || agg.scanSubdirs) {
        upsertCandidate(agg.repo, {
          subdirGlobs: agg.subdirGlobs,
          isMonorepo: true,
          maxPlugins: agg.maxPlugins,
          source: `aggregator:${agg.id}`,
          priority: 10,
        });
      } else if (agg.kind === 'json-index') {
        upsertCandidate(agg.repo, {
          source: `aggregator:${agg.id}`,
          priority: 15,
        });
      }

      if (agg.files.length > 0) {
        const fetched = await fetchAggregatorCandidates(agg, { fetchImpl, userAgent: USER_AGENT });
        for (const item of fetched.candidates) {
          const isSelf = item.fullName.toLowerCase() === agg.repo.toLowerCase();
          upsertCandidate(item.fullName, {
            explicitSubpaths: item.explicitSubpaths,
            isMonorepo: isSelf && agg.kind === 'monorepo',
            subdirGlobs: isSelf ? agg.subdirGlobs : [],
            maxPlugins: isSelf ? agg.maxPlugins : DEFAULT_MAX_PLUGINS_PER_REPO,
            source: `aggregator:${agg.id}`,
            priority: isSelf ? 10 : 20,
          });
        }
      }
    }
  }

  // Priority 25-35: Channel A (Adaptive Repo Search + Concurrent CodeSearchPacer + P1 Snowball + npm Bridge)
  const bandit = new DiscountedUcb1Cost();
  const slicer = new AdaptiveRangeSlicer();
  const allBanditArmIds = [];

  if (enableSearch) {
    // 1. 1-hop README Link Frontier (0 GitHub API quota!)
    const readmesByRepo = new Map();
    for (const p of existingCache.plugins || []) {
      const rk = repoKeyFromUrl(p?.repository?.url);
      if (!rk || readmesByRepo.has(rk)) continue;
      const seeded = seededReadmesById.get(p.id);
      const md = seeded?.default || existingCache.readmes?.[p.id] || '';
      if (md) readmesByRepo.set(rk, md);
    }
    if (readmesByRepo.size > 0) {
      const frontier = mineReadmeFrontier(readmesByRepo, {
        knownValidRepoKeys,
        negCacheRepoKeys: new Set(Object.keys(negCache.entries).map((k) => k.toLowerCase())),
        curatedAggregatorRepos,
      });
      for (const fc of frontier.candidates) {
        upsertCandidate(fc.fullName, {
          explicitSubpaths: fc.explicitSubpaths,
          source: 'snowball:readme',
          priority: 28,
        });
      }
      if (frontier.promotedAggregators.length > 0) {
        const mergedAuto = new Map(
          (Array.isArray(discoveredAggsDoc?.aggregators) ? discoveredAggsDoc.aggregators : []).map((a) => [
            String(a.repo || '').toLowerCase(),
            a,
          ]),
        );
        for (const pa of frontier.promotedAggregators) {
          mergedAuto.set(pa.repo.toLowerCase(), pa);
          discoveryState.discoveredAggregators[pa.repo.toLowerCase()] = {
            ...pa,
            promotedAt: nowIso,
          };
        }
        writeFileSync(
          discoveredAggsPath,
          `${JSON.stringify({ schemaVersion: 1, updatedAt: nowIso, aggregators: [...mergedAuto.values()] }, null, 2)}\n`,
          'utf8',
        );
      }
    }

    // 2. npm Search Bridge (0 GitHub API quota; fail-open!)
    const npmBridgeTask = (async () => {
      if (zeroQuota) return;
      try {
        const npmOut = await discoverFromNpmSearch({ fetchImpl, userAgent: USER_AGENT });
        for (const nc of npmOut.candidates) {
          upsertCandidate(nc.fullName, {
            explicitSubpaths: nc.explicitSubpaths,
            source: 'bridge:npm',
            priority: 26,
          });
        }
      } catch {
        /* fail-open on npm search */
      }
    })();

    // 3. Author-Centric GraphQL Snowball (`E_author`, 1 pt / 20 owners)
    const authorSnowballTask = (async () => {
      if (!useGraphql || ownerRepoCountInts.size === 0) return;
      const selectedOwners = selectAuthorsForExpansion(ownerRepoCountInts, { runSlot });
      if (selectedOwners.length === 0) return;
      const allKnown = new Set([...knownValidRepoKeys, ...Object.keys(negCache.entries).map((k) => k.toLowerCase())]);
      const authOut = await batchAuthorExpansion(selectedOwners, {
        knownRepoKeys: allKnown,
        token,
        fetchImpl,
        userAgent: USER_AGENT,
      });
      if (authOut.ok) {
        for (const ac of authOut.candidates) {
          upsertCandidate(ac.fullName, {
            repoMeta: toRestCompatRepoMeta({ ...ac, status: 'ok' }),
            source: 'snowball:author',
            priority: 25,
          });
        }
      }
    })();

    // 4. Adaptive Bandit-Allocated Repo Search
    const repoSearchTask = (async () => {
      if (restState.disabled || restState.rateLimited) return;
      const autoTopicArms = Object.values(discoveryState.autoTopics || {})
        .filter((t) => t && t.queryId && t.query)
        .map((t) => ({ id: t.queryId, baseQuery: t.query, maxUnits: 3 }));
      const repoArms = [...CHANNEL_A_ADAPTIVE_BASE_QUERIES, ...autoTopicArms];
      for (const a of repoArms) allBanditArmIds.push(a.id);

      const alloc = bandit.allocateBudget(repoArms, repoSearchPoolBudget, banditState);
      for (const arm of repoArms) {
        if (restState.rateLimited) break;
        const pageBudget = alloc.get(arm.id) || 0;
        if (pageBudget <= 0) continue;

        const out = await slicer.runQuery({
          queryId: arm.id,
          baseQuery: arm.baseQuery,
          discoveryState,
          pageBudget,
          nowMs,
          backfill,
          isNovelItem: (repo) => !knownValidRepoKeys.has(String(repo?.full_name || '').toLowerCase()),
          fetchPageFn: async (queryString, page, perPage) => {
            if (restState.rateLimited) {
              return { ok: false, rateLimited: true, totalCount: 0, items: [] };
            }
            const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(queryString)}&sort=updated&per_page=${perPage}&page=${page}`;
            const res = await githubApiGetJson(url);
            if (searchDelayMs > 0 && !restState.rateLimited) {
              await sleep(Math.min(searchDelayMs, 2500));
            }
            if (!res.ok || !res.data) {
              return { ok: false, rateLimited: res.rateLimited, totalCount: 0, items: [] };
            }
            const items = Array.isArray(res.data.items) ? res.data.items : [];
            return {
              ok: true,
              rateLimited: false,
              totalCount: Number(res.data.total_count || items.length),
              items,
            };
          },
        });

        armCosts.set(arm.id, (armCosts.get(arm.id) || 0) + out.pagesUsed);
        for (const repo of out.items) {
          if (!repo?.full_name) continue;
          recordArmHit(arm.id, repo.full_name);
          upsertCandidate(repo.full_name, {
            repoMeta: repo,
            source: `search:${arm.id}`,
            priority: 30,
          });
        }
      }
    })();

    // 5. Concurrent Code Search via `CodeSearchPacer` + `VALIDATED_CODE_SEARCH_QUERIES`
    const codeSearchTask = (async () => {
      if (restState.codeSearchDisabled || restState.disabled || !token) return;
      const saturatedRepos = Object.keys(discoveryState.saturatedMonorepos || {});
      const codeArms = VALIDATED_CODE_SEARCH_QUERIES.map((c) => ({
        id: `code:${c.id}`,
        spec: c,
        maxUnits: c.maxPages || 3,
      }));
      for (const a of codeArms) allBanditArmIds.push(a.id);

      const alloc = bandit.allocateBudget(codeArms, codeSearchPoolBudget, banditState);
      const pacer = new CodeSearchPacer({
        minIntervalMs: codeSearchDelayMs,
        maxPagesPerRun: codeSearchPoolBudget,
      });

      for (const arm of codeArms) {
        if (pacer.disabled) break;
        const pageBudget = alloc.get(arm.id) || 0;
        if (pageBudget <= 0) continue;

        const effectiveQuery = buildCodeSearchQueryWithExclusions(arm.spec.query, saturatedRepos, {
          maxLength: 250,
          maxExclusions: 5,
        });
        let pagesUsed = 0;

        for (let page = 1; page <= pageBudget; page++) {
          if (pacer.disabled) break;
          const url = `https://api.github.com/search/code?q=${encodeURIComponent(effectiveQuery)}&per_page=100&page=${page}`;
          const res = await pacer.fetchPage(url, { headers: apiHeaders, fetchImpl });
          if (res.skipped) break;
          pagesUsed += 1;
          if (!res.ok || !res.data) break;

          const items = Array.isArray(res.data.items) ? res.data.items : [];
          for (const item of items) {
            const repoFullName = item?.repository?.full_name;
            if (!repoFullName) continue;
            const subpath = deriveExplicitSubpathFromCodePath(item.path);
            recordArmHit(arm.id, repoFullName);
            upsertCandidate(repoFullName, {
              explicitSubpaths: subpath ? [subpath] : [],
              source: arm.id,
              priority: 35,
            });
          }
          const totalCount = Number(res.data.total_count || 0);
          if (items.length < 100 || page * 100 >= Math.min(1000, totalCount)) {
            break;
          }
        }
        if (pagesUsed > 0) {
          armCosts.set(arm.id, (armCosts.get(arm.id) || 0) + pagesUsed);
        }
      }
      if (pacer.disabled) {
        restState.codeSearchDisabled = true;
      }
    })();

    await Promise.all([npmBridgeTask, authorSnowballTask, repoSearchTask, codeSearchTask]);
  }

  // Sort candidates by priority, then lexicographically for deterministic execution
  const orderedCandidates = [...candidates.values()].sort(
    (a, b) => a.priority - b.priority || a.key.localeCompare(b.key),
  );
  const effectiveCandidates = maxRepos > 0 ? orderedCandidates.slice(0, maxRepos) : orderedCandidates;

  // Stage 2: Two-Stage GraphQL Batch Prefetch (when token available & GraphQL enabled)
  const graphqlStage2BNodes = new Map();
  const graphqlNotFoundKeys = new Set();
  const graphqlIneligibleKeys = new Set();
  const graphqlHeartbeatUnchanged = new Map(); // repoKey -> heartbeatNode
  const graphqlTriageRejected = new Map(); // repoKey -> { node, reason }

  const candidateByKey = new Map(effectiveCandidates.map((c) => [c.key, c]));

  // Track which cached valid repos are due for heartbeat when running full crawl
  const cachedHeartbeatReposToCheck = [];
  if (enableSearch && maxRepos === 0) {
    for (const [rk, list] of cachedByRepoKey.entries()) {
      const sample = list[0];
      const tierInfo = classifyPositiveRecrawlTier(
        {
          repositoryId: sample?.repository?.repositoryId || 0,
          repoKey: rk,
          pushedAt: sample?.repository?.pushedAt || null,
          updatedAt: sample?.updatedAt || null,
          stars: sample?.repository?.stars || 0,
        },
        { nowMs, runSlot },
      );
      if (forceRefresh || tierInfo.due || candidateByKey.has(rk)) {
        cachedHeartbeatReposToCheck.push(rk);
      }
    }
  } else {
    // Targeted / aggregator-only crawl: only heartbeat cached repos present in effectiveCandidates
    for (const c of effectiveCandidates) {
      if (cachedByRepoKey.has(c.key)) {
        cachedHeartbeatReposToCheck.push(c.key);
      }
    }
  }

  if (useGraphql) {
    const stage2BQueue = new Set();

    // Stage 2A-Heartbeat (`B=50`, NO `rootTree`) for due cached valid repos
    if (cachedHeartbeatReposToCheck.length > 0) {
      const hbOut = await batchHeartbeatStage2A(cachedHeartbeatReposToCheck, {
        token,
        fetchImpl,
        userAgent: USER_AGENT,
      });
      if (hbOut.ok) {
        for (const rk of cachedHeartbeatReposToCheck) {
          const node = hbOut.results.get(rk);
          if (!node) continue;
          if (node.status === 'not_found') {
            graphqlNotFoundKeys.add(rk);
            continue;
          }
          if (node.status === 'error') continue;
          if (
            node.status === 'empty' ||
            node.isArchived ||
            node.isDisabled ||
            node.isTemplate ||
            FIRST_PARTY_REPO_OWNERS.has(String(node.ownerLogin || '').toLowerCase())
          ) {
            graphqlIneligibleKeys.add(rk);
            continue;
          }
          const cachedList = cachedByRepoKey.get(rk) || [];
          const headUnchanged =
            !forceRefresh &&
            cachedList.length > 0 &&
            node.headSha &&
            cachedList.every((p) => String(p.commitSha || '').toLowerCase() === node.headSha.toLowerCase());
          if (headUnchanged) {
            graphqlHeartbeatUnchanged.set(rk, node);
          } else {
            stage2BQueue.add(rk);
          }
        }
      }
    }

    // Stage 2A-Novel (`B=20`, depth-2 Tree) for unseen candidates passing pre-network neg-cache
    const novelReposForStage2A = [];
    for (const c of effectiveCandidates) {
      if (cachedByRepoKey.has(c.key)) continue;
      const existingNeg = negCache.entries[c.key];
      if (!ignoreNegCache && !forceRefresh && existingNeg) {
        const decision = shouldSkipNegativeCache(existingNeg, {
          nowMs,
          observedPushedAt: c.repoMeta?.pushed_at || null,
          validatorVersion: CURRENT_VALIDATOR_VERSION,
          phase: 'pre-network',
        });
        if (decision.skip) continue;
      }
      novelReposForStage2A.push(c.fullName);
    }

    if (novelReposForStage2A.length > 0) {
      const novelOut = await batchNovelStage2A(novelReposForStage2A, {
        token,
        fetchImpl,
        userAgent: USER_AGENT,
      });
      if (novelOut.ok) {
        for (const fullName of novelReposForStage2A) {
          const rk = fullName.toLowerCase();
          const c = candidateByKey.get(rk);
          const node = novelOut.results.get(rk);
          if (!node || node.status === 'error') continue;
          if (node.status === 'not_found') {
            graphqlNotFoundKeys.add(rk);
            continue;
          }
          const triage = passesNovelStage2ATriage(node, {
            explicitSubpaths: c ? [...c.explicitSubpaths] : [],
            repoName: node.name || c?.repoMeta?.name || '',
            topics: Array.isArray(c?.repoMeta?.topics) ? c.repoMeta.topics : [],
          });
          if (!triage.pass) {
            graphqlTriageRejected.set(rk, { node, reason: triage.reason });
          } else {
            stage2BQueue.add(rk);
          }
        }
      }
    }

    // Stage 2B-Inspect (`B=20`) for changed cached repos + triaged novel repos
    if (stage2BQueue.size > 0) {
      const inspectOut = await batchInspectStage2B([...stage2BQueue], {
        token,
        fetchImpl,
        userAgent: USER_AGENT,
      });
      if (inspectOut.ok) {
        for (const [k, node] of inspectOut.results.entries()) {
          if (node.status === 'ok') {
            graphqlStage2BNodes.set(k, node);
          } else if (node.status === 'not_found') {
            graphqlNotFoundKeys.add(k);
          }
        }
      }
    }
  }

  // Stage 3: Snapshot resolution, cache reuse, Neg-Cache v2, streaming download & validation
  const discoveredById = new Map();
  const readmeMetaById = {};
  const validReposTopics = [];
  const negReposTopics = [];
  const removedRepoKeys = new Set(); // archived / disabled / template / first-party / confirmed 3-strike 404
  const revalidatedFailedRepoKeys = new Set(); // repo re-validated on newer commitSha and failed
  const updatedRepoKeys = new Set();
  const processedRepoKeys = new Set();
  let reusedCount = 0;
  let newlyValidatedRepos = 0;
  let newlyDiscoveredPlugins = 0;

  async function resolveRepoMeta(candidate) {
    const gql2B = graphqlStage2BNodes.get(candidate.key);
    if (gql2B) {
      return toRestCompatRepoMeta(gql2B);
    }
    if (candidate.repoMeta && Number(candidate.repoMeta.id) > 0) {
      return candidate.repoMeta;
    }
    if (!restState.disabled && !restState.rateLimited) {
      const apiRes = await githubApiGetJson(`https://api.github.com/repos/${candidate.fullName}`);
      if (apiRes.status === 404) {
        throw new Error(`ERR_REPO_NOT_FOUND: GitHub API returned 404 for ${candidate.fullName}`);
      }
      if (apiRes.ok && apiRes.data) {
        return apiRes.data;
      }
    }
    // Zero-quota fallback: try existing cache first, else lightweight HTML <meta> tags
    const cachedList = cachedByRepoKey.get(candidate.key) || [];
    if (cachedList.length > 0) {
      const sample = cachedList[0];
      const [ownerLogin, repoName] = candidate.fullName.split('/');
      return {
        id: Number(sample.repository?.repositoryId || 0),
        name: repoName,
        full_name: candidate.fullName,
        html_url: sample.repository?.url || `https://github.com/${candidate.fullName}`,
        description: sample.description?.en || sample.description?.zh || '',
        archived: false,
        disabled: false,
        stargazers_count: Number(sample.repository?.stars || 0),
        owner: { id: Number(sample.repository?.ownerId || 0), login: ownerLogin },
        topics: [],
      };
    }
    try {
      const htmlRes = await fetchWithLimit(`https://github.com/${candidate.fullName}`, {
        timeoutMs: 12_000,
        maxBytes: 512 * 1024,
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
        fetchImpl,
      });
      if (htmlRes.status === 404) {
        throw new Error(`ERR_REPO_NOT_FOUND: GitHub returned 404 for ${candidate.fullName}`);
      }
      if (htmlRes.ok) {
        return parseGitHubRepoHtmlMeta(htmlRes.buffer.toString('utf8'), candidate.fullName);
      }
    } catch (err) {
      if (extractErrorCode(err) === 'ERR_REPO_NOT_FOUND') throw err;
    }
    const [ownerLogin, repoName] = candidate.fullName.split('/');
    return {
      id: 0,
      name: repoName,
      full_name: candidate.fullName,
      html_url: `https://github.com/${candidate.fullName}`,
      description: '',
      archived: false,
      disabled: false,
      stargazers_count: 0,
      owner: { id: 0, login: ownerLogin },
      topics: [],
    };
  }

  async function resolveSnapshot(repoMeta, candidate) {
    const gql2B = graphqlStage2BNodes.get(candidate.key);
    if (gql2B) {
      const gqlSnap = resolveSnapshotFromStage2BNode(gql2B, {
        isMonorepo: candidate.isMonorepo,
        nowIso,
      });
      if (gqlSnap) return gqlSnap;
    }

    const repoId = Number(repoMeta.id || 0);
    const fullName = repoMeta.full_name || candidate.fullName;

    if (!restState.disabled && !restState.rateLimited && repoId > 0) {
      // Tier 1: Published non-draft, non-prerelease GitHub Release
      const relRes = await githubApiGetJson(`https://api.github.com/repositories/${repoId}/releases/latest`);
      if (relRes.ok && relRes.data && !relRes.data.draft && !relRes.data.prerelease) {
        const rel = relRes.data;
        const allowRelease = !candidate.isMonorepo || Boolean(parseSemver(rel.tag_name));
        if (allowRelease) {
          const asset = candidate.isMonorepo ? null : selectReleaseTarballAsset(rel.assets);
          const refRes = await githubApiGetJson(
            `https://api.github.com/repositories/${repoId}/commits/${encodeURIComponent(rel.tag_name)}`,
          );
          if (refRes.ok && refRes.data?.sha) {
            const tarballUrl = asset
              ? asset.browser_download_url
              : buildSourceArchiveUrl(fullName, refRes.data.sha, rel.tag_name);
            return {
              fullName,
              tier: 'release',
              tagName: rel.tag_name,
              commitSha: refRes.data.sha,
              tarballUrl,
              publishedAt: rel.published_at || refRes.data.commit?.committer?.date || nowIso,
              requireSelfContained: !asset,
            };
          }
        }
      }

      // Tier 2: Pure stable SemVer Git Tags
      if (!restState.rateLimited) {
        const tagsRes = await githubApiGetJson(`https://api.github.com/repositories/${repoId}/tags?per_page=30`);
        if (tagsRes.ok && Array.isArray(tagsRes.data) && tagsRes.data.length > 0) {
          const bestTagName = pickHighestStableSemverTag(tagsRes.data.map((t) => t?.name).filter(Boolean));
          if (bestTagName) {
            const tagObj = tagsRes.data.find((t) => t?.name === bestTagName);
            const sha = tagObj?.commit?.sha || '';
            if (/^[0-9a-f]{40}$/i.test(sha)) {
              let publishedAt = nowIso;
              const commitRes = await githubApiGetJson(`https://api.github.com/repositories/${repoId}/commits/${sha}`);
              if (commitRes.ok && commitRes.data?.commit?.committer?.date) {
                publishedAt = commitRes.data.commit.committer.date;
              }
              const normSha = sha.toLowerCase();
              return {
                fullName,
                tier: 'tag',
                tagName: bestTagName,
                commitSha: normSha,
                tarballUrl: buildSourceArchiveUrl(fullName, normSha, bestTagName),
                publishedAt,
                requireSelfContained: true,
              };
            }
          }
        }
      }

      // Tier 3 (Channel C): Default branch 40-hex Commit SHA
      if (!restState.rateLimited) {
        const branch = repoMeta.default_branch || 'main';
        const headRes = await githubApiGetJson(
          `https://api.github.com/repositories/${repoId}/commits/${encodeURIComponent(branch)}`,
        );
        if (headRes.ok && headRes.data?.sha) {
          const sha = String(headRes.data.sha).toLowerCase();
          return {
            fullName,
            tier: 'commit',
            tagName: null,
            commitSha: sha,
            tarballUrl: `https://github.com/${fullName}/archive/${sha}.tar.gz`,
            publishedAt: headRes.data.commit?.committer?.date || headRes.data.commit?.author?.date || nowIso,
            requireSelfContained: true,
          };
        }
      }
    }

    // Zero-REST-API-quota fallback (HEAD /releases/latest + git-upload-pack info/refs + .atom)
    return resolveRepoSnapshotZeroQuota(fullName, {
      fetchImpl,
      userAgent: USER_AGENT,
      preferFullRepoArchive: candidate.isMonorepo,
    });
  }

  function maybeUpgradeCachedTaxonomy(oldEntry, repoMeta = null) {
    const oldCategories = Array.isArray(oldEntry.taxonomy?.categories) ? oldEntry.taxonomy.categories : [];
    const oldTags = Array.isArray(oldEntry.taxonomy?.tags) ? oldEntry.taxonomy.tags : [];
    const platforms = oldEntry.taxonomy?.platforms?.length
      ? oldEntry.taxonomy.platforms
      : ['win32', 'darwin', 'linux'];
    const needsUpgrade =
      oldCategories.length === 0 ||
      oldCategories.every((c) => c === 'other') ||
      (oldTags.length === 1 && oldTags[0] === 'experimental');
    if (!needsUpgrade) {
      return {
        categories: oldCategories,
        tags: oldTags,
        platforms,
        taxonomyVersion: oldEntry.taxonomy?.taxonomyVersion || TAXONOMY_VERSION,
      };
    }
    const seeded = seededReadmesById.get(oldEntry.id);
    const inferred = inferPluginTaxonomy({
      id: oldEntry.id,
      canonicalName: oldEntry.canonicalName,
      displayName: oldEntry.displayName,
      description: oldEntry.description,
      topics: Array.isArray(repoMeta?.topics) ? repoMeta.topics : [],
      capabilities: oldEntry.capabilities || {},
      existingCategories: oldCategories,
      existingTags: oldTags,
      readmeText: seeded?.default || existingCache.readmes?.[oldEntry.id] || '',
    });
    return {
      categories: inferred.categories,
      tags: inferred.tags,
      platforms,
      taxonomyVersion: inferred.taxonomyVersion || TAXONOMY_VERSION,
    };
  }

  function carryOverReadmeForId(id) {
    if (existingCache.readmeMeta?.[id]) {
      readmeMetaById[id] = existingCache.readmeMeta[id];
    }
    const legacyDefault = existingCache.readmes?.[id] || '';
    const legacyZh = existingCache.readmesZh?.[id] || '';
    const legacyEn = existingCache.readmesEn?.[id] || '';
    if (legacyDefault || legacyZh || legacyEn) {
      if (!readmeMetaById[id]) {
        readmeMetaById[id] = computeReadmeMeta({
          readmeMarkdown: legacyDefault,
          readmeZhMarkdown: legacyZh,
          readmeEnMarkdown: legacyEn,
        });
      }
      if (!seededReadmesById.has(id)) {
        writePerPluginReadmeFile(resolvedOutReadmesDir, id, {
          readmeMarkdown: legacyDefault,
          readmeZhMarkdown: legacyZh,
          readmeEnMarkdown: legacyEn,
        });
      }
    } else if (!readmeMetaById[id] && seededReadmesById.has(id)) {
      const s = seededReadmesById.get(id);
      readmeMetaById[id] = computeReadmeMeta({
        readmeMarkdown: s.default,
        readmeZhMarkdown: s.zh,
        readmeEnMarkdown: s.en,
      });
    }
  }

  function recordCacheReuse(cachedList, repoMeta = null, { extraSources = [], livenessUpdate = null } = {}) {
    for (const oldEntry of cachedList) {
      const normRoot = normalizeRelPosix(oldEntry.repository?.pluginRoot || '.');
      const rid = Number(repoMeta?.id || oldEntry.repository?.repositoryId || 0);
      const rk = repoKeyFromUrl(oldEntry.repository?.url);
      if (track1Ids.has(oldEntry.id)) continue;
      if (rid > 0 && track1RepoRoots.has(`${rid}:${normRoot}`)) continue;
      if (rk && track1RepoUrlRoots.has(`${rk}:${normRoot}`)) continue;

      const mergedSources = [...new Set([...(oldEntry.discoverySources || []), ...extraSources])].sort();
      const updatedForkMeta = repoMeta?.fork ? buildForkMeta(repoMeta) : oldEntry.forkMeta || null;
      const nextLiveness = livenessUpdate ? livenessUpdate : undefined;

      const updatedEntry = {
        ...oldEntry,
        repository: {
          ...oldEntry.repository,
          repositoryId: rid || oldEntry.repository?.repositoryId || 0,
          ownerId: Number(repoMeta?.owner?.id || oldEntry.repository?.ownerId || 0),
          stars:
            repoMeta && typeof repoMeta.stargazers_count === 'number' && repoMeta.stargazers_count > 0
              ? Number(repoMeta.stargazers_count)
              : Number(oldEntry.repository?.stars || 0),
          pluginRoot: normRoot,
          ...(repoMeta?.pushed_at ? { pushedAt: repoMeta.pushed_at } : {}),
        },
        taxonomy: maybeUpgradeCachedTaxonomy(oldEntry, repoMeta),
        ...(mergedSources.length > 0 ? { discoverySources: mergedSources } : {}),
        ...(updatedForkMeta ? { forkMeta: updatedForkMeta } : {}),
        ...(nextLiveness ? { _liveness: nextLiveness } : {}),
        forceScopedInstall: true,
      };
      if (!nextLiveness && updatedEntry._liveness) {
        delete updatedEntry._liveness;
      }

      discoveredById.set(updatedEntry.id, updatedEntry);
      carryOverReadmeForId(updatedEntry.id);
      reusedCount += 1;
    }
  }

  function handle404OnCachedRepo(repoKey, cachedList, repoId = 0) {
    const sample = cachedList[0];
    const prevLiveness = sample?._liveness || {};
    const missCount = Number(prevLiveness.missCount || 0) + 1;
    const firstMissedAt = prevLiveness.firstMissedAt || nowIso;
    const elapsedMs = Math.max(0, nowMs - Date.parse(firstMissedAt));
    if (missCount >= EVICT_404_MIN_STRIKES && elapsedMs >= EVICT_404_MIN_ELAPSED_MS) {
      removedRepoKeys.add(repoKey);
      negCache.entries[repoKey] = updateNegativeCacheEntry(negCache.entries[repoKey], {
        repositoryId: repoId || Number(sample?.repository?.repositoryId || 0),
        headSha: null,
        reason: 'ERR_REPO_NOT_FOUND',
        nowMs,
      });
      bumpSkip('EVICT_404_CONFIRMED');
    } else {
      // Hold safely until 3 consecutive strikes spanning >= 72h
      recordCacheReuse(cachedList, null, {
        livenessUpdate: { missCount, firstMissedAt, lastCheckedAt: nowIso },
      });
      bumpSkip(`LIVENESS_404_STRIKE_${missCount}`);
    }
  }

  function saveBuiltRecord(built) {
    const entry = built.pluginEntry;
    discoveredById.set(entry.id, entry);
    readmeMetaById[entry.id] = built.readmeMeta || computeReadmeMeta(built);
    writePerPluginReadmeFile(resolvedOutReadmesDir, entry.id, built);
    if (built.fingerprint) {
      fingerprintsById[entry.id] = built.fingerprint;
    }
    if (built.iconArtifact) {
      const iconFile = `${entry.id}${built.iconArtifact.ext}`;
      writeFileSync(join(stateIconsDir, iconFile), built.iconArtifact.sanitizedBuffer);
      writeFileSync(join(iconsDir, iconFile), built.iconArtifact.sanitizedBuffer);
    }
    if (Array.isArray(built.topics) && built.topics.length > 0) {
      validReposTopics.push(built.topics);
    }
    newlyDiscoveredPlugins += 1;
  }

  // Handle cached repos whose Stage-2A heartbeat already resolved unchanged / 404 / ineligible
  for (const [rk, hbNode] of graphqlHeartbeatUnchanged.entries()) {
    processedRepoKeys.add(rk);
    const list = cachedByRepoKey.get(rk) || [];
    const c = candidateByKey.get(rk);
    recordCacheReuse(list, toRestCompatRepoMeta(hbNode), {
      extraSources: c ? [...c.discoverySources] : [],
    });
  }
  for (const rk of graphqlIneligibleKeys) {
    processedRepoKeys.add(rk);
    removedRepoKeys.add(rk);
    negCache.entries[rk] = updateNegativeCacheEntry(negCache.entries[rk], {
      reason: 'ERR_REPO_INELIGIBLE',
      nowMs,
    });
    bumpSkip('ERR_REPO_INELIGIBLE');
  }
  for (const rk of graphqlNotFoundKeys) {
    if (cachedByRepoKey.has(rk)) {
      processedRepoKeys.add(rk);
      handle404OnCachedRepo(rk, cachedByRepoKey.get(rk));
    }
  }

  // Enqueue any cached repos whose Stage-2A heartbeat detected a NEW commitSha (even if not in search candidates)
  for (const [rk, node] of graphqlStage2BNodes.entries()) {
    if (!candidateByKey.has(rk) && cachedByRepoKey.has(rk)) {
      const synth = {
        key: rk,
        fullName: node.fullName,
        repoMeta: toRestCompatRepoMeta(node),
        explicitSubpaths: new Set(),
        subdirGlobs: new Set(),
        isMonorepo: (cachedByRepoKey.get(rk) || []).length > 1,
        maxPlugins: DEFAULT_MAX_PLUGINS_PER_REPO,
        discoverySources: new Set(['heartbeat:recrawl']),
        priority: 40,
      };
      effectiveCandidates.push(synth);
      candidateByKey.set(rk, synth);
    }
  }

  async function processCandidate(candidate) {
    if (processedRepoKeys.has(candidate.key)) return;
    processedRepoKeys.add(candidate.key);

    // Check GraphQL Stage-2A-Novel rejection first (0 Stage-2B, 0 tarball downloads!)
    const triageRej = graphqlTriageRejected.get(candidate.key);
    if (triageRej) {
      bumpSkip(triageRej.reason);
      negCache.entries[candidate.key] = updateNegativeCacheEntry(negCache.entries[candidate.key], {
        repositoryId: triageRej.node?.repositoryId || 0,
        headSha: triageRej.node?.headSha || null,
        pushedAt: triageRej.node?.pushedAt || null,
        reason: triageRej.reason,
        nowMs,
      });
      if (Array.isArray(candidate.repoMeta?.topics) && candidate.repoMeta.topics.length > 0) {
        negReposTopics.push(candidate.repoMeta.topics);
      }
      return;
    }

    if (graphqlNotFoundKeys.has(candidate.key)) {
      bumpSkip('ERR_REPO_NOT_FOUND');
      negCache.entries[candidate.key] = updateNegativeCacheEntry(negCache.entries[candidate.key], {
        repositoryId: 0,
        headSha: null,
        reason: 'ERR_REPO_NOT_FOUND',
        nowMs,
      });
      return;
    }

    // Neg-Cache v2 pre-network gate (skips ALL rejection classes while backoff is active!)
    const existingNeg = negCache.entries[candidate.key];
    if (!ignoreNegCache && !forceRefresh && existingNeg) {
      const preDecision = shouldSkipNegativeCache(existingNeg, {
        nowMs,
        observedPushedAt: candidate.repoMeta?.pushed_at || null,
        validatorVersion: CURRENT_VALIDATOR_VERSION,
        phase: 'pre-network',
      });
      if (preDecision.skip) {
        bumpSkip('NEG_CACHE_HIT');
        return;
      }
    }

    let repoMeta;
    try {
      repoMeta = await resolveRepoMeta(candidate);
    } catch (err) {
      const code = extractErrorCode(err);
      bumpSkip(code);
      if (code === 'ERR_REPO_NOT_FOUND') {
        const prevCached = cachedByRepoKey.get(candidate.key) || [];
        if (prevCached.length > 0) {
          handle404OnCachedRepo(candidate.key, prevCached);
        } else {
          negCache.entries[candidate.key] = updateNegativeCacheEntry(negCache.entries[candidate.key], {
            repositoryId: 0,
            headSha: null,
            reason: code,
            nowMs,
          });
        }
      }
      return;
    }

    if (repoMeta.archived || repoMeta.disabled || repoMeta.is_template || isFirstPartyRepoMeta(repoMeta)) {
      removedRepoKeys.add(candidate.key);
      negCache.entries[candidate.key] = updateNegativeCacheEntry(negCache.entries[candidate.key], {
        repositoryId: Number(repoMeta.id || 0),
        headSha: null,
        pushedAt: repoMeta.pushed_at || null,
        reason: 'ERR_REPO_INELIGIBLE',
        nowMs,
      });
      bumpSkip('ERR_REPO_INELIGIBLE');
      return;
    }

    // Fast skip for known single-plugin Track-1 repositories (preserving Monorepos that may host other subplugins)
    const repoId = Number(repoMeta.id || 0);
    const canonicalKey = String(repoMeta.full_name || candidate.fullName).toLowerCase();
    if (
      !candidate.isMonorepo &&
      candidate.explicitSubpaths.size === 0 &&
      ((repoId > 0 && track1RepoRoots.has(`${repoId}:.`)) || track1RepoUrlRoots.has(`${canonicalKey}:.`))
    ) {
      bumpSkip('SKIP_TRACK1');
      return;
    }

    let snapshot;
    try {
      snapshot = await resolveSnapshot(repoMeta, candidate);
    } catch (err) {
      const code = extractErrorCode(err);
      bumpSkip(code);
      if (code === 'ERR_REPO_NOT_FOUND') {
        const prevCached =
          (repoId > 0 ? cachedByRepoId.get(repoId) : null) || cachedByRepoKey.get(candidate.key) || [];
        if (prevCached.length > 0) {
          handle404OnCachedRepo(candidate.key, prevCached, repoId);
        } else {
          negCache.entries[candidate.key] = updateNegativeCacheEntry(negCache.entries[candidate.key], {
            repositoryId: repoId,
            headSha: null,
            pushedAt: repoMeta.pushed_at || null,
            reason: code,
            nowMs,
          });
        }
      } else if (isTransientErrorCode(code)) {
        const prevList =
          (repoId > 0 ? cachedByRepoId.get(repoId) : null) || cachedByRepoKey.get(candidate.key) || [];
        if (prevList.length > 0) {
          recordCacheReuse(prevList, repoMeta, { extraSources: [...candidate.discoverySources] });
        }
      }
      return;
    }

    // Sync redirected fullName back into repoMeta
    if (snapshot.fullName && snapshot.fullName.toLowerCase() !== String(repoMeta.full_name || '').toLowerCase()) {
      const [newOwner, newName] = snapshot.fullName.split('/');
      repoMeta = {
        ...repoMeta,
        full_name: snapshot.fullName,
        name: newName || repoMeta.name,
        html_url: `https://github.com/${snapshot.fullName}`,
        owner: { ...repoMeta.owner, login: newOwner || repoMeta.owner?.login },
      };
    }

    const updatedCanonicalKey = String(repoMeta.full_name || candidate.fullName).toLowerCase();
    if (
      !candidate.isMonorepo &&
      candidate.explicitSubpaths.size === 0 &&
      track1RepoUrlRoots.has(`${updatedCanonicalKey}:.`)
    ) {
      bumpSkip('SKIP_TRACK1');
      return;
    }

    // Positive cache reuse: skip tarball download when (tarballUrl, commitSha) unchanged
    const cachedList =
      (repoId > 0 ? cachedByRepoId.get(repoId) : null) ||
      cachedByRepoKey.get(updatedCanonicalKey) ||
      cachedByRepoKey.get(candidate.key) ||
      [];
    if (
      !forceRefresh &&
      cachedList.length > 0 &&
      cachedList.every(
        (p) => p.distribution?.tarballUrl === snapshot.tarballUrl && p.commitSha === snapshot.commitSha,
      )
    ) {
      recordCacheReuse(cachedList, repoMeta, { extraSources: [...candidate.discoverySources] });
      return;
    }

    // Neg-Cache v2 post-probe check (skip tarball download when headSha unchanged & validatorVersion current)
    const negEntry = negCache.entries[updatedCanonicalKey] || negCache.entries[candidate.key];
    if (!ignoreNegCache && !forceRefresh && negEntry) {
      const postDecision = shouldSkipNegativeCache(negEntry, {
        nowMs,
        observedHeadSha: snapshot.commitSha,
        observedPushedAt: repoMeta.pushed_at || null,
        validatorVersion: CURRENT_VALIDATOR_VERSION,
        phase: 'post-probe',
      });
      if (postDecision.skip) {
        bumpSkip('NEG_CACHE_HIT');
        return;
      }
    }

    // Budget guard for `--max-new`
    if (maxNew > 0 && newlyValidatedRepos >= maxNew) {
      if (cachedList.length > 0) {
        recordCacheReuse(cachedList, repoMeta, { extraSources: [...candidate.discoverySources] });
      }
      bumpSkip('MAX_NEW_CAP');
      return;
    }

    let tarballBuf;
    try {
      tarballBuf = await downloadTarballBuffer(snapshot.tarballUrl, { fetchImpl, userAgent: USER_AGENT });
    } catch (err) {
      const code = extractErrorCode(err);
      bumpSkip(code);
      if (isTransientErrorCode(code) && cachedList.length > 0) {
        recordCacheReuse(cachedList, repoMeta, { extraSources: [...candidate.discoverySources] });
      }
      return;
    }

    try {
      const tarInfo = await inspectTarGzStream(tarballBuf, { allowExternalSymlinks: true });
      const out = buildTrack2PluginRecordsForArchive({
        repoMeta,
        releaseInfo: {
          tagName: snapshot.tagName,
          commitSha: snapshot.commitSha,
          tarballUrl: snapshot.tarballUrl,
          publishedAt: snapshot.publishedAt || nowIso,
          requireSelfContained: snapshot.requireSelfContained,
        },
        tarballBuffer: tarballBuf,
        tarInfo,
        explicitSubpaths: [...candidate.explicitSubpaths],
        subdirGlobs: [...candidate.subdirGlobs],
        isMonorepo: candidate.isMonorepo,
        maxPlugins: candidate.maxPlugins,
        track1RepoRoots,
        track1RepoUrlRoots,
        discoverySources: [...candidate.discoverySources],
        catalogBaseUrl,
      });

      if (out.records.length > 0) {
        delete negCache.entries[candidate.key];
        delete negCache.entries[updatedCanonicalKey];
        newlyValidatedRepos += 1;
        if (cachedList.length > 0) {
          updatedRepoKeys.add(updatedCanonicalKey);
        }
        if (out.records.length >= 25) {
          discoveryState.saturatedMonorepos[updatedCanonicalKey] = out.records.length;
        }
        for (const built of out.records) {
          saveBuiltRecord(built);
        }
        for (const sk of out.skipped) {
          bumpSkip(`SUBDIR_${sk.code}`);
        }
      } else {
        const primaryCode = out.skipped[0]?.code || 'ERR_NOT_ANTIGRAVITY_PLUGIN';
        bumpSkip(primaryCode);
        revalidatedFailedRepoKeys.add(candidate.key);
        revalidatedFailedRepoKeys.add(updatedCanonicalKey);
        negCache.entries[updatedCanonicalKey] = updateNegativeCacheEntry(negCache.entries[updatedCanonicalKey], {
          repositoryId: repoId,
          headSha: snapshot.commitSha,
          pushedAt: repoMeta.pushed_at || null,
          reason: primaryCode,
          nowMs,
        });
        if (Array.isArray(repoMeta.topics) && repoMeta.topics.length > 0) {
          negReposTopics.push(repoMeta.topics);
        }
      }
    } catch (err) {
      const code = extractErrorCode(err);
      bumpSkip(code);
      if (!isTransientErrorCode(code)) {
        revalidatedFailedRepoKeys.add(candidate.key);
        revalidatedFailedRepoKeys.add(updatedCanonicalKey);
        negCache.entries[updatedCanonicalKey] = updateNegativeCacheEntry(negCache.entries[updatedCanonicalKey], {
          repositoryId: repoId,
          headSha: snapshot.commitSha,
          pushedAt: repoMeta.pushed_at || null,
          reason: code,
          nowMs,
        });
        if (Array.isArray(repoMeta.topics) && repoMeta.topics.length > 0) {
          negReposTopics.push(repoMeta.topics);
        }
      } else if (cachedList.length > 0) {
        recordCacheReuse(cachedList, repoMeta, { extraSources: [...candidate.discoverySources] });
      }
    }
  }

  // Gentle bounded concurrency worker pool
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, concurrency), Math.max(1, effectiveCandidates.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < effectiveCandidates.length) {
        const idx = cursor++;
        await processCandidate(effectiveCandidates[idx]);
      }
    }),
  );

  // DECOUPLED RETENTION (Fixes Silent Eviction Bug!):
  // ALWAYS retain previously valid cached Track-2 entries unless explicitly confirmed evicted
  // (3-strike >=72h 404, archived/disabled/template/first-party, Track-1 graduation, or validation failure on newer commitSha).
  for (const oldEntry of existingCache.plugins || []) {
    if (!oldEntry?.id || discoveredById.has(oldEntry.id)) continue;
    const rk = repoKeyFromUrl(oldEntry.repository?.url);
    if (rk && removedRepoKeys.has(rk)) continue;
    if (rk && revalidatedFailedRepoKeys.has(rk)) continue;
    if (rk && processedRepoKeys.has(rk) && forceRefresh) continue;
    const normRoot = normalizeRelPosix(oldEntry.repository?.pluginRoot || '.');
    const rid = Number(oldEntry.repository?.repositoryId || 0);
    if (track1Ids.has(oldEntry.id)) continue;
    if (rid > 0 && track1RepoRoots.has(`${rid}:${normRoot}`)) continue;
    if (rk && track1RepoUrlRoots.has(`${rk}:${normRoot}`)) continue;

    discoveredById.set(oldEntry.id, {
      ...oldEntry,
      repository: { ...oldEntry.repository, pluginRoot: normRoot },
      taxonomy: maybeUpgradeCachedTaxonomy(oldEntry, null),
      forceScopedInstall: true,
    });
    carryOverReadmeForId(oldEntry.id);
  }

  // Stage 4: 3-Layer Fork, Mirror & Near-Duplicate Deduplication
  const preDedupPlugins = [...discoveredById.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((p) => (fingerprintsById[p.id] ? { ...p, fingerprint: fingerprintsById[p.id] } : p));

  const dedupOut = deduplicateCatalogPlugins(preDedupPlugins, { nowMs });
  if (dedupOut.collapsed.length > 0) {
    skipStats.DEDUP_COLLAPSED = dedupOut.collapsed.length;
  }

  const finalFingerprints = {};
  const finalReadmeMeta = {};
  const discoveredPlugins = dedupOut.canonical
    .map((p) => {
      const copy = { ...p };
      if (copy.fingerprint) {
        finalFingerprints[copy.id] = copy.fingerprint;
        delete copy.fingerprint;
      } else if (fingerprintsById[copy.id]) {
        finalFingerprints[copy.id] = fingerprintsById[copy.id];
      }
      if (readmeMetaById[copy.id]) {
        finalReadmeMeta[copy.id] = readmeMetaById[copy.id];
      }
      return copy;
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  // Prune expired Neg-Cache v2 entries
  const prunedNegEntries = pruneNegativeCacheEntries(negCache.entries, nowMs);

  // Update Bandit posteriors & Topic Co-occurrence miner when search ran
  if (enableSearch && allBanditArmIds.length > 0) {
    const validAfterRun = new Set(discoveredPlugins.map((p) => repoKeyFromUrl(p.repository?.url)).filter(Boolean));
    const filteredArmHits = new Map();
    for (const [armId, repoSet] of armRepoHits.entries()) {
      filteredArmHits.set(
        armId,
        [...repoSet].filter((rk) => validAfterRun.has(rk)),
      );
    }
    const rewards = bandit.computeFractionalAttribution(filteredArmHits, {
      knownValidRepoKeys,
      updatedRepoKeys,
    });
    const pullOutcomes = new Map();
    for (const [armId, cost] of armCosts.entries()) {
      pullOutcomes.set(armId, { reward: rewards.get(armId) || 0, cost, pulls: cost });
    }
    banditState = bandit.updateState(banditState, pullOutcomes, {
      allArmIds: allBanditArmIds,
      nowIso,
    });
    discoveryState.bandit = banditState;

    if (validReposTopics.length > 0) {
      const autoTopics = mineCooccurringTopics({ validReposTopics, negReposTopics });
      for (const at of autoTopics) {
        discoveryState.autoTopics[at.topic] = { ...at, discoveredAt: nowIso };
      }
    }
    discoveryState.updatedAt = nowIso;

    writeFileSync(discoveryStatePath, `${JSON.stringify(discoveryState, null, 2)}\n`, 'utf8');
    writeFileSync(banditStatePath, `${JSON.stringify(banditState, null, 2)}\n`, 'utf8');
  }

  // Persist Storage-Split Track-2 cache (ZERO bulky inline READMEs!), Neg-Cache v2, and compact fingerprints
  writeFileSync(
    cachePath,
    `${JSON.stringify(
      {
        schemaVersion: 2,
        plugins: discoveredPlugins,
        readmeMeta: sortRecordKeys(finalReadmeMeta),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  writeFileSync(
    negCachePath,
    `${JSON.stringify({ schemaVersion: 2, entries: sortRecordKeys(prunedNegEntries) }, null, 2)}\n`,
    'utf8',
  );

  writeFileSync(
    fingerprintsPath,
    `${JSON.stringify({ schemaVersion: 1, fingerprints: sortRecordKeys(finalFingerprints) }, null, 2)}\n`,
    'utf8',
  );

  console.log(
    `[crawl-topics] Summary: candidates=${effectiveCandidates.length}, total=${discoveredPlugins.length}, newPlugins=${newlyDiscoveredPlugins}, reused=${reusedCount}, dedupCollapsed=${dedupOut.collapsed.length}, skipped=${JSON.stringify(sortRecordKeys(skipStats))}`,
  );

  return {
    candidates: effectiveCandidates.length,
    discovered: discoveredPlugins.length,
    newPlugins: newlyDiscoveredPlugins,
    reused: reusedCount,
    dedupCollapsed: dedupOut.collapsed.length,
    skipped: sortRecordKeys(skipStats),
  };
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] || '')).href) {
  const cliOpts = parseCrawlerCliArgs(process.argv.slice(2));
  const out = await crawlExperimentalTopics(cliOpts);
  console.log(`[crawl-topics] Done (${out.discovered} Track-2 plugins in cache)`);
}
