// Adaptive Discovery Algorithms (`scripts/lib/adaptive-discovery.mjs`).
//
// Zero-dependency ESM implementation of P0 + P1 upstream discovery algorithms:
//   1. `AdaptiveRangeSlicer`: dyadic `pushed:` ISO-8601 seconds bisection -> `stars:` -> separate `sizeClause`
//      with persisted `state/discovery-state.json` watermarks and resumable `startPage` (zero infinite loops / zero dropped pages).
//   2. `DiscountedUcb1Cost`: deterministic non-stationary budgeted bandit (`gamma=0.92`, 15% anti-starvation floor,
//      2-empty-page early-stop, fractional `1/k(r)` attribution).
//   3. Validated Code Search flat fingerprints (>=1 text term + dir-only `path:`), dynamic `-repo:` exclusions
//      capped at `<= 250` chars, and `CodeSearchPacer` (sleeps on reset / 429; disables only on 401 / non-RL 403).
//   4. 1-hop README link frontier (`indeg >= 2 || agy_slug`) + auto-aggregator promotion (`>= 8` validated AGY links),
//      npm Search bridge (`registry.npmjs.org/-/v1/search`), Topic Co-occurrence auto-arm miner (`p_hat >= 0.40 && c_V >= 3`),
//      and Neg-Cache v2 activity-aware exponential backoff + tiered positive recrawl scheduler.

import { FIRST_PARTY_REPO_OWNERS, normalizeRelPosix } from './constants.mjs';
import {
  extractGitHubCandidatesFromMarkdown,
  parseSafeGitHubCandidateUrl,
} from './discovery-sources.mjs';

export const DISCOVERY_STATE_SCHEMA_VERSION = 1;
export const CURRENT_VALIDATOR_VERSION = 3;

export const SLICER_N_SAFE = 900;
export const SLICER_MIN_SPAN_MS = 3_600_000; // 1 hour
export const SLICER_OVERLAP_MS = 900_000; // 15 minutes
export const SLICER_DEFAULT_EPOCH_MS = Date.parse('2025-01-01T00:00:00Z');

export const SLICER_STAR_BUCKETS = Object.freeze([
  'stars:0',
  'stars:1..2',
  'stars:3..10',
  'stars:>10',
]);

export const SLICER_SIZE_BUCKETS = Object.freeze([
  'size:<100',
  'size:100..1000',
  'size:>1000',
]);

const EXTENDED_FIRST_PARTY_OWNERS = new Set([
  ...FIRST_PARTY_REPO_OWNERS,
  'google-labs-code',
  'googlecloudplatform',
]);

const README_NOISE_OWNERS = new Set([
  ...EXTENDED_FIRST_PARTY_OWNERS,
  'anthropics',
  'modelcontextprotocol',
  'openai',
  'microsoft',
  'vercel',
  'nodejs',
  'facebook',
  'meta-llama',
  'huggingface',
  'langchain-ai',
  'docker',
  'kubernetes',
  'actions',
  'github',
]);

const GENERIC_NOISE_TOPICS = new Set([
  'ai',
  'llm',
  'llms',
  'agent',
  'agents',
  'ai-agent',
  'ai-agents',
  'mcp',
  'mcp-server',
  'cli',
  'plugin',
  'plugins',
  'extension',
  'extensions',
  'typescript',
  'javascript',
  'python',
  'nodejs',
  'node',
  'rust',
  'go',
  'golang',
  'tools',
  'devtools',
  'developer-tools',
  'automation',
  'productivity',
  'gemini',
  'claude',
  'claude-code',
  'cursor',
  'codex',
  'vscode',
  'chatgpt',
  'openai',
  'anthropic',
  'copilot',
  'open-source',
  'hacktoberfest',
]);

const AGY_SLUG_RE = /(?:antigravity|\bagy[-_]|gemini[-_]?plugin)/i;
const OWNER_REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

