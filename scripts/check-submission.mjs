#!/usr/bin/env node
// Tier-2 Fork-Safe Admission & Anti-Collision / RepoJacking Gate (`scripts/check-submission.mjs`).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildSourceArchiveUrl,
  BUILTIN_AGENTS,
  BUILTIN_SKILLS,
  compareSemver,
  FIRST_PARTY_REPO_OWNERS,
  levenshteinDistance,
  MIN_AGE_MS,
  MIN_NON_EMPTY_COMMITS,
  OFFICIAL_MARKET_CLIENT_REPO,
  parseSemver,
  RESERVED_PLUGIN_NAMES,
} from './lib/constants.mjs';
import { fetchWithLimit, TARBALL_FETCH_TIMEOUT_MS } from './lib/discovery-sources.mjs';
import { inspectTarGzStream } from './lib/tar-stream.mjs';
import { validateSingleEntryFile } from './validate-entries.mjs';
import { validatePluginTarball } from './validate-plugin-tarball.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

export function countDistinctCommitTrees(commits = []) {
  const trees = new Set();
  for (const c of commits) {
    const sha = c?.commit?.tree?.sha || c?.tree?.sha || c?.treeSha || '';
    if (typeof sha === 'string' && sha.length >= 7) {
      trees.add(sha);
    }
  }
  return trees.size;
}

/**
 * Pure deterministic evaluator for Track-1 PR admission & scheduled `regate.yml` re-evaluation.
 * Mutates cloned copies of `ledger` and `versionsLock` and returns `{ status, ... }`.
 */
