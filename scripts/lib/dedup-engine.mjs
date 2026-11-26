// 3-Layer Fork, Mirror & Near-Duplicate Deduplication Engine (`scripts/lib/dedup-engine.mjs`).
//
// Zero external dependencies; deterministic pure Node.js:
//   - Layer 1: Normalized functional content hash (`computeFunctionalContentHash`)
//   - Layer 2: GitHub fork lineage & meaningful divergence gate (`shouldKeepDivergedFork`)
//   - Layer 3: Lightweight 32-int MinHash fingerprint (`computePluginFingerprint`, guarded by |S| >= 25)
//   - Clustering: Union-Find + Canonical Origin scoring + abandoned-original revival override.

import { createHash } from 'node:crypto';
import { normalizeRelPosix, parseJsonc } from './constants.mjs';

export const DEDUP_ENGINE_VERSION = 1;
export const MINHASH_SIZE = 32;
export const MIN_SHINGLES_FOR_MINHASH = 25;

// Deterministic 32-bit universal hash parameters (odd multipliers + non-zero offsets) for 32 MinHash permutations.
const MINHASH_A = new Uint32Array([
  0x9e3779b1, 0x85ebca77, 0xc2b2ae3d, 0x27d4eb2f, 0x165667b1, 0xd3a2646c, 0xfd7046c5, 0xb55a4f09,
  0x4f1bbcdc, 0x6c8e9cf5, 0xa24baed5, 0x3c6ef373, 0xbb67ae85, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
  0x5be0cd19, 0x243f6a89, 0x13198a2f, 0x03707345, 0xa4093823, 0x299f31d1, 0x082efa99, 0xec4e6c89,
  0x452821e7, 0x38d01377, 0xbe5466cf, 0x34e90c6d, 0xc0ac29b7, 0xc97c50dd, 0x3f84d5b5, 0xb5470917,
]);

const MINHASH_B = new Uint32Array([
  0x2c1b3c6d, 0x297a2d39, 0x7f4a7c15, 0x94d049bb, 0xbf58476d, 0x1ce4e5b9, 0x5851f42d, 0x4c957f2d,
  0x14057b7e, 0xf767814f, 0x6a09e667, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
  0x5be0cd19, 0xd8552e81, 0x993e1d65, 0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b,
  0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74,
]);

const NON_RUNTIME_TEST_RE = /(?:^|\/)(?:test|tests|__tests__|fixtures|mocks)\/|\.(?:test|spec)\.[a-z0-9]+$/i;
const FUNCTIONAL_CODE_RE = /\.(?:mjs|cjs|js|ts|py|sh|ps1|go|rs)$/i;
const MANIFEST_ATTRIBUTION_KEYS = new Set(['author', 'repository', 'homepage', 'version']);

function toUtf8(val) {
  if (typeof val === 'string') return val;
  if (Buffer.isBuffer(val)) return val.toString('utf8');
  return '';
}

function sha256Hex(strOrBuf) {
  return createHash('sha256').update(strOrBuf).digest('hex');
}

function canonicalStableJson(val) {
  if (val === null || typeof val !== 'object') return JSON.stringify(val);
  if (Array.isArray(val)) return `[${val.map(canonicalStableJson).join(',')}]`;
  const keys = Object.keys(val).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStableJson(val[k])}`).join(',')}}`;
}