function sleepDefault(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toIsoSeconds(ms) {
  return new Date(Math.floor(ms)).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function deterministicHash32(str) {
  let h = 2166136261;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ============================================================================
// 1. Discovery State & AdaptiveRangeSlicer
// ============================================================================

export function createDefaultDiscoveryState() {
  return {
    schemaVersion: DISCOVERY_STATE_SCHEMA_VERSION,
    runCount: 0,
    watermarks: {},
    pendingIntervals: {},
    bandit: {
      gamma: 0.92,
      arms: {},
    },
    autoTopics: {},
    discoveredAggregators: {},
    saturatedMonorepos: {},
    updatedAt: null,
  };
}

export function normalizeDiscoveryState(raw) {
  const base = createDefaultDiscoveryState();
  if (!raw || typeof raw !== 'object') return base;
  return {
    schemaVersion: DISCOVERY_STATE_SCHEMA_VERSION,
    runCount: Number.isFinite(Number(raw.runCount)) ? Math.max(0, Math.floor(Number(raw.runCount))) : 0,
    watermarks: raw.watermarks && typeof raw.watermarks === 'object' ? { ...raw.watermarks } : {},
    pendingIntervals: raw.pendingIntervals && typeof raw.pendingIntervals === 'object' ? structuredClone(raw.pendingIntervals) : {},
    bandit: {
      gamma: Number.isFinite(Number(raw.bandit?.gamma)) ? Number(raw.bandit.gamma) : 0.92,
      arms: raw.bandit?.arms && typeof raw.bandit.arms === 'object' ? structuredClone(raw.bandit.arms) : {},
    },
    autoTopics: raw.autoTopics && typeof raw.autoTopics === 'object' ? structuredClone(raw.autoTopics) : {},
    discoveredAggregators:
      raw.discoveredAggregators && typeof raw.discoveredAggregators === 'object'
        ? structuredClone(raw.discoveredAggregators)
        : {},
    saturatedMonorepos:
      raw.saturatedMonorepos && typeof raw.saturatedMonorepos === 'object' ? structuredClone(raw.saturatedMonorepos) : {},
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  };
}

export function composeSlicedRepoQuery(baseQuery, segment) {
  const parts = [String(baseQuery || '').trim()];
  if (Number.isFinite(segment.loMs) && Number.isFinite(segment.hiMs)) {
    parts.push(`pushed:${toIsoSeconds(segment.loMs)}..${toIsoSeconds(segment.hiMs)}`);
  }
  if (segment.starClause) parts.push(segment.starClause.trim());
  if (segment.sizeClause) parts.push(segment.sizeClause.trim());
  return parts.filter(Boolean).join(' ');
}

export class AdaptiveRangeSlicer {
  constructor({
    nSafe = SLICER_N_SAFE,
    minSpanMs = SLICER_MIN_SPAN_MS,
    overlapMs = SLICER_OVERLAP_MS,
    defaultEpochMs = SLICER_DEFAULT_EPOCH_MS,
    perPage = 100,
    stopAfterEmptyPages = 2,
  } = {}) {
    this.nSafe = Math.max(100, Math.min(999, Math.floor(nSafe)));
    this.minSpanMs = Math.max(1000, Math.floor(minSpanMs));
    this.overlapMs = Math.max(0, Math.floor(overlapMs));
    this.defaultEpochMs = defaultEpochMs;
    this.perPage = Math.max(1, Math.min(100, Math.floor(perPage)));
    this.stopAfterEmptyPages = Math.max(0, Math.floor(stopAfterEmptyPages));
  }

  /**
   * Prepares or updates the LIFO interval stack for `queryId` in `discoveryState`:
   *   - Incremental mode (watermark exists): pushes `[watermark - overlapMs, nowMs]` onto top of stack.
   *   - Cold start (no watermark): pushes `[epochMs, nowMs]`.
   *   - Optional `backfill`: pushes `[epochMs, watermark]` at the bottom of the stack if stack is empty.
   */
  planQueryStack(queryId, discoveryState, { nowMs = Date.now(), epochMs = this.defaultEpochMs, backfill = false } = {}) {
    const existingStack = Array.isArray(discoveryState?.pendingIntervals?.[queryId])
      ? discoveryState.pendingIntervals[queryId].map((seg) => ({
          loMs: Number(seg.loMs),
          hiMs: Number(seg.hiMs),
          starClause: String(seg.starClause || ''),
          sizeClause: String(seg.sizeClause || ''),
          startPage: Math.max(1, Math.floor(Number(seg.startPage || 1))),
          isIncremental: Boolean(seg.isIncremental),
        }))
      : [];

    const wmIso = discoveryState?.watermarks?.[queryId];
    const wmMs = wmIso && !Number.isNaN(Date.parse(wmIso)) ? Date.parse(wmIso) : null;

    if (wmMs === null) {
      if (existingStack.length === 0) {
        existingStack.push({
          loMs: epochMs,
          hiMs: nowMs,
          starClause: '',
          sizeClause: '',
          startPage: 1,
          isIncremental: true,
        });
      }
      return existingStack;
    }

    if (backfill && existingStack.length === 0 && wmMs > epochMs) {
      existingStack.push({
        loMs: epochMs,
        hiMs: wmMs,
        starClause: '',
        sizeClause: '',
        startPage: 1,
        isIncremental: false,
      });
    }

    const incLo = Math.max(epochMs, wmMs - this.overlapMs);
    if (nowMs > incLo) {
      // Avoid stacking duplicate incremental windows if previous run already left one on top
      const top = existingStack[existingStack.length - 1];
      if (top && top.isIncremental && top.startPage === 1 && !top.starClause && !top.sizeClause) {
        top.hiMs = Math.max(top.hiMs, nowMs);
      } else {
        existingStack.push({
          loMs: incLo,
          hiMs: nowMs,
          starClause: '',
          sizeClause: '',
          startPage: 1,
          isIncremental: true,
        });
      }
    }

    return existingStack;
  }

  /**
   * Executes adaptive recursive range partitioning for a single Repo Search query arm.
   * `fetchPageFn(queryString, page, perPage)` must return `{ ok, rateLimited, totalCount, items }`.
   */
  async runQuery({
    queryId,
    baseQuery,
    discoveryState,
    pageBudget = 5,
    fetchPageFn,
    nowMs = Date.now(),
    epochMs = this.defaultEpochMs,
    backfill = false,
    isNovelItem = null,
    stopAfterEmptyPages = this.stopAfterEmptyPages,
  }) {
    const stack = this.planQueryStack(queryId, discoveryState, { nowMs, epochMs, backfill });
    const items = [];
    let pagesUsed = 0;
    let rateLimited = false;
    let earlyStopped = false;
    let consecutiveEmptyPages = 0;
    let completedHighWaterMs = null;

    while (stack.length > 0 && pagesUsed < pageBudget) {
      const seg = stack.pop();
      const queryString = composeSlicedRepoQuery(baseQuery, seg);
      let page = Math.max(1, Number(seg.startPage || 1));

      // Fetch starting page (serves as BOTH density probe and data page on page 1)
      const firstRes = await fetchPageFn(queryString, page, this.perPage);
      pagesUsed += 1;

      if (!firstRes || !firstRes.ok) {
        // Re-push unchanged so next run resumes cleanly
        stack.push({ ...seg, startPage: page });
        if (firstRes?.rateLimited) rateLimited = true;
        break;
      }

      const firstItems = Array.isArray(firstRes.items) ? firstRes.items : [];
      items.push(...firstItems);
      const totalCount = Number(firstRes.totalCount ?? firstRes.total_count ?? firstItems.length);

      if (typeof isNovelItem === 'function' && stopAfterEmptyPages > 0) {
        const novelInPage = firstItems.some((it) => isNovelItem(it));
        consecutiveEmptyPages = novelInPage ? 0 : consecutiveEmptyPages + 1;
      }

      // Check subdivision ONLY when probing page 1 and totalCount exceeds safe threshold
      const spanMs = seg.hiMs - seg.loMs;
      if (page === 1 && totalCount > this.nSafe) {
        if (spanMs > this.minSpanMs) {
          const mid = Math.floor((seg.loMs + seg.hiMs) / 2);
          // Push older half first so newer half pops first
          stack.push({
            loMs: seg.loMs,
            hiMs: mid,
            starClause: seg.starClause,
            sizeClause: seg.sizeClause,
            startPage: 1,
            isIncremental: false,
          });
          stack.push({
            loMs: Math.min(seg.hiMs, mid + 1000),
            hiMs: seg.hiMs,
            starClause: seg.starClause,
            sizeClause: seg.sizeClause,
            startPage: 1,
            isIncremental: seg.isIncremental,
          });
          continue;
        }
        if (!seg.starClause) {
          // Push lower-star buckets first so higher-star buckets pop first
          for (const starClause of SLICER_STAR_BUCKETS) {
            stack.push({
              loMs: seg.loMs,
              hiMs: seg.hiMs,
              starClause,
              sizeClause: '',
              startPage: 1,
              isIncremental: seg.isIncremental,
            });
          }
          continue;
        }
        if (!seg.sizeClause) {
          for (const sizeClause of SLICER_SIZE_BUCKETS) {
            stack.push({
              loMs: seg.loMs,
              hiMs: seg.hiMs,
              starClause: seg.starClause,
              sizeClause,
              startPage: 1,
              isIncremental: seg.isIncremental,
            });
          }
          continue;
        }
        // Already partitioned on pushed + stars + size: DO NOT subdivide again (no infinite loop!).
        // Fall through to paginate pages 2..10 cleanly.
      }

      const maxPages = Math.min(10, Math.ceil(totalCount / this.perPage));
      let segmentFinished = firstItems.length < this.perPage || page >= maxPages;

      if (!segmentFinished && stopAfterEmptyPages > 0 && consecutiveEmptyPages >= stopAfterEmptyPages) {
        earlyStopped = true;
        // Preserve unfinished backfill work if this was not a small incremental sweep
        if (!seg.isIncremental) {
          stack.push({ ...seg, startPage: page + 1 });
        }
        break;
      }

      // Paginate remaining pages of this segment, re-pushing `startPage` if pageBudget runs out mid-slice!
      for (let nextPage = page + 1; nextPage <= maxPages; nextPage++) {
        if (pagesUsed >= pageBudget) {
          stack.push({ ...seg, startPage: nextPage });
          segmentFinished = false;
          break;
        }
        const pageRes = await fetchPageFn(queryString, nextPage, this.perPage);
        pagesUsed += 1;
        if (!pageRes || !pageRes.ok) {
          stack.push({ ...seg, startPage: nextPage });
          if (pageRes?.rateLimited) rateLimited = true;
          segmentFinished = false;
          break;
        }
        const pageItems = Array.isArray(pageRes.items) ? pageRes.items : [];
        items.push(...pageItems);

        if (typeof isNovelItem === 'function' && stopAfterEmptyPages > 0) {
          const novelInPage = pageItems.some((it) => isNovelItem(it));
          consecutiveEmptyPages = novelInPage ? 0 : consecutiveEmptyPages + 1;
          if (consecutiveEmptyPages >= stopAfterEmptyPages && nextPage < maxPages) {
            earlyStopped = true;
            if (!seg.isIncremental) {
              stack.push({ ...seg, startPage: nextPage + 1 });
            }
            segmentFinished = false;
            break;
          }
        }

        if (pageItems.length < this.perPage || nextPage >= maxPages) {
          segmentFinished = true;
          break;
        }
      }

      if (rateLimited || earlyStopped) break;

      if (segmentFinished && seg.isIncremental) {
        completedHighWaterMs = completedHighWaterMs === null ? seg.hiMs : Math.max(completedHighWaterMs, seg.hiMs);
      }
    }

    // Persist updated stack and advance watermark only when incremental sweep finished without pending incremental fragments
    const hasPendingIncremental = stack.some((s) => s.isIncremental);
    let advancedWatermarkIso = null;
    if (discoveryState && typeof discoveryState === 'object') {
      if (!discoveryState.pendingIntervals) discoveryState.pendingIntervals = {};
      if (!discoveryState.watermarks) discoveryState.watermarks = {};
      discoveryState.pendingIntervals[queryId] = stack;
      if (completedHighWaterMs !== null && !hasPendingIncremental && !rateLimited) {
        advancedWatermarkIso = toIsoSeconds(completedHighWaterMs);
        discoveryState.watermarks[queryId] = advancedWatermarkIso;
      }
    }

    return {
      queryId,
      items,
      pagesUsed,
      remainingStack: stack,
      rateLimited,
      earlyStopped,
      advancedWatermarkIso,
    };
  }
}

// ============================================================================
// 2. Deterministic Budgeted Bandit: Discounted UCB1-Cost (`DiscountedUcb1Cost`)
// ============================================================================

export class DiscountedUcb1Cost {
  constructor({
    gamma = 0.92,
    explorationC = 0.5,
    floorRatio = 0.15,
    maxStaleRuns = 4,
    defaultMaxUnitsPerArm = 6,
    updateWeight = 0.25,
  } = {}) {
    this.gamma = gamma;
    this.explorationC = explorationC;
    this.floorRatio = floorRatio;
    this.maxStaleRuns = maxStaleRuns;
    this.defaultMaxUnitsPerArm = defaultMaxUnitsPerArm;
    this.updateWeight = updateWeight;
  }

  getArmStats(banditState, armId) {
    const raw = banditState?.arms?.[armId];
    return {
      discountedReward: Number(raw?.discountedReward || 0),
      discountedCost: Number(raw?.discountedCost || 0),
      discountedPulls: Number(raw?.discountedPulls || 0),
      totalPulls: Number(raw?.totalPulls || 0),
      runsSinceLastPull: Number(raw?.runsSinceLastPull || 0),
      lastPulledAt: raw?.lastPulledAt || null,
    };
  }

  /**
   * Computes deterministic Discounted UCB1-Cost score:
   *   Score(a) = (Y_tilde / C_tilde) + c * sqrt(ln(sum(N_tilde) + 1) / (N_tilde + 1))
   * Accepts `virtualExtraPulls` so batch allocation smoothly diversifies across top arms.
   */
  scoreArm(armStats, totalDiscountedPulls, virtualExtraPulls = 0) {
    if (armStats.discountedCost <= 1e-9 || armStats.discountedPulls <= 1e-9) {
      return Number.POSITIVE_INFINITY;
    }
    const mean = armStats.discountedReward / armStats.discountedCost;
    const effPulls = armStats.discountedPulls + virtualExtraPulls;
    const effTotal = Math.max(1, totalDiscountedPulls + virtualExtraPulls);
    const bonus = this.explorationC * Math.sqrt(Math.log(effTotal + 1) / (effPulls + 1));
    return mean + bonus;
  }

  /**
   * Allocates `poolBudget` units across enabled `arms` within one API quota pool:
   *   1. Reserves `floorRatio` (15%) anti-starvation recall floor for never-pulled or stale (`>= maxStaleRuns`) arms.
   *   2. Allocates remaining budget greedily by Discounted UCB1-Cost (with virtual-pull damping & per-arm `maxUnits`).
   */
  allocateBudget(arms, poolBudget, banditState = { arms: {} }) {
    const budget = Math.max(0, Math.floor(Number(poolBudget || 0)));
    const allocation = new Map();
    const activeArms = (Array.isArray(arms) ? arms : [])
      .filter((a) => a && a.id && a.enabled !== false)
      .map((a) => ({
        id: String(a.id),
        estimatedCost: Math.max(1, Math.floor(Number(a.estimatedCost || 1))),
        maxUnits: Math.max(1, Math.floor(Number(a.maxUnits || this.defaultMaxUnitsPerArm))),
        minUnits: Math.max(0, Math.floor(Number(a.minUnits || 0))),
      }));

    if (budget === 0 || activeArms.length === 0) {
      return allocation;
    }

    let remaining = budget;
    const statsById = new Map();
    let totalDiscountedPulls = 0;
    for (const arm of activeArms) {
      const st = this.getArmStats(banditState, arm.id);
      statsById.set(arm.id, st);
      totalDiscountedPulls += st.discountedPulls;
      allocation.set(arm.id, 0);
    }

    // Phase 1: Anti-starvation recall floor (15% of pool budget, min 1 when eligible arms exist)
    const floorCap = Math.min(remaining, Math.max(1, Math.floor(budget * this.floorRatio)));
    let floorUsed = 0;

    // First honor any explicit minUnits
    for (const arm of [...activeArms].sort((a, b) => a.id.localeCompare(b.id))) {
      while (allocation.get(arm.id) < arm.minUnits && remaining >= arm.estimatedCost) {
        allocation.set(arm.id, allocation.get(arm.id) + 1);
        remaining -= arm.estimatedCost;
        floorUsed += arm.estimatedCost;
      }
    }

    const starved = activeArms
      .filter((arm) => {
        const st = statsById.get(arm.id);
        return allocation.get(arm.id) === 0 && (st.totalPulls === 0 || st.runsSinceLastPull >= this.maxStaleRuns);
      })
      .sort((a, b) => {
        const sa = statsById.get(a.id);
        const sb = statsById.get(b.id);
        const aNew = sa.totalPulls === 0 ? 0 : 1;
        const bNew = sb.totalPulls === 0 ? 0 : 1;
        return aNew - bNew || sb.runsSinceLastPull - sa.runsSinceLastPull || a.id.localeCompare(b.id);
      });

    for (const arm of starved) {
      if (floorUsed >= floorCap || remaining < arm.estimatedCost) break;
      if (allocation.get(arm.id) >= arm.maxUnits) continue;
      allocation.set(arm.id, allocation.get(arm.id) + 1);
      remaining -= arm.estimatedCost;
      floorUsed += arm.estimatedCost;
    }

    // Phase 2: Batch UCB1-Cost greedy allocation (unit-by-unit with virtual pull damping)
    let virtualTotalAdded = 0;
    while (remaining > 0) {
      let bestArm = null;
      let bestScore = -1;
      for (const arm of activeArms) {
        const curr = allocation.get(arm.id);
        if (curr >= arm.maxUnits || arm.estimatedCost > remaining) continue;
        const st = statsById.get(arm.id);
        const rawScore = this.scoreArm(st, totalDiscountedPulls + virtualTotalAdded, curr);
        // Scale by unit cost for bang-per-buck comparison
        const score = Number.isFinite(rawScore) ? rawScore / arm.estimatedCost : Number.POSITIVE_INFINITY;
        if (
          !bestArm ||
          score > bestScore ||
          (score === bestScore && arm.id.localeCompare(bestArm.id) < 0)
        ) {
          bestArm = arm;
          bestScore = score;
        }
      }
      if (!bestArm) break;
      allocation.set(bestArm.id, allocation.get(bestArm.id) + 1);
      remaining -= bestArm.estimatedCost;
      virtualTotalAdded += 1;
    }

    // Drop zero-allocated arms for concise caller iteration
    for (const [id, units] of allocation.entries()) {
      if (units <= 0) allocation.delete(id);
    }
    return allocation;
  }

  /**
   * Computes order-independent fractional attribution `1 / k(r)` for brand-new valid plugins
   * and `updateWeight / k(r)` for already-known plugins whose `commitSha` advanced.
   */
  computeFractionalAttribution(
    armRepoHits,
    { knownValidRepoKeys = new Set(), updatedRepoKeys = new Set(), updateWeight = this.updateWeight } = {},
  ) {
    const entries = armRepoHits instanceof Map ? [...armRepoHits.entries()] : Object.entries(armRepoHits || {});
    const repoToArms = new Map();
    const rewards = new Map();

    for (const [armId, repoList] of entries) {
      rewards.set(armId, 0);
      const uniqueRepos = new Set();
      for (const rk of repoList || []) {
        const norm = String(rk || '').toLowerCase().trim();
        if (norm) uniqueRepos.add(norm);
      }
      for (const rk of uniqueRepos) {
        if (!repoToArms.has(rk)) repoToArms.set(rk, []);
        repoToArms.get(rk).push(armId);
      }
    }

    for (const [rk, armIds] of repoToArms.entries()) {
      const k = armIds.length;
      if (k === 0) continue;
      let repoValue = 0;
      if (!knownValidRepoKeys.has(rk)) {
        repoValue = 1.0;
      } else if (updatedRepoKeys.has(rk)) {
        repoValue = updateWeight;
      }
      if (repoValue <= 0) continue;
      const share = repoValue / k;
      for (const armId of armIds) {
        rewards.set(armId, (rewards.get(armId) || 0) + share);
      }
    }

    return rewards;
  }

  /**
   * Applies exponential discounting (`gamma`) and updates posterior statistics for all tracked arms.
   * Returns a fresh updated `banditState` object.
   */
  updateState(banditState, pullOutcomes, { allArmIds = [], nowIso = new Date().toISOString() } = {}) {
    const outcomes =
      pullOutcomes instanceof Map ? pullOutcomes : new Map(Object.entries(pullOutcomes || {}));
    const prevArms = banditState?.arms || {};
    const nextArms = {};
    const universe = new Set([...Object.keys(prevArms), ...outcomes.keys(), ...(allArmIds || [])]);

    for (const armId of [...universe].sort((a, b) => a.localeCompare(b))) {
      const prev = this.getArmStats(banditState, armId);
      const out = outcomes.get(armId);
      const discountedReward = prev.discountedReward * this.gamma;
      const discountedCost = prev.discountedCost * this.gamma;
      const discountedPulls = prev.discountedPulls * this.gamma;

      if (out && Number(out.cost || 0) > 0) {
        const reward = Math.max(0, Number(out.reward || 0));
        const cost = Math.max(0, Number(out.cost || 0));
        const pulls = Math.max(1, Number(out.pulls || cost));
        nextArms[armId] = {
          discountedReward: Number((discountedReward + reward).toFixed(6)),
          discountedCost: Number((discountedCost + cost).toFixed(6)),
          discountedPulls: Number((discountedPulls + pulls).toFixed(6)),
          totalPulls: prev.totalPulls + pulls,
          runsSinceLastPull: 0,
          lastPulledAt: nowIso,
        };
      } else {
        nextArms[armId] = {
          discountedReward: Number(discountedReward.toFixed(6)),
          discountedCost: Number(discountedCost.toFixed(6)),
          discountedPulls: Number(discountedPulls.toFixed(6)),
          totalPulls: prev.totalPulls,
          runsSinceLastPull: prev.runsSinceLastPull + 1,
          lastPulledAt: prev.lastPulledAt,
        };
      }
    }

    return {
      gamma: this.gamma,
      arms: nextArms,
    };
  }
}

// ============================================================================
// 3. Validated Code Search Fingerprints, `-repo:` Cap & `CodeSearchPacer`
// ============================================================================

/**
 * Validated flat Code Search fingerprint bank.
 * Every query strictly satisfies GitHub legacy `/search/code` rules:
 *   - >= 1 searchable text term (avoids HTTP 422 Validation Failed)
 *   - `path:` specifies directory prefixes only (never filenames)
 *   - No parenthesized `OR` groups
 */
export const VALIDATED_CODE_SEARCH_QUERIES = Object.freeze([
  // Tier S1: Near-100% Antigravity structural precision
  { id: 'C1-schema', tier: 'S1', query: 'filename:plugin.json "antigravity.google/schemas"', maxPages: 3 },
  { id: 'C2-sidecar', tier: 'S1', query: 'filename:sidecar.json "SIDECAR_UI_ENTRYPOINT"', maxPages: 3 },
  { id: 'C3-companion', tier: 'S1', query: 'filename:agy-market.json "schemaVersion"', maxPages: 3 },
  { id: 'C4-dotdir', tier: 'S1', query: '"name" path:.antigravity-plugin filename:plugin.json', maxPages: 4 },
  { id: 'C5a-agents', tier: 'S1', query: '"name" path:.agents/plugins filename:plugin.json', maxPages: 3 },
  { id: 'C5b-agent', tier: 'S1', query: '"name" path:.agent/plugins filename:plugin.json', maxPages: 3 },
  { id: 'C6a-sidecar-uri', tier: 'S1', query: 'filename:SKILL.md "sidecar://"', maxPages: 3 },
  { id: 'C6b-custom-uri', tier: 'S1', query: 'filename:SKILL.md "customization://"', maxPages: 3 },
  { id: 'C7-hooks', tier: 'S1', query: 'filename:hooks.json "antigravity"', maxPages: 2 },
  { id: 'C8-mcp', tier: 'S1', query: 'filename:mcp_config.json "antigravity"', maxPages: 2 },
  // Tier S2: Broad structural signals (pre-screened via Stage 2B GraphQL blobs)
  { id: 'C9-prompts', tier: 'S2', query: 'filename:plugin.json "suggestedPrompts"', maxPages: 3 },
  { id: 'C10-plugin-agy', tier: 'S2', query: 'filename:plugin.json "antigravity"', maxPages: 4 },
  { id: 'C11-skill-agy', tier: 'S2', query: 'filename:SKILL.md "antigravity"', maxPages: 3 },
  { id: 'C12-rules-agy', tier: 'S2', query: 'path:rules extension:md "antigravity"', maxPages: 2 },
]);

/**
 * Validates that a GitHub legacy REST `/search/code` query will not trigger HTTP 422.
 */
export function validateCodeSearchQuery(query) {
  const q = String(query || '').trim();
  const issues = [];
  if (!q) {
    return { valid: false, issues: ['Query is empty'] };
  }
  if (q.length > 256) {
    issues.push(`Query length ${q.length} exceeds GitHub 256-char limit`);
  }
  // Check `path:` qualifiers do not embed a filename extension like `plugin.json`
  const pathRe = /(?:^|\s)path:(\S+)/gi;
  let pm;
  while ((pm = pathRe.exec(q)) !== null) {
    if (/\.(?:json|md|yml|yaml|js|mjs|ts)$/i.test(pm[1])) {
      issues.push(`path: qualifier "${pm[1]}" targets a filename instead of a directory`);
    }
  }
  // Strip qualifiers (including quoted qualifier values) and verify >= 1 searchable text term remains
  const withoutQualifiers = q
    .replace(/(?:^|\s)-?(?:filename|path|extension|repo|org|user|language|size|in|fork):(?:"[^"]*"|\S+)/gi, ' ')
    .trim();
  if (!withoutQualifiers) {
    issues.push('Query lacks a searchable text term (GitHub /search/code returns HTTP 422 for qualifier-only queries)');
  }
  return { valid: issues.length === 0, issues };
}

/**
 * Appends dynamic `-repo:<owner>/<name>` exclusions to prevent monorepo flooding
 * while strictly enforcing `query.length <= maxLength` (default 250, under GitHub's 256-char limit).
 */
export function buildCodeSearchQueryWithExclusions(
  baseQuery,
  excludedRepos = [],
  { maxLength = 250, maxExclusions = 5 } = {},
) {
  let out = String(baseQuery || '').trim();
  const seen = new Set();
  let added = 0;

  for (const raw of Array.isArray(excludedRepos) ? excludedRepos : []) {
    if (added >= maxExclusions) break;
    const slug = String(raw || '').trim();
    const lower = slug.toLowerCase();
    if (!OWNER_REPO_RE.test(slug) || seen.has(lower)) continue;
    seen.add(lower);
    const clause = ` -repo:${slug}`;
    if (out.length + clause.length > maxLength) continue;
    out += clause;
    added += 1;
  }

  return out;
}

export class CodeSearchPacer {
  constructor({
    minIntervalMs = 6_800,
    resetPadMs = 1_500,
    maxPagesPerRun = 45,
    maxSleepMs = 70_000,
    maxRateLimitRetries = 1,
    sleepImpl = sleepDefault,
    nowFn = () => Date.now(),
  } = {}) {
    this.minIntervalMs = Math.max(0, minIntervalMs);
    this.resetPadMs = Math.max(0, resetPadMs);
    this.maxPagesPerRun = Math.max(0, Math.floor(maxPagesPerRun));
    this.maxSleepMs = Math.max(1000, maxSleepMs);
    this.maxRateLimitRetries = Math.max(0, Math.floor(maxRateLimitRetries));
    this.sleepImpl = sleepImpl;
    this.nowFn = nowFn;

    this.disabled = false;
    this.disabledReason = null;
    this.requestsMade = 0;
    this.lastRequestAtMs = 0;
    this.remaining = null;
    this.resetAtMs = 0;
    this.sleepsPerformed = 0;
  }

  async waitForSlot() {
    const now = this.nowFn();
    let waitMs = 0;
    if (this.lastRequestAtMs > 0) {
      const elapsed = now - this.lastRequestAtMs;
      if (elapsed < this.minIntervalMs) {
        waitMs = Math.max(waitMs, this.minIntervalMs - elapsed);
      }
    }
    if (this.remaining !== null && this.remaining <= 1 && this.resetAtMs > now) {
      waitMs = Math.max(waitMs, this.resetAtMs - now + this.resetPadMs);
    }
    if (waitMs > 0) {
      this.sleepsPerformed += 1;
      await this.sleepImpl(Math.min(this.maxSleepMs, waitMs));
    }
  }

  /**
   * Fetches one `/search/code` page with exact reset-header pacing:
   *   - Sleeps on `x-ratelimit-remaining <= 1`, `429`, or rate-limit `403` (NEVER permanently disables!).
   *   - Disables Code Search ONLY on `401` or non-rate-limit `403` (e.g. default `GITHUB_TOKEN`).
   */
  async fetchPage(
    url,
    { headers = {}, fetchImpl = fetch, timeoutMs = 15_000 } = {},
  ) {
    if (this.disabled) {
      return { ok: false, skipped: true, disabled: true, status: 403, reason: this.disabledReason, data: null };
    }
    if (this.requestsMade >= this.maxPagesPerRun) {
      return { ok: false, skipped: true, disabled: false, status: 0, reason: 'MAX_PAGES_PER_RUN', data: null };
    }

    for (let attempt = 0; attempt <= this.maxRateLimitRetries; attempt++) {
      await this.waitForSlot();
      this.lastRequestAtMs = this.nowFn();
      this.requestsMade += 1;

      let res;
      try {
        res = await fetchImpl(url, {
          headers,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        return { ok: false, status: 0, disabled: false, rateLimited: false, error: String(err?.message || err), data: null };
      }

      const remHeader = res.headers?.get?.('x-ratelimit-remaining');
      const resetHeader = res.headers?.get?.('x-ratelimit-reset');
      const retryAfterHeader = res.headers?.get?.('retry-after');

      if (remHeader !== null && remHeader !== undefined && remHeader !== '') {
        const parsedRem = Number(remHeader);
        if (Number.isFinite(parsedRem)) this.remaining = parsedRem;
      }
      if (resetHeader) {
        const parsedReset = Number(resetHeader);
        if (Number.isFinite(parsedReset) && parsedReset > 0) {
          this.resetAtMs = parsedReset * 1000;
        }
      }

      if (res.status === 200) {
        try {
          const data = await res.json();
          return { ok: true, status: 200, disabled: false, rateLimited: false, data };
        } catch (err) {
          return { ok: false, status: 200, disabled: false, rateLimited: false, error: String(err?.message || err), data: null };
        }
      }

      const bodyText = await res.text().catch(() => '');

      if (res.status === 401) {
        this.disabled = true;
        this.disabledReason = 'HTTP_401_UNAUTHORIZED';
        return { ok: false, status: 401, disabled: true, rateLimited: false, data: null };
      }

      if (res.status === 422) {
        // Invalid single query — do NOT disable the pacer for other queries!
        return { ok: false, status: 422, disabled: false, invalidQuery: true, rateLimited: false, data: null };
      }

      const isRateLimit =
        res.status === 429 ||
        (res.status === 403 &&
          (this.remaining === 0 ||
            Boolean(retryAfterHeader) ||
            /rate\s*limit|secondary\s*rate|abuse\s*detection/i.test(bodyText)));

      if (isRateLimit) {
        const now = this.nowFn();
        let sleepMs = 62_000;
        if (retryAfterHeader && Number.isFinite(Number(retryAfterHeader))) {
          sleepMs = Number(retryAfterHeader) * 1000 + this.resetPadMs;
        } else if (this.resetAtMs > now) {
          sleepMs = this.resetAtMs - now + this.resetPadMs;
        }
        this.remaining = 0;
        this.resetAtMs = now + sleepMs;
        if (attempt < this.maxRateLimitRetries && this.requestsMade < this.maxPagesPerRun) {
          this.sleepsPerformed += 1;
          await this.sleepImpl(Math.min(this.maxSleepMs, sleepMs));
          continue;
        }
        return { ok: false, status: res.status, disabled: false, rateLimited: true, data: null };
      }

      if (res.status === 403) {
        // Non-rate-limit 403 (e.g. GitHub Actions GITHUB_TOKEN lacks cross-repo code search scope)
        this.disabled = true;
        this.disabledReason = 'HTTP_403_FORBIDDEN';
        return { ok: false, status: 403, disabled: true, rateLimited: false, data: null };
      }

      return { ok: false, status: res.status, disabled: false, rateLimited: false, data: null };
    }

    return { ok: false, status: 429, disabled: false, rateLimited: true, data: null };
  }
}

// ============================================================================
// 4. 1-Hop README Link Frontier & Auto-Aggregator Promotion
// ============================================================================

/**
 * Mines 1-hop GitHub repository links from cached plugin READMEs:
 *   - Candidate inclusion rule (`#10` YAGNI): `indegree >= minIndegree (2)` OR `agy_slug` match.
 *   - Auto-aggregator promotion: promotes source repos whose README links to `>= autoAggregatorThreshold (8)`
 *     distinct already-validated Antigravity plugin repos.
 */
export function mineReadmeFrontier(
  readmesByRepo,
  {
    knownValidRepoKeys = new Set(),
    negCacheRepoKeys = new Set(),
    curatedAggregatorRepos = new Set(),
    minIndegree = 2,
    autoAggregatorThreshold = 8,
    maxFrontierCandidates = 300,
    maxLinksPerDoc = 200,
  } = {},
) {
  const entries = readmesByRepo instanceof Map ? [...readmesByRepo.entries()] : Object.entries(readmesByRepo || {});
  const curatedLower = new Set([...curatedAggregatorRepos].map((r) => String(r || '').toLowerCase()));
  const targetStats = new Map();
  const promotedAggregators = [];
  let totalLinksParsed = 0;

  for (const [rawSourceRepo, mdText] of entries) {
    const sourceRepo = String(rawSourceRepo || '').trim();
    const sourceLower = sourceRepo.toLowerCase();
    if (!mdText || typeof mdText !== 'string') continue;

    const extracted = extractGitHubCandidatesFromMarkdown(mdText, {
      sourceRepo,
      maxCandidates: maxLinksPerDoc,
    });

    const validOutLinks = new Set();
    for (const item of extracted) {
      const key = item.fullName.toLowerCase();
      const ownerLower = key.split('/')[0] || '';
      if (key === sourceLower || README_NOISE_OWNERS.has(ownerLower)) continue;
      totalLinksParsed += 1;

      if (knownValidRepoKeys.has(key)) {
        validOutLinks.add(key);
        continue;
      }
      if (negCacheRepoKeys.has(key)) continue;

      if (!targetStats.has(key)) {
        targetStats.set(key, {
          key,
          fullName: item.fullName,
          indegree: 0,
          sources: new Set(),
          explicitSubpaths: new Set(),
          agySlug: AGY_SLUG_RE.test(key),
        });
      }
      const stat = targetStats.get(key);
      if (!stat.sources.has(sourceLower)) {
        stat.sources.add(sourceLower);
        stat.indegree += 1;
      }
      for (const sp of item.explicitSubpaths || []) {
        if (sp) stat.explicitSubpaths.add(normalizeRelPosix(sp));
      }
    }

    if (
      sourceRepo &&
      OWNER_REPO_RE.test(sourceRepo) &&
      validOutLinks.size >= autoAggregatorThreshold &&
      !curatedLower.has(sourceLower)
    ) {
      promotedAggregators.push({
        id: sourceLower.replace('/', '__'),
        repo: sourceRepo,
        kind: 'awesome-list',
        files: ['README.md'],
        validLinkCount: validOutLinks.size,
      });
    }
  }

  const candidates = [...targetStats.values()]
    .filter((s) => s.indegree >= minIndegree || s.agySlug)
    .sort((a, b) => {
      const scoreA = (a.agySlug ? 2 : 0) + a.indegree;
      const scoreB = (b.agySlug ? 2 : 0) + b.indegree;
      return scoreB - scoreA || b.indegree - a.indegree || a.key.localeCompare(b.key);
    })
    .slice(0, Math.max(0, maxFrontierCandidates))
    .map((s) => ({
      fullName: s.fullName,
      key: s.key,
      indegree: s.indegree,
      agySlug: s.agySlug,
      explicitSubpaths: [...s.explicitSubpaths].sort(),
      sources: [...s.sources].sort(),
    }));

  promotedAggregators.sort((a, b) => b.validLinkCount - a.validLinkCount || a.repo.localeCompare(b.repo));

  return {
    candidates,
    promotedAggregators,
    stats: {
      docsScanned: entries.length,
      totalLinksParsed,
      uniqueNovelTargets: targetStats.size,
      qualifiedCandidates: candidates.length,
      promotedAggregatorCount: promotedAggregators.length,
    },
  };
}

// ============================================================================
// 5. Cross-Ecosystem Bridge: npm Search API (0 GitHub API Quota)
// ============================================================================

export const DEFAULT_NPM_BRIDGE_QUERIES = Object.freeze([
  'keywords:antigravity-plugin',
  'antigravity-plugin',
  'keywords:agy-plugin',
]);

function extractGithubRepoFromNpmLink(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  const normalized = rawUrl
    .trim()
    .replace(/^git\+/i, '')
    .replace(/^git:\/\/github\.com\//i, 'https://github.com/')
    .replace(/^ssh:\/\/git@github\.com\//i, 'https://github.com/')
    .replace(/^git@github\.com:/i, 'https://github.com/')
    .replace(/#.*$/, '');
  const parsed = parseSafeGitHubCandidateUrl(normalized);
  if (!parsed) return null;
  if (EXTENDED_FIRST_PARTY_OWNERS.has(parsed.owner.toLowerCase())) return null;
  return parsed;
}

/**
 * Queries public npm Registry Search API (`registry.npmjs.org/-/v1/search`) for Antigravity packages
 * and extracts normalized GitHub repository candidates with zero GitHub API quota cost.
 */
export async function discoverFromNpmSearch({
  queries = DEFAULT_NPM_BRIDGE_QUERIES,
  size = 100,
  fetchImpl = fetch,
  timeoutMs = 10_000,
  userAgent = 'agy-market-catalog-discovery/1.6',
} = {}) {
  const byRepo = new Map();
  const errors = [];
  let queriesRun = 0;

  for (const term of Array.isArray(queries) ? queries : []) {
    const q = String(term || '').trim();
    if (!q) continue;
    queriesRun += 1;
    const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=${Math.min(250, Math.max(1, size))}`;
    try {
      const res = await fetchImpl(url, {
        headers: { Accept: 'application/json', 'User-Agent': userAgent },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        errors.push({ query: q, status: res.status });
        continue;
      }
      const data = await res.json();
      const objects = Array.isArray(data?.objects) ? data.objects : [];
      for (const obj of objects) {
        const pkg = obj?.package;
        if (!pkg || typeof pkg !== 'object') continue;
        const parsed =
          extractGithubRepoFromNpmLink(pkg.links?.repository) ||
          extractGithubRepoFromNpmLink(pkg.links?.homepage);
        if (!parsed) continue;
        const key = parsed.fullName.toLowerCase();
        if (!byRepo.has(key)) {
          byRepo.set(key, {
            fullName: parsed.fullName,
            key,
            explicitSubpaths: parsed.explicitSubpath ? [parsed.explicitSubpath] : [],
            npmPackages: [],
          });
        }
        const entry = byRepo.get(key);
        if (typeof pkg.name === 'string' && !entry.npmPackages.includes(pkg.name)) {
          entry.npmPackages.push(pkg.name);
        }
        if (parsed.explicitSubpath && !entry.explicitSubpaths.includes(parsed.explicitSubpath)) {
          entry.explicitSubpaths.push(parsed.explicitSubpath);
        }
      }
    } catch (err) {
      errors.push({ query: q, error: String(err?.message || err) });
    }
  }

  return {
    candidates: [...byRepo.values()].sort((a, b) => a.key.localeCompare(b.key)),
    queriesRun,
    errors,
  };
}

// ============================================================================
// 6. Topic Co-Occurrence Auto-Arm Miner
// ============================================================================

export const DEFAULT_SEED_TOPICS = Object.freeze([
  'antigravity-plugin',
  'antigravity-plugins',
  'antigravity',
  'google-antigravity',
]);

/**
 * Mines high-precision co-occurring GitHub topics across validated vs negative-cached repos:
 *   p_hat(t) = c_V(t) / (c_V(t) + c_N(t) + laplaceAlpha)
 * Promotes topics satisfying `c_V(t) >= minValidCount (3)` and `p_hat(t) >= minSmoothedPrecision (0.40)`.
 */
export function mineCooccurringTopics({
  validReposTopics = [],
  negReposTopics = [],
  seedTopics = DEFAULT_SEED_TOPICS,
  minValidCount = 3,
  minSmoothedPrecision = 0.4,
  laplaceAlpha = 5,
  maxAutoTopics = 10,
} = {}) {
  const excluded = new Set([
    ...GENERIC_NOISE_TOPICS,
    ...[...seedTopics].map((t) => String(t || '').toLowerCase().trim()),
  ]);

  const validCounts = new Map();
  const negCounts = new Map();

  for (const topicList of validReposTopics || []) {
    const seen = new Set();
    for (const raw of Array.isArray(topicList) ? topicList : []) {
      const t = String(raw || '').toLowerCase().trim();
      if (!t || !/^[a-z0-9][a-z0-9-]{1,49}$/.test(t) || excluded.has(t) || seen.has(t)) continue;
      seen.add(t);
      validCounts.set(t, (validCounts.get(t) || 0) + 1);
    }
  }

  for (const topicList of negReposTopics || []) {
    const seen = new Set();
    for (const raw of Array.isArray(topicList) ? topicList : []) {
      const t = String(raw || '').toLowerCase().trim();
      if (!t || !/^[a-z0-9][a-z0-9-]{1,49}$/.test(t) || excluded.has(t) || seen.has(t)) continue;
      seen.add(t);
      negCounts.set(t, (negCounts.get(t) || 0) + 1);
    }
  }

  const promoted = [];
  for (const [topic, cV] of validCounts.entries()) {
    if (cV < minValidCount) continue;
    const cN = negCounts.get(topic) || 0;
    const pHat = cV / (cV + cN + laplaceAlpha);
    if (pHat >= minSmoothedPrecision) {
      promoted.push({
        topic,
        validCount: cV,
        negCount: cN,
        smoothedPrecision: Number(pHat.toFixed(4)),
        queryId: `Q-auto-topic:${topic}`,
        query: `topic:${topic} archived:false`,
      });
    }
  }

  promoted.sort(
    (a, b) =>
      b.smoothedPrecision - a.smoothedPrecision ||
      b.validCount - a.validCount ||
      a.topic.localeCompare(b.topic),
  );

  return promoted.slice(0, Math.max(0, maxAutoTopics));
}

// ============================================================================
// 7. Neg-Cache v2 Activity-Aware Exponential Backoff & Positive Tier Scheduler
// ============================================================================

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export const NEG_CACHE_POLICIES = Object.freeze({
  transient: Object.freeze({
    baseMs: 6 * HOUR_MS,
    beta: 2.0,
    maxMs: 48 * HOUR_MS,
    gcAfterMs: 7 * DAY_MS,
    requiresShaChange: false,
  }),
  fixable_packaging: Object.freeze({
    baseMs: 24 * HOUR_MS,
    beta: 1.8,
    maxMs: 14 * DAY_MS,
    gcAfterMs: 45 * DAY_MS,
    requiresShaChange: true,
  }),
  missing_manifest: Object.freeze({
    baseMs: 3 * DAY_MS,
    beta: 2.0,
    maxMs: 45 * DAY_MS,
    gcAfterMs: 90 * DAY_MS,
    requiresShaChange: true,
  }),
  foreign_ecosystem: Object.freeze({
    baseMs: 14 * DAY_MS,
    beta: 2.5,
    maxMs: 120 * DAY_MS,
    gcAfterMs: 180 * DAY_MS,
    requiresShaChange: true,
  }),
  security_limit: Object.freeze({
    baseMs: 30 * DAY_MS,
    beta: 2.0,
    maxMs: 180 * DAY_MS,
    gcAfterMs: 180 * DAY_MS,
    requiresShaChange: true,
  }),
  terminal: Object.freeze({
    baseMs: 30 * DAY_MS,
    beta: 3.0,
    maxMs: 180 * DAY_MS,
    gcAfterMs: 180 * DAY_MS,
    requiresShaChange: false,
  }),
  default: Object.freeze({
    baseMs: 7 * DAY_MS,
    beta: 2.0,
    maxMs: 60 * DAY_MS,
    gcAfterMs: 120 * DAY_MS,
    requiresShaChange: true,
  }),
});

const REASON_TO_POLICY_CLASS = Object.freeze({
  ERR_TIMEOUT: 'transient',
  ERR_NETWORK: 'transient',
  ERR_TRANSIENT_HTTP: 'transient',
  ERR_GRAPHQL_TIMEOUT: 'transient',
  ERR_GRAPHQL_PARTIAL: 'transient',
  ERR_GRAPHQL_RATE_LIMITED: 'transient',

  ERR_TAR_SYMLINK_FORBIDDEN: 'fixable_packaging',
  ERR_UNBUNDLED_NPM_DEPS: 'fixable_packaging',
  ERR_UNBUILT_SOURCE_ARCHIVE: 'fixable_packaging',
  ERR_PLUGIN_JSON_NAME_FORMAT: 'fixable_packaging',
  ERR_PLUGIN_JSON_NAME: 'fixable_packaging',
  ERR_PLUGIN_JSON_DESCRIPTION: 'fixable_packaging',
  ERR_PLUGIN_JSON_VERSION: 'fixable_packaging',

  ERR_MISSING_PLUGIN_JSON: 'missing_manifest',
  ERR_EMPTY_REPO: 'missing_manifest',
  ERR_EMPTY_REPOSITORY: 'missing_manifest',

  ERR_NOT_ANTIGRAVITY_PLUGIN: 'foreign_ecosystem',
  ERR_FOREIGN_HOST_DIR: 'foreign_ecosystem',
  ERR_FOREIGN_HOST_MANIFEST: 'foreign_ecosystem',
  ERR_LOW_AUTHENTICITY: 'foreign_ecosystem',

  ERR_RULES_PATH_EXFILTRATION: 'security_limit',
  ERR_INVISIBLE_PROMPT_INJECTION: 'security_limit',
  ERR_RULE_SIZE_EXCEEDED: 'security_limit',
  ERR_TAR_PATH_TRAVERSAL: 'security_limit',

  ERR_REPO_NOT_FOUND: 'terminal',
  ERR_REPO_INELIGIBLE: 'terminal',
  archived: 'terminal',
  disabled: 'terminal',
  is_template: 'terminal',
  first_party: 'terminal',
});

export function classifyNegCacheReason(reason) {
  const key = String(reason || '').trim();
  return REASON_TO_POLICY_CLASS[key] || 'default';
}

/**
 * Activity multiplier `phi(a)` based on inactivity age `a = nowMs - pushedAt`:
 *   a < 7d -> 0.5, 7d <= a < 30d -> 1.0, 30d <= a < 90d -> 2.0, a >= 90d -> 4.0
 */
export function computeActivityMultiplier(pushedAt, nowMs = Date.now()) {
  if (!pushedAt) return 1.0;
  const pushedMs = typeof pushedAt === 'number' ? pushedAt : Date.parse(pushedAt);
  if (!Number.isFinite(pushedMs)) return 1.0;
  const ageDays = Math.max(0, (nowMs - pushedMs) / DAY_MS);
  if (ageDays < 7) return 0.5;
  if (ageDays < 30) return 1.0;
  if (ageDays < 90) return 2.0;
  return 4.0;
}

/**
 * Computes next negative-cache probe schedule:
 *   Delta_t(r, k, a) = min(T_max(r), T_base(r) * beta(r)^(k - 1) * phi(a))
 */
export function computeNextNegCacheProbe({
  reason,
  failureCount = 1,
  pushedAt = null,
  nowMs = Date.now(),
} = {}) {
  const policyClass = classifyNegCacheReason(reason);
  const policy = NEG_CACHE_POLICIES[policyClass] || NEG_CACHE_POLICIES.default;
  const k = Math.max(1, Math.floor(Number(failureCount || 1)));
  const phi = computeActivityMultiplier(pushedAt, nowMs);
  const rawMs = policy.baseMs * Math.pow(policy.beta, k - 1) * phi;
  const intervalMs = Math.min(policy.maxMs, Math.max(HOUR_MS, Math.round(rawMs)));

  return {
    policyClass,
    policy,
    failureCount: k,
    activityMultiplier: phi,
    intervalMs,
    nextProbeAt: new Date(nowMs + intervalMs).toISOString(),
    gcAfterMs: policy.gcAfterMs,
  };
}

/**
 * Evaluates whether a negative-cached repo should be skipped at `pre-network` or `post-probe` phase.
 * Honors `headSha` mutation wake-up, `validatorVersion` upgrade wake-up, and `pushedAt` wake-up for fixable/transient errors.
 */
export function shouldSkipNegativeCache(
  entry,
  {
    nowMs = Date.now(),
    observedHeadSha = null,
    observedPushedAt = null,
    validatorVersion = CURRENT_VALIDATOR_VERSION,
    phase = 'pre-network',
  } = {},
) {
  if (!entry || typeof entry !== 'object') {
    return { skip: false, wakeReason: 'no_entry' };
  }

  const policyClass = classifyNegCacheReason(entry.reason);
  const policy = NEG_CACHE_POLICIES[policyClass] || NEG_CACHE_POLICIES.default;
  const entryValidatorVer = Number(entry.validatorVersion || 1);

  // Validator upgrade wakes non-terminal entries immediately
  if (policyClass !== 'terminal' && entryValidatorVer < validatorVersion) {
    return { skip: false, wakeReason: 'validator_upgraded' };
  }

  const normObservedSha = observedHeadSha ? String(observedHeadSha).toLowerCase() : null;
  const normCachedSha = entry.headSha ? String(entry.headSha).toLowerCase() : null;

  if (normObservedSha && normCachedSha && normObservedSha !== normCachedSha) {
    return { skip: false, wakeReason: 'head_sha_changed' };
  }

  if (
    observedPushedAt &&
    entry.pushedAt &&
    (policyClass === 'fixable_packaging' || policyClass === 'transient')
  ) {
    const obsMs = Date.parse(observedPushedAt);
    const cachedMs = Date.parse(entry.pushedAt);
    if (Number.isFinite(obsMs) && Number.isFinite(cachedMs) && obsMs > cachedMs) {
      return { skip: false, wakeReason: 'pushed_at_advanced' };
    }
  }

  // Post-probe gate: if commit SHA did not change and validator version matches, never re-download tarball
  if (
    phase === 'post-probe' &&
    policy.requiresShaChange &&
    normObservedSha &&
    normCachedSha &&
    normObservedSha === normCachedSha &&
    entryValidatorVer >= validatorVersion
  ) {
    return { skip: true, reason: 'head_sha_unchanged' };
  }

  const dueIso = entry.nextProbeAt || entry.retryAfter || null;
  const dueMs = dueIso ? Date.parse(dueIso) : 0;
  if (Number.isFinite(dueMs) && nowMs < dueMs) {
    return { skip: true, reason: 'backoff_active', nextProbeAt: dueIso };
  }

  return { skip: false, wakeReason: 'probe_due' };
}

/**
 * Produces an updated Neg-Cache v2 record (preserving `retryAfter` alias for v1 readers).
 */
export function updateNegativeCacheEntry(
  prevEntry,
  {
    repositoryId = 0,
    headSha = null,
    pushedAt = null,
    reason = 'ERR_UNKNOWN',
    nowMs = Date.now(),
    validatorVersion = CURRENT_VALIDATOR_VERSION,
  } = {},
) {
  const sameReason = Boolean(prevEntry && prevEntry.reason === reason);
  const failureCount = sameReason ? Math.max(1, Number(prevEntry.failureCount || 1)) + 1 : 1;
  const effectivePushedAt = pushedAt || prevEntry?.pushedAt || null;
  const schedule = computeNextNegCacheProbe({
    reason,
    failureCount,
    pushedAt: effectivePushedAt,
    nowMs,
  });

  const nowIso = new Date(nowMs).toISOString();
  return {
    repositoryId: Number(repositoryId || prevEntry?.repositoryId || 0),
    headSha: headSha ? String(headSha).toLowerCase() : prevEntry?.headSha || null,
    pushedAt: effectivePushedAt,
    reason,
    policyClass: schedule.policyClass,
    failureCount,
    firstSeenAt: prevEntry?.firstSeenAt || prevEntry?.checkedAt || nowIso,
    checkedAt: nowIso,
    nextProbeAt: schedule.nextProbeAt,
    retryAfter: schedule.nextProbeAt,
    validatorVersion,
  };
}

/**
 * Garbage-collects stale negative-cache entries past `gcAfterMs` beyond `nextProbeAt`.
 */
export function pruneNegativeCacheEntries(entriesObj, nowMs = Date.now()) {
  const kept = {};
  for (const [key, entry] of Object.entries(entriesObj || {})) {
    if (!entry || typeof entry !== 'object') continue;
    const policyClass = classifyNegCacheReason(entry.reason);
    const policy = NEG_CACHE_POLICIES[policyClass] || NEG_CACHE_POLICIES.default;
    const dueMs = Date.parse(entry.nextProbeAt || entry.retryAfter || 0);
    if (!Number.isFinite(dueMs)) continue;
    if (nowMs - dueMs > policy.gcAfterMs) continue;
    kept[key] = entry;
  }
  return kept;
}

/**
 * Tiered Positive-Cache Heartbeat Scheduler:
 *   - Hot (`pushedAt <= 14d` OR `stars >= 20`): due every 6h run
 *   - Warm (`14d < pushedAt <= 90d`): due every 24h (`bucket % 4 === runSlot % 4`)
 *   - Cold (`pushedAt > 90d`): due every 72h (`bucket % 12 === runSlot % 12`)
 */
export function classifyPositiveRecrawlTier(
  { repositoryId = 0, repoKey = '', pushedAt = null, updatedAt = null, stars = 0 } = {},
  { nowMs = Date.now(), runSlot = 0 } = {},
) {
  const refIso = pushedAt || updatedAt || null;
  const refMs = refIso ? Date.parse(refIso) : NaN;
  const ageDays = Number.isFinite(refMs) ? Math.max(0, (nowMs - refMs) / DAY_MS) : 0;
  const starCount = Number(stars || 0);

  if (ageDays <= 14 || starCount >= 20) {
    return { tier: 'hot', due: true, cadenceHours: 6 };
  }

  const bucket = Number(repositoryId) > 0 ? Math.floor(Number(repositoryId)) : deterministicHash32(repoKey);
  const slot = Math.abs(Math.floor(runSlot));

  if (ageDays <= 90) {
    return { tier: 'warm', due: bucket % 4 === slot % 4, cadenceHours: 24 };
  }
  return { tier: 'cold', due: bucket % 12 === slot % 12, cadenceHours: 72 };
}