export function evaluateSubmission({
  entry,
  repoMeta,
  commits = [],
  releaseInfo,
  tarballBuffer,
  tarInfo = null,
  ledger,
  versionsLock,
  nowMs = Date.now(),
}) {
  if (!repoMeta || typeof repoMeta.id !== 'number' || !repoMeta.owner || typeof repoMeta.owner.id !== 'number') {
    throw new Error('ERR_REPO_NOT_FOUND: GitHub repository metadata missing numeric id / owner.id');
  }
  if (repoMeta.archived) {
    throw new Error('ERR_REPO_ARCHIVED: Archived repositories cannot be admitted to Track 1');
  }
  if (repoMeta.disabled) {
    throw new Error('ERR_REPO_DISABLED: Disabled repositories cannot be admitted');
  }
  if (
    repoMeta.fork &&
    repoMeta.parent?.owner?.login &&
    FIRST_PARTY_REPO_OWNERS.has(String(repoMeta.parent.owner.login).toLowerCase())
  ) {
    throw new Error('ERR_FIRST_PARTY_FORK: Direct forks of official Google / Antigravity repos are not eligible');
  }

  // Anti-empty-commit spam check (>= 3 commits with distinct root Git tree SHA)
  const distinctTrees = countDistinctCommitTrees(commits);
  if (distinctTrees < MIN_NON_EMPTY_COMMITS) {
    throw new Error(
      `ERR_INSUFFICIENT_COMMITS: Repository requires >= ${MIN_NON_EMPTY_COMMITS} commits with distinct Git tree hashes (found ${distinctTrees})`,
    );
  }

  if (!releaseInfo || !releaseInfo.tagName || !releaseInfo.tarballUrl || !Buffer.isBuffer(tarballBuffer)) {
    throw new Error(
      'ERR_MISSING_PREBUILT_RELEASE: At least one published GitHub Release with a prebuilt .tar.gz / .tgz bundle is required',
    );
  }
  if (!/^[0-9a-f]{40}$/i.test(String(releaseInfo.commitSha || ''))) {
    throw new Error('ERR_INVALID_COMMIT_SHA: Release tag must resolve to a 40-hex Git commit SHA');
  }

  // Stream-validate tarball, 10-field plugin.json, logo, and 4-layer capability scanner
  const inspected = validatePluginTarball(tarballBuffer, {
    pluginRoot: entry.pluginRoot || '.',
    allowScopedName: false,
    fallbackVersion: releaseInfo.tagName,
    requireSelfContained: Boolean(releaseInfo.requireSelfContained),
    tarInfo,
  });

  const canonicalName = inspected.manifest.name;
  const fullRepoLower = String(repoMeta.full_name || entry.repoFullName || '').toLowerCase();
  const isOfficialSelfClient = canonicalName === 'agy-market' && fullRepoLower === OFFICIAL_MARKET_CLIENT_REPO;

  // Reserved system & official denylist
  if (RESERVED_PLUGIN_NAMES.has(canonicalName) && !isOfficialSelfClient) {
    throw new Error(`ERR_RESERVED_NAME: "${canonicalName}" is reserved by Antigravity or official Agent Marketplace`);
  }

  const nextLedger = structuredClone(ledger || { schemaVersion: 1, entries: {} });
  const nextLocks = structuredClone(versionsLock || { schemaVersion: 1, locks: {} });
  const warnings = [];

  // Check RepoJacking on existing entrySlug if updating an existing submission
  for (const existing of Object.values(nextLedger.entries)) {
    if (existing.entrySlug === entry.entrySlug && existing.repositoryId !== repoMeta.id) {
      throw new Error(
        `ERR_REPOJACKING_BLOCKED: "${entry.entrySlug}" is bound to repositoryId=${existing.repositoryId}, got ${repoMeta.id}`,
      );
    }
  }

  // Global canonicalName uniqueness check
  const existingClaim = nextLedger.entries[canonicalName];
  if (existingClaim && existingClaim.repositoryId !== repoMeta.id) {
    throw new Error(
      `ERR_NAME_COLLISION: "${canonicalName}" is already claimed by ${existingClaim.repoFullName} (repositoryId=${existingClaim.repositoryId})`,
    );
  }

  // Typosquatting check (Levenshtein == 1 against other active canonical names)
  for (const otherName of Object.keys(nextLedger.entries)) {
    if (otherName === canonicalName) continue;
    if (levenshteinDistance(canonicalName, otherName) === 1) {
      warnings.push(`WARN_TYPOSQUAT_SUSPECT: "${canonicalName}" is 1 edit away from "${otherName}"`);
    }
  }

  // Sub-component collision checks
  if (inspected.components.genericMcpViolations.length > 0) {
    throw new Error(
      `ERR_GENERIC_MCP_NAME: Avoid generic mcp_config.json server keys (${inspected.components.genericMcpViolations.join(', ')}); prefix or scope them clearly`,
    );
  }

  const otherClaimedSkills = new Map();
  const otherClaimedAgents = new Map();
  for (const [k, rec] of Object.entries(nextLedger.entries)) {
    if (rec.repositoryId === repoMeta.id || rec.status !== 'active') continue;
    for (const sk of rec.claimedSkills || []) otherClaimedSkills.set(sk, k);
    for (const ag of rec.claimedAgents || []) otherClaimedAgents.set(ag, k);
  }

  const skillNames = [];
  for (const sk of inspected.components.claimedSkills) {
    if (sk.frontmatterName !== sk.dir) {
      throw new Error(
        `ERR_SKILL_NAME_MISMATCH: skills/${sk.dir}/SKILL.md frontmatter name "${sk.frontmatterName}" must equal directory "${sk.dir}"`,
      );
    }
    if (BUILTIN_SKILLS.has(sk.dir)) {
      throw new Error(`ERR_RESERVED_SKILL_NAME: Skill "${sk.dir}" collides with a built-in Antigravity skill`);
    }
    if (otherClaimedSkills.has(sk.dir)) {
      throw new Error(
        `ERR_SKILL_COLLISION: Skill "${sk.dir}" is already claimed by Track-1 plugin "${otherClaimedSkills.get(sk.dir)}"`,
      );
    }
    skillNames.push(sk.dir);
  }

  for (const ag of inspected.components.claimedAgents) {
    if (BUILTIN_AGENTS.has(ag)) {
      throw new Error(`ERR_RESERVED_AGENT_NAME: Subagent "${ag}" collides with a built-in Antigravity subagent`);
    }
    if (otherClaimedAgents.has(ag)) {
      throw new Error(
        `ERR_AGENT_COLLISION: Subagent "${ag}" is already claimed by Track-1 plugin "${otherClaimedAgents.get(ag)}"`,
      );
    }
  }

  // Tag / digest immutability check against versions-lock.json
  const existingLock = nextLocks.locks[entry.entrySlug];
  if (existingLock?.versions?.[inspected.version]) {
    const prevVer = existingLock.versions[inspected.version];
    if (prevVer.commitSha !== releaseInfo.commitSha || prevVer.sha256 !== inspected.sha256) {
      throw new Error(
        `ERR_TAG_MUTATION_BLOCKED: Version ${inspected.version} (${releaseInfo.tagName}) mutated commitSha or tarball sha256`,
      );
    }
  }

  // Cold-start repo age check (`MIN_AGE_DAYS = 1`, evaluated LAST so young repos get full validation feedback + pending label)
  const createdMs = Date.parse(repoMeta.created_at);
  if (!Number.isFinite(createdMs)) {
    throw new Error('ERR_REPO_CREATED_AT: Missing valid created_at timestamp on GitHub repository');
  }
  const ageMs = nowMs - createdMs;
  if (ageMs < MIN_AGE_MS && !isOfficialSelfClient) {
    const unlockAtUtc = new Date(createdMs + MIN_AGE_MS).toISOString();
    return {
      status: 'PENDING_REPO_AGE',
      unlockAtUtc,
      remainingMs: MIN_AGE_MS - ageMs,
      canonicalName,
      warnings,
      inspected,
    };
  }

  const nowIso = new Date(nowMs).toISOString();
  nextLedger.entries[canonicalName] = {
    entrySlug: entry.entrySlug,
    canonicalName,
    repositoryId: repoMeta.id,
    ownerId: repoMeta.owner.id,
    repoFullName: repoMeta.full_name || entry.repoFullName,
    pluginRoot: entry.pluginRoot || '.',
    status: 'active',
    claimedSkills: skillNames.sort(),
    claimedAgents: [...inspected.components.claimedAgents],
    claimedMcpServers: [...inspected.capabilities.mcpServers],
    registeredAt: existingClaim?.registeredAt || nowIso,
  };

  const prevVersions = existingLock?.versions || {};
  nextLocks.locks[entry.entrySlug] = {
    latest: inspected.version,
    versions: {
      ...prevVersions,
      [inspected.version]: {
        gitTag: releaseInfo.tagName,
        commitSha: releaseInfo.commitSha,
        tarballUrl: releaseInfo.tarballUrl,
        sha256: inspected.sha256,
        sizeBytes: inspected.sizeBytes,
        publishedAt: releaseInfo.publishedAt || nowIso,
        manifest: inspected.manifest,
        companion: inspected.companion,
        capabilities: inspected.capabilities,
        stars: Number(repoMeta.stargazers_count || 0),
        readmeMarkdown: inspected.readmeMarkdown,
        readmeZhMarkdown: inspected.readmeZhMarkdown || '',
        readmeEnMarkdown: inspected.readmeEnMarkdown || '',
        iconExt: inspected.iconArtifact?.ext || null,
      },
    },
  };

  return {
    status: 'APPROVED',
    canonicalName,
    warnings,
    inspected,
    ledger: nextLedger,
    versionsLock: nextLocks,
  };
}