function normalizeTextLines(raw) {
  return String(raw || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeDescriptionText(desc) {
  const raw =
    typeof desc === 'string'
      ? desc
      : desc && typeof desc === 'object'
        ? String(desc.en || desc.zh || '')
        : '';
  return raw
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function iterScopedEntries(scopedFiles) {
  if (!scopedFiles) return [];
  if (typeof scopedFiles.entries === 'function') {
    return [...scopedFiles.entries()];
  }
  if (typeof scopedFiles === 'object') {
    return Object.entries(scopedFiles);
  }
  return [];
}

/**
 * Layer 1: Computes a canonical SHA-256 hash over functional plugin files inside `pluginRoot`,
 * stripping non-functional manifest attribution/version fields and normalizing line endings.
 */
export function computeFunctionalContentHash(scopedFiles) {
  const entries = iterScopedEntries(scopedFiles);
  if (entries.length === 0) return null;

  const hashedFiles = [];
  for (const [rawRel, rawVal] of entries) {
    const rel = normalizeRelPosix(rawRel);
    if (!rel || rel === '.') continue;
    const lower = rel.toLowerCase();

    const isManifest = rel === 'plugin.json' || rel === '.antigravity-plugin/plugin.json';
    const isJsonConfig =
      rel === 'agy-market.json' ||
      rel === 'mcp_config.json' ||
      rel === 'hooks.json' ||
      rel === 'sidecars.json' ||
      /^sidecars\/[^/]+\/sidecar\.json$/.test(rel);
    const isMarkdownComponent =
      /^skills\/.+\.md$/i.test(rel) || /^rules\/[^/]+\.md$/i.test(rel) || /^agents\/[^/]+\.md$/i.test(rel);
    const isRuntimeCode = FUNCTIONAL_CODE_RE.test(lower) && !NON_RUNTIME_TEST_RE.test(lower);

    if (!isManifest && !isJsonConfig && !isMarkdownComponent && !isRuntimeCode) continue;

    let normalizedPayload = '';
    const text = toUtf8(rawVal);

    if (isManifest) {
      try {
        const parsed = parseJsonc(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const stripped = {};
          for (const [k, v] of Object.entries(parsed)) {
            if (!MANIFEST_ATTRIBUTION_KEYS.has(k)) stripped[k] = v;
          }
          normalizedPayload = canonicalStableJson(stripped);
        } else {
          normalizedPayload = normalizeTextLines(text);
        }
      } catch {
        normalizedPayload = normalizeTextLines(text);
      }
      // Canonicalize `.antigravity-plugin/plugin.json` and `plugin.json` to the same logical slot
      hashedFiles.push(['plugin.json', sha256Hex(normalizedPayload)]);
      continue;
    }

    if (isJsonConfig) {
      try {
        normalizedPayload = canonicalStableJson(parseJsonc(text));
      } catch {
        normalizedPayload = normalizeTextLines(text);
      }
      hashedFiles.push([rel, sha256Hex(normalizedPayload)]);
      continue;
    }

    normalizedPayload = normalizeTextLines(text);
    hashedFiles.push([rel, sha256Hex(normalizedPayload)]);
  }

  if (hashedFiles.length === 0) return null;
  hashedFiles.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const digest = createHash('sha256');
  for (const [rel, h] of hashedFiles) {
    digest.update(`${rel}\0${h}\n`);
  }
  return digest.digest('hex');
}

function tokenizeForShingles(text) {
  const tokens = [];
  const cleaned = String(text || '')
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ');

  // Extract Latin/numeric words and CJK runs
  const parts = cleaned.match(/[a-z0-9]+|[\u3400-\u4dbf\u4e00-\u9fff]+/g) || [];
  for (const part of parts) {
    if (/^[\u3400-\u4dbf\u4e00-\u9fff]+$/.test(part)) {
      if (part.length === 1) {
        tokens.push(part);
      } else {
        for (let i = 0; i < part.length - 1; i++) {
          tokens.push(part.slice(i, i + 2));
        }
      }
    } else if (part.length >= 2) {
      tokens.push(part);
    }
  }
  return tokens;
}

/**
 * Layer 3 (Simplified YAGNI): Computes compact 32-int MinHash fingerprint + functional contentHash.
 * Runs in <1ms per plugin with zero external dependencies.
 */
export function computePluginFingerprint(scopedFiles, meta = {}) {
  const entries = iterScopedEntries(scopedFiles);
  const contentHash = computeFunctionalContentHash(scopedFiles) || meta.contentHash || null;
  const fileSizes = meta.fileSizes && typeof meta.fileSizes.get === 'function' ? meta.fileSizes : null;

  const shingleSet = new Set();
  const textParts = [];
  const normDesc = normalizeDescriptionText(meta.description);
  if (normDesc) textParts.push(normDesc);

  for (const [rawRel, rawVal] of entries) {
    const rel = normalizeRelPosix(rawRel);
    if (!rel || rel === '.') continue;
    const bufLen = fileSizes?.has(rel)
      ? fileSizes.get(rel)
      : Buffer.isBuffer(rawVal)
        ? rawVal.length
        : Buffer.byteLength(String(rawVal || ''), 'utf8');
    const sizeBucket = Math.floor(Math.log2(Math.max(1, bufLen)));

    if (!NON_RUNTIME_TEST_RE.test(rel)) {
      shingleSet.add(`path:${rel.toLowerCase()}:sz${sizeBucket}`);
    }
    const skillMatch = /^skills\/([^/]+)\/SKILL\.md$/.exec(rel);
    if (skillMatch) {
      shingleSet.add(`skill:${skillMatch[1].toLowerCase()}`);
      textParts.push(toUtf8(rawVal).slice(0, 6000));
    } else if (/^rules\/[^/]+\.md$/i.test(rel) || /^agents\/[^/]+\.md$/i.test(rel)) {
      textParts.push(toUtf8(rawVal).slice(0, 4000));
    } else if (/^(?:docs\/)?readme(?:[._-][a-z-]+)?\.md$/i.test(rel)) {
      textParts.push(toUtf8(rawVal).slice(0, 4096));
    }
  }

  if (typeof meta.readmeMarkdown === 'string' && meta.readmeMarkdown.trim() && entries.length === 0) {
    textParts.push(meta.readmeMarkdown.slice(0, 4096));
  }

  // Structural capability tokens
  const caps = meta.capabilities || {};
  for (const s of caps.mcpServers || []) shingleSet.add(`mcp:${String(s).toLowerCase()}`);
  for (const ev of caps.hookEvents || []) shingleSet.add(`hook:${String(ev).toLowerCase()}`);
  for (const b of caps.badges || []) shingleSet.add(`badge:${String(b).toLowerCase()}`);

  const words = tokenizeForShingles(textParts.join(' '));
  const win = words.length >= 10 ? 5 : 3;
  for (let i = 0; i <= words.length - win; i++) {
    shingleSet.add(`w:${words.slice(i, i + win).join('_')}`);
  }
  if (words.length < win) {
    for (const w of words) shingleSet.add(`w:${w}`);
  }

  const minHash = new Uint32Array(MINHASH_SIZE);
  minHash.fill(0xffffffff);
  for (const sh of shingleSet) {
    const base = fnv1a32(sh);
    for (let i = 0; i < MINHASH_SIZE; i++) {
      const hv = (Math.imul(MINHASH_A[i], base) + MINHASH_B[i]) >>> 0;
      if (hv < minHash[i]) minHash[i] = hv;
    }
  }

  return {
    contentHash,
    minHash: shingleSet.size > 0 ? Array.from(minHash) : [],
    shingleCount: shingleSet.size,
    normDescription: normDesc,
  };
}

export function estimateMinHashJaccard(sigA, sigB) {
  if (!Array.isArray(sigA) || !Array.isArray(sigB)) return 0;
  if (sigA.length !== MINHASH_SIZE || sigB.length !== MINHASH_SIZE) return 0;
  let matches = 0;
  for (let i = 0; i < MINHASH_SIZE; i++) {
    if (sigA[i] === sigB[i]) matches += 1;
  }
  return matches / MINHASH_SIZE;
}

/**
 * Layer 2: Evaluates KeepFork(f, p) to decide whether a GitHub fork has diverged meaningfully
 * enough to remain an independent catalog listing instead of collapsing into its parent.
 */
export function shouldKeepDivergedFork(
  forkMeta = {},
  parentMeta = {},
  { aheadBy = 0, contentDivergence = null, jaccard = null, nowMs = Date.now() } = {},
) {
  const forkHash = forkMeta?.contentHash || forkMeta?.fingerprint?.contentHash || null;
  const parentHash = parentMeta?.contentHash || parentMeta?.fingerprint?.contentHash || null;
  if (forkHash && parentHash && forkHash === parentHash) {
    return { keep: false, reason: 'DEDUP_UNEDITED_FORK', divergence: 0 };
  }

  const deltaC =
    typeof contentDivergence === 'number' && Number.isFinite(contentDivergence)
      ? Math.max(0, Math.min(1, contentDivergence))
      : typeof jaccard === 'number' && Number.isFinite(jaccard)
        ? Math.max(0, Math.min(1, 1 - jaccard))
        : 0;

  const ahead = Math.max(0, Number(aheadBy || 0));
  const forkStars = Math.max(0, Number(forkMeta?.stars ?? forkMeta?.repository?.stars ?? 0));
  const parentStars = Math.max(0, Number(parentMeta?.stars ?? parentMeta?.repository?.stars ?? 0));
  const parentArchived = Boolean(parentMeta?.archived || parentMeta?.repository?.archived);

  const parentTs = Date.parse(parentMeta?.pushedAt || parentMeta?.updatedAt || parentMeta?.repository?.pushedAt || '');
  const parentStaleDays = parentArchived
    ? Infinity
    : Number.isFinite(parentTs)
      ? Math.max(0, (nowMs - parentTs) / 86_400_000)
      : 0;

  // 1. Substantial feature divergence / platform port
  if (ahead >= 5 && deltaC >= 0.25) {
    return { keep: true, reason: 'DIVERGED_FEATURE_FORK', divergence: deltaC };
  }
  // 2. Maintained revival of archived or stale (>90d) upstream
  if ((parentArchived || parentStaleDays >= 90) && ahead >= 2 && deltaC >= 0.1) {
    return { keep: true, reason: 'REVIVAL_FORK', divergence: deltaC };
  }
  // 3. Community-adopted fork (>= 2x stars of parent with floor 20)
  if (forkStars >= 2 * Math.max(10, parentStars)) {
    return { keep: true, reason: 'COMMUNITY_ADOPTED_FORK', divergence: deltaC };
  }

  return { keep: false, reason: 'DEDUP_MINOR_FORK', divergence: deltaC };
}

class UnionFind {
  constructor(n) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = new Uint8Array(n);
  }
  find(x) {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return false;
    if (this.rank[ra] < this.rank[rb]) {
      this.parent[ra] = rb;
    } else if (this.rank[ra] > this.rank[rb]) {
      this.parent[rb] = ra;
    } else {
      this.parent[rb] = ra;
      this.rank[ra] += 1;
    }
    return true;
  }
}

function getOwnerFromPlugin(p) {
  const url = String(p?.repository?.url || '');
  const m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)/i.exec(url);
  if (m) return m[1].toLowerCase();
  const id = String(p?.id || '');
  if (id.includes('__')) return id.split('__')[0].toLowerCase();
  return '';
}

function getRepoKeyFromPlugin(p) {
  const rid = Number(p?.repository?.repositoryId || 0);
  if (rid > 0) return `id:${rid}`;
  const url = String(p?.repository?.url || '').toLowerCase().replace(/\/+$/, '');
  if (url) return `url:${url}`;
  return `pid:${p?.id || ''}`;
}

function hasOrgBrandMatch(p) {
  const owner = getOwnerFromPlugin(p);
  if (!owner || owner.length < 3) return false;
  const cname = String(p?.canonicalName || '').toLowerCase();
  const slug = String(p?.id || '').toLowerCase();
  const repoPart = slug.includes('__') ? slug.slice(slug.indexOf('__') + 2).split('--')[0] : '';
  return (
    cname === owner ||
    cname.startsWith(`${owner}-`) ||
    cname.startsWith(owner) ||
    repoPart.startsWith(`${owner}-`) ||
    repoPart.startsWith(owner)
  );
}

function hasStableSemver(p) {
  if (p?.gitTag) return true;
  const v = String(p?.version || '');
  return Boolean(v && !/-git\./i.test(v) && /^\d+\.\d+\.\d+/.test(v));
}

function getStaleDays(p, nowMs) {
  const ts = Date.parse(p?.repository?.pushedAt || p?.updatedAt || '');
  if (!Number.isFinite(ts)) return 365;
  return Math.max(0, (nowMs - ts) / 86_400_000);
}

export function computeOriginScore(plugin, { cluster = [plugin], repoCounts = new Map(), nowMs = Date.now() } = {}) {
  const isTrack1 = plugin?._track === 'verified' || plugin?.track === 'verified' || plugin?.forceScopedInstall === false;
  const normRoot = normalizeRelPosix(plugin?.repository?.pluginRoot || '.');
  const repoCount = repoCounts.get(getRepoKeyFromPlugin(plugin)) || 1;
  const isStandalone = normRoot === '.' || repoCount === 1;
  const isFork = Boolean(plugin?.repository?.isFork || plugin?.isFork);
  const brandMatch = hasOrgBrandMatch(plugin);
  const stars = Math.max(0, Number(plugin?.repository?.stars || 0));
  const semver = hasStableSemver(plugin);
  const staleDays = getStaleDays(plugin, nowMs);

  // Oldest creation rank within cluster (1.0 for oldest, 0.0 for newest).
  // Strictly uses `createdAt`/`registeredAt` (NEVER `updatedAt`, which would penalize freshly maintained plugins!).
  const createdTsList = cluster
    .map((x) => Date.parse(x?.repository?.createdAt || x?.registeredAt || ''))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  const myTs = Date.parse(plugin?.repository?.createdAt || plugin?.registeredAt || '');
  let oldestRank = 0.5;
  if (createdTsList.length > 1 && Number.isFinite(myTs)) {
    const idx = createdTsList.indexOf(myTs);
    oldestRank = 1 - idx / (createdTsList.length - 1);
  } else if (createdTsList.length === 1 && Number.isFinite(myTs)) {
    oldestRank = 1;
  }

  return (
    (isTrack1 ? 1000 : 0) +
    (isStandalone ? 40 : 0) +
    (!isFork ? 30 : 0) +
    (brandMatch ? 25 : 0) +
    20 * oldestRank +
    8 * Math.log(1 + stars) +
    (semver ? 10 : 0) +
    (staleDays <= 90 ? 6 : 0)
  );
}

/**
 * Deduplicates a list of catalog plugins across Layer 1 (contentHash / tarballSha),
 * Layer 2 (GitHub fork lineage + KeepFork divergence gate), and Layer 3 (32-int MinHash).
 *
 * Returns `{ canonical, collapsed, clusters }`.
 */
export function deduplicateCatalogPlugins(
  plugins = [],
  { nowMs = Date.now(), minHashThreshold = 0.82, sameNameMinHashThreshold = 0.72 } = {},
) {
  const list = Array.isArray(plugins) ? plugins : [];
  const n = list.length;
  if (n <= 1) {
    return {
      canonical: list.map((p) => ({ ...p })),
      collapsed: [],
      clusters: list.map((p) => ({ canonicalId: p.id, members: [p.id] })),
    };
  }

  const uf = new UnionFind(n);
  const edgeReason = new Map(); // `${min}:${max}` -> reason
  const setReason = (i, j, reason) => {
    const key = i < j ? `${i}:${j}` : `${j}:${i}`;
    if (!edgeReason.has(key)) edgeReason.set(key, reason);
  };

  const repoCounts = new Map();
  const byRepoId = new Map();
  const byRepoUrl = new Map();
  const byContentHash = new Map();
  const byTarballShaRoot = new Map();
  const byNormDesc = new Map();
  const bandBuckets = new Map(); // 8 bands x 4 ints for O(N) candidate generation on 32-int MinHash

  const normDescs = new Array(n);
  const contentHashes = new Array(n);
  const minHashes = new Array(n);
  const shingleCounts = new Array(n);
  const divergedAnnotations = new Map(); // index -> { forkedFrom, isDivergedFork, forkReason }

  for (let i = 0; i < n; i++) {
    const p = list[i];
    const rk = getRepoKeyFromPlugin(p);
    repoCounts.set(rk, (repoCounts.get(rk) || 0) + 1);

    const rid = Number(p?.repository?.repositoryId || 0);
    if (rid > 0) {
      if (!byRepoId.has(rid)) byRepoId.set(rid, []);
      byRepoId.get(rid).push(i);
    }
    const url = String(p?.repository?.url || '').toLowerCase().replace(/\/+$/, '');
    if (url) {
      if (!byRepoUrl.has(url)) byRepoUrl.set(url, []);
      byRepoUrl.get(url).push(i);
    }

    const fp = p?.fingerprint || {};
    const cHash = fp.contentHash || p?.contentHash || null;
    contentHashes[i] = cHash;
    if (cHash) {
      if (!byContentHash.has(cHash)) byContentHash.set(cHash, []);
      byContentHash.get(cHash).push(i);
    }

    const tarSha = p?.distribution?.sha256 || '';
    const normRoot = normalizeRelPosix(p?.repository?.pluginRoot || '.');
    if (tarSha) {
      const k = `${tarSha}\0${normRoot}`;
      if (!byTarballShaRoot.has(k)) byTarballShaRoot.set(k, []);
      byTarballShaRoot.get(k).push(i);
    }

    const nd = fp.normDescription || normalizeDescriptionText(p?.description);
    normDescs[i] = nd;
    if (nd.length >= 35) {
      if (!byNormDesc.has(nd)) byNormDesc.set(nd, []);
      byNormDesc.get(nd).push(i);
    }

    const mh = Array.isArray(fp.minHash) && fp.minHash.length === MINHASH_SIZE ? fp.minHash : null;
    const sc = Number(fp.shingleCount || 0);
    minHashes[i] = mh;
    shingleCounts[i] = sc;

    if (mh && sc >= MIN_SHINGLES_FOR_MINHASH) {
      for (let b = 0; b < 8; b++) {
        const off = b * 4;
        const bKey = `${b}:${mh[off]}:${mh[off + 1]}:${mh[off + 2]}:${mh[off + 3]}`;
        if (!bandBuckets.has(bKey)) bandBuckets.set(bKey, []);
        bandBuckets.get(bKey).push(i);
      }
    }
  }

  // Layer 2 FIRST: evaluate explicit GitHub fork lineage so meaningfully diverged forks are protected from blind merges
  const protectedDivergedPairs = new Set();
  for (let i = 0; i < n; i++) {
    const p = list[i];
    const isFork = Boolean(p?.repository?.isFork || p?.isFork);
    if (!isFork) continue;

    const parentId = Number(p?.repository?.parentRepoId || p?.parentRepoId || 0);
    const parentFull = String(p?.repository?.parentFullName || p?.parentFullName || '').toLowerCase();
    const parentIndices = [
      ...(parentId > 0 ? byRepoId.get(parentId) || [] : []),
      ...(parentFull ? byRepoUrl.get(`https://github.com/${parentFull}`) || [] : []),
    ];
    if (parentIndices.length === 0) continue;

    const myRoot = normalizeRelPosix(p?.repository?.pluginRoot || '.');
    const myName = String(p?.canonicalName || '').toLowerCase();
    const parentIdx =
      parentIndices.find(
        (pi) =>
          pi !== i &&
          (normalizeRelPosix(list[pi]?.repository?.pluginRoot || '.') === myRoot ||
            String(list[pi]?.canonicalName || '').toLowerCase() === myName),
      ) ?? parentIndices.find((pi) => pi !== i);
    if (parentIdx === undefined) continue;

    const parent = list[parentIdx];
    const jaccard =
      minHashes[i] && minHashes[parentIdx] ? estimateMinHashJaccard(minHashes[i], minHashes[parentIdx]) : null;
    const forkVerdict = shouldKeepDivergedFork(
      {
        stars: p?.repository?.stars,
        pushedAt: p?.repository?.pushedAt || p?.updatedAt,
        contentHash: contentHashes[i],
      },
      {
        stars: parent?.repository?.stars,
        pushedAt: parent?.repository?.pushedAt || parent?.updatedAt,
        archived: parent?.repository?.archived,
        contentHash: contentHashes[parentIdx],
      },
      {
        aheadBy: p?.aheadBy ?? p?.repository?.aheadBy ?? 0,
        jaccard,
        nowMs,
      },
    );

    if (forkVerdict.keep) {
      const pairKey = i < parentIdx ? `${i}:${parentIdx}` : `${parentIdx}:${i}`;
      protectedDivergedPairs.add(pairKey);
      divergedAnnotations.set(i, {
        forkedFrom: parent.id,
        isDivergedFork: true,
        forkReason: forkVerdict.reason,
      });
    } else {
      uf.union(i, parentIdx);
      setReason(i, parentIdx, forkVerdict.reason);
    }
  }

  // Layer 1A: Exact functional content hash
  for (const idxs of byContentHash.values()) {
    if (idxs.length < 2) continue;
    for (let k = 1; k < idxs.length; k++) {
      const a = idxs[0];
      const b = idxs[k];
      if (getRepoKeyFromPlugin(list[a]) === getRepoKeyFromPlugin(list[b]) && list[a].id === list[b].id) continue;
      uf.union(a, b);
      setReason(a, b, 'DEDUP_EXACT_CONTENT_HASH');
    }
  }

  // Layer 1B: Exact tarball SHA-256 across distinct repos for same pluginRoot
  for (const idxs of byTarballShaRoot.values()) {
    if (idxs.length < 2) continue;
    for (let k = 1; k < idxs.length; k++) {
      const a = idxs[0];
      const b = idxs[k];
      if (getRepoKeyFromPlugin(list[a]) === getRepoKeyFromPlugin(list[b])) continue;
      uf.union(a, b);
      setReason(a, b, 'DEDUP_EXACT_TARBALL_SHA');
    }
  }

  // Layer 3A: Exact normalized description matches (>= 35 chars) across distinct repos
  const checkedPairs = new Set();
  const checkPair = (a, b, fromDescBucket = false) => {
    if (a === b) return;
    const pk = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (checkedPairs.has(pk) || protectedDivergedPairs.has(pk)) return;
    checkedPairs.add(pk);

    const pA = list[a];
    const pB = list[b];
    const sameRepo = getRepoKeyFromPlugin(pA) === getRepoKeyFromPlugin(pB);
    const sameName =
      Boolean(pA?.canonicalName) &&
      String(pA.canonicalName).toLowerCase() === String(pB?.canonicalName || '').toLowerCase();
    const bothHaveMinHash =
      Boolean(minHashes[a] && minHashes[b] && shingleCounts[a] >= MIN_SHINGLES_FOR_MINHASH && shingleCounts[b] >= MIN_SHINGLES_FOR_MINHASH);
    const jaccard = bothHaveMinHash ? estimateMinHashJaccard(minHashes[a], minHashes[b]) : null;

    if (bothHaveMinHash) {
      if (jaccard >= minHashThreshold) {
        uf.union(a, b);
        setReason(a, b, 'DEDUP_MINHASH_NEAR_DUP');
        return;
      }
      if (jaccard >= sameNameMinHashThreshold && sameName) {
        uf.union(a, b);
        setReason(a, b, 'DEDUP_MINHASH_SAME_NAME');
        return;
      }
    }

    if (fromDescBucket && !sameRepo) {
      if (!bothHaveMinHash || jaccard >= 0.55) {
        uf.union(a, b);
        setReason(a, b, 'DEDUP_IDENTICAL_DESCRIPTION');
      }
    }
  };

  for (const idxs of byNormDesc.values()) {
    if (idxs.length < 2) continue;
    for (let x = 0; x < idxs.length; x++) {
      for (let y = x + 1; y < idxs.length; y++) {
        checkPair(idxs[x], idxs[y], true);
      }
    }
  }

  // Layer 3B: 32-int MinHash candidate pairs (bucket pre-filter + small-N direct fallback when N <= 1500)
  for (const idxs of bandBuckets.values()) {
    if (idxs.length < 2) continue;
    for (let x = 0; x < idxs.length; x++) {
      for (let y = x + 1; y < idxs.length; y++) {
        checkPair(idxs[x], idxs[y], false);
      }
    }
  }
  if (n <= 1500) {
    const validMhIndices = [];
    for (let i = 0; i < n; i++) {
      if (minHashes[i] && shingleCounts[i] >= MIN_SHINGLES_FOR_MINHASH) validMhIndices.push(i);
    }
    for (let x = 0; x < validMhIndices.length; x++) {
      for (let y = x + 1; y < validMhIndices.length; y++) {
        checkPair(validMhIndices[x], validMhIndices[y], false);
      }
    }
  }

  // Assemble clusters & pick canonical winner per cluster
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = uf.find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }

  const canonical = [];
  const collapsed = [];
  const clusters = [];

  for (const memberIndices of groups.values()) {
    const members = memberIndices.map((idx) => list[idx]);
    if (members.length === 1) {
      const idx = memberIndices[0];
      const ann = divergedAnnotations.get(idx);
      const outItem = ann ? { ...members[0], lineage: { ...(members[0].lineage || {}), ...ann } } : { ...members[0] };
      canonical.push(outItem);
      clusters.push({ canonicalId: outItem.id, members: [outItem.id] });
      continue;
    }

    const scored = memberIndices
      .map((idx) => ({
        idx,
        plugin: list[idx],
        originScore: computeOriginScore(list[idx], { cluster: members, repoCounts, nowMs }),
      }))
      .sort((a, b) => b.originScore - a.originScore || String(a.plugin.id).localeCompare(String(b.plugin.id)));

    let winner = scored[0];
    let supersededId = null;

    // Abandoned-original override: if winner is archived or stale > 180d, promote active maintained member
    const winnerArchived = Boolean(winner.plugin?.repository?.archived);
    const winnerStaleDays = getStaleDays(winner.plugin, nowMs);
    const winnerIsTrack1 =
      winner.plugin?._track === 'verified' || winner.plugin?.track === 'verified' || winner.plugin?.forceScopedInstall === false;

    if (!winnerIsTrack1 && (winnerArchived || winnerStaleDays > 180)) {
      const revival = scored.slice(1).find((cand) => {
        const cArchived = Boolean(cand.plugin?.repository?.archived);
        const cStale = getStaleDays(cand.plugin, nowMs);
        const cStars = Math.max(0, Number(cand.plugin?.repository?.stars || 0));
        const cAhead = Number(cand.plugin?.aheadBy ?? cand.plugin?.repository?.aheadBy ?? 0);
        const cIsFork = Boolean(cand.plugin?.repository?.isFork || cand.plugin?.isFork);
        return !cArchived && cStale <= 60 && cStars >= 10 && (!cIsFork || cAhead >= 5);
      });
      if (revival) {
        supersededId = winner.plugin.id;
        winner = revival;
      }
    }

    const winnerAnn = divergedAnnotations.get(winner.idx);
    const winnerLineage = {
      ...(winner.plugin.lineage || {}),
      ...(winnerAnn || {}),
      ...(supersededId ? { supersedes: supersededId } : {}),
      collapsedMirrors: memberIndices.length - 1,
    };
    const canonicalEntry = {
      ...winner.plugin,
      lineage: winnerLineage,
    };
    canonical.push(canonicalEntry);

    for (const item of scored) {
      if (item.idx === winner.idx) continue;
      const pk = item.idx < winner.idx ? `${item.idx}:${winner.idx}` : `${winner.idx}:${item.idx}`;
      collapsed.push({
        id: item.plugin.id,
        canonicalId: winner.plugin.id,
        reason: edgeReason.get(pk) || 'DEDUP_CLUSTER_COLLAPSED',
      });
    }

    clusters.push({
      canonicalId: winner.plugin.id,
      members: scored.map((s) => s.plugin.id),
      ...(supersededId ? { supersedes: supersededId } : {}),
    });
  }

  return { canonical, collapsed, clusters };
}