async function githubFetchJson(url, token = '') {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'agy-market-catalog-gate/1.0',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} for ${url}`);
  }
  return res.json();
}

async function resolveLiveReleaseCandidate(repoFullName, releaseAsset, token = '') {
  try {
    const release = await githubFetchJson(`https://api.github.com/repos/${repoFullName}/releases/latest`, token);
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const chosenAsset = releaseAsset
      ? assets.find((a) => a.name === releaseAsset)
      : assets.find((a) => /\.(?:tar\.gz|tgz)$/i.test(a.name));
    if (releaseAsset && !chosenAsset) {
      throw new Error(
        `ERR_NO_RELEASE_TARBALL: Release ${release.tag_name} is missing specified asset "${releaseAsset}"`,
      );
    }
    const tagRef = await githubFetchJson(
      `https://api.github.com/repos/${repoFullName}/commits/${encodeURIComponent(release.tag_name)}`,
      token,
    );
    return {
      tagName: release.tag_name,
      commitSha: tagRef.sha,
      tarballUrl: chosenAsset
        ? chosenAsset.browser_download_url
        : buildSourceArchiveUrl(repoFullName, tagRef.sha, release.tag_name),
      publishedAt: release.published_at,
      requireSelfContained: !chosenAsset,
    };
  } catch (err) {
    if (releaseAsset || !/GitHub API 404/i.test(String(err?.message))) {
      throw err;
    }
  }

  const tags = await githubFetchJson(`https://api.github.com/repos/${repoFullName}/tags?per_page=30`, token);
  const semverTags = (Array.isArray(tags) ? tags : [])
    .filter((t) => {
      const sem = parseSemver(t?.name);
      return sem && sem.prerelease.length === 0;
    })
    .sort((a, b) => compareSemver(b.name, a.name));

  if (semverTags.length === 0) {
    throw new Error(`ERR_NO_RELEASE_TARBALL: Repository ${repoFullName} has no published GitHub Release or SemVer tag`);
  }

  const bestTag = semverTags[0];
  const commitInfo = await githubFetchJson(
    `https://api.github.com/repos/${repoFullName}/commits/${encodeURIComponent(bestTag.name)}`,
    token,
  );
  return {
    tagName: bestTag.name,
    commitSha: commitInfo.sha,
    tarballUrl: buildSourceArchiveUrl(repoFullName, commitInfo.sha, bestTag.name),
    publishedAt: commitInfo?.commit?.committer?.date || commitInfo?.commit?.author?.date || new Date().toISOString(),
    requireSelfContained: true,
  };
}

export async function runLiveSubmissionCheck(entryFilePath, { writeState = false } = {}) {
  const token = process.env.GITHUB_TOKEN || '';
  const rawYaml = readFileSync(entryFilePath, 'utf8');
  const entry = validateSingleEntryFile(entryFilePath, rawYaml);

  const repoMeta = await githubFetchJson(`https://api.github.com/repos/${entry.repoFullName}`, token);
  const commits = await githubFetchJson(`https://api.github.com/repos/${entry.repoFullName}/commits?per_page=15`, token);
  const resolvedRel = await resolveLiveReleaseCandidate(entry.repoFullName, entry.releaseAsset, token);

  const tarRes = await fetchWithLimit(resolvedRel.tarballUrl, {
    headers: { 'User-Agent': 'agy-market-catalog-gate/1.0' },
    maxBytes: 0,
    timeoutMs: TARBALL_FETCH_TIMEOUT_MS,
    stallTimeoutMs: TARBALL_FETCH_TIMEOUT_MS,
  });
  if (!tarRes.ok) {
    throw new Error(`Failed to download release asset: HTTP ${tarRes.status}`);
  }
  const tarballBuffer = tarRes.buffer;
  const tarInfo = await inspectTarGzStream(tarballBuffer);

  const ledgerPath = join(REPO_ROOT, 'state', 'ledger.json');
  const lockPath = join(REPO_ROOT, 'state', 'versions-lock.json');
  const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : { schemaVersion: 1, entries: {} };
  const versionsLock = existsSync(lockPath)
    ? JSON.parse(readFileSync(lockPath, 'utf8'))
    : { schemaVersion: 1, locks: {} };

  const outcome = evaluateSubmission({
    entry,
    repoMeta,
    commits,
    releaseInfo: resolvedRel,
    tarballBuffer,
    tarInfo,
    ledger,
    versionsLock,
  });

  if (writeState && outcome.status === 'APPROVED') {
    writeFileSync(ledgerPath, `${JSON.stringify(outcome.ledger, null, 2)}\n`, 'utf8');
    writeFileSync(lockPath, `${JSON.stringify(outcome.versionsLock, null, 2)}\n`, 'utf8');
    if (outcome.inspected?.iconArtifact) {
      const stateIconsDir = join(REPO_ROOT, 'state', 'icons');
      const distIconsDir = join(REPO_ROOT, 'dist', 'icons');
      mkdirSync(stateIconsDir, { recursive: true });
      mkdirSync(distIconsDir, { recursive: true });
      const iconName = `${entry.entrySlug}${outcome.inspected.iconArtifact.ext}`;
      writeFileSync(join(stateIconsDir, iconName), outcome.inspected.iconArtifact.sanitizedBuffer);
      writeFileSync(join(distIconsDir, iconName), outcome.inspected.iconArtifact.sanitizedBuffer);
    }
  }

  return outcome;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] || '')).href) {
  const args = process.argv.slice(2);
  const writeState = args.includes('--write-state');
  const files = args.filter((a) => !a.startsWith('--'));
  if (files.length === 0) {
    console.log('Usage: node scripts/check-submission.mjs [--write-state] <data/plugins/owner__repo.yml...>');
    process.exit(0);
  }
  for (const f of files) {
    const res = await runLiveSubmissionCheck(resolve(f), { writeState });
    console.log(JSON.stringify({ file: f, status: res.status, canonicalName: res.canonicalName, unlockAtUtc: res.unlockAtUtc || null, warnings: res.warnings }));
    if (res.status === 'PENDING_REPO_AGE') {
      process.exitCode = 78; // neutral/pending exit code for workflow_run handler
    }
  }
}
