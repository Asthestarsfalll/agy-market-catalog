#!/usr/bin/env node
// Helper CLI & pure functions for fork-safe Track-1 PR admission workflows (`scripts/admit-pr-helper.mjs`).

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validatePrDiffLimits } from './validate-entries.mjs';

export const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
export const SLASH_COMMAND_RE = /^\/(?:merge|admit)(?:\s+(--dry-run|--skip-age-check))*$/;

function sanitizeMarkdownCodeBlock(text) {
  return String(text ?? '')
    .replace(/`{3,}/g, "'''")
    .trim();
}

/**
 * Parse `git diff --name-status` lines cleanly, handling `R*` rename and `C*` copy lines
 * so BOTH old and new paths are checked against `validatePrDiffLimits`.
 */
export function parseDiffOutput(diffText = '') {
  const lines = String(diffText || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const addedOrModified = [];
  const deleted = [];

  for (const line of lines) {
    const parts = line.split(/\t+/);
    const status = parts[0] || '';
    if (!status) continue;

    if (status.startsWith('R')) {
      const oldPath = parts[1];
      const newPath = parts[2];
      if (!oldPath || !newPath) {
        throw new Error(`ERR_MALFORMED_DIFF_RENAME: Incomplete rename line "${line}"`);
      }
      deleted.push(oldPath);
      addedOrModified.push(newPath);
    } else if (status.startsWith('C')) {
      const srcPath = parts[1];
      const dstPath = parts[2];
      if (!srcPath || !dstPath) {
        throw new Error(`ERR_MALFORMED_DIFF_COPY: Incomplete copy line "${line}"`);
      }
      addedOrModified.push(dstPath);
    } else if (status.startsWith('D')) {
      const file = parts[1];
      if (file) deleted.push(file);
    } else {
      for (const file of parts.slice(1)) {
        if (file) addedOrModified.push(file);
      }
    }
  }

  validatePrDiffLimits({ addedOrModified, deleted });

  const changedYmls = [...new Set(addedOrModified)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    addedOrModified,
    deleted,
    changedYmls,
  };
}

/**
 * Validate maintainer slash command and `author_association` on `issue_comment` events.
 */
export function authorizeComment({ body = '', authorAssociation = '', isPullRequest = false } = {}) {
  const trimmed = String(body || '').trim();
  const isPr = Boolean(isPullRequest);
  const assoc = String(authorAssociation || '').trim().toUpperCase();

  if (!isPr) {
    return {
      authorized: false,
      isCommand: false,
      command: null,
      dryRun: false,
      skipAgeCheck: false,
      reason: 'ERR_NOT_PULL_REQUEST: Comment is not on a pull request',
    };
  }

  const m = SLASH_COMMAND_RE.exec(trimmed);
  if (!m) {
    const looksLikeSlash = /^\/(?:merge|admit)\b/i.test(trimmed);
    return {
      authorized: false,
      isCommand: looksLikeSlash,
      command: null,
      dryRun: false,
      skipAgeCheck: false,
      reason: looksLikeSlash
        ? 'ERR_INVALID_SLASH_FLAGS: Supported syntax is /merge or /admit with optional --dry-run / --skip-age-check'
        : 'Not a /merge or /admit command',
    };
  }

  const tokens = trimmed.split(/\s+/);
  const command = tokens[0].slice(1);
  const dryRun = tokens.includes('--dry-run');
  const skipAgeCheck = tokens.includes('--skip-age-check');

  if (!MAINTAINER_ASSOCIATIONS.has(assoc)) {
    return {
      authorized: false,
      isCommand: true,
      command,
      dryRun,
      skipAgeCheck,
      reason: `ERR_UNAUTHORIZED_ASSOCIATION: Author association "${assoc || 'NONE'}" is not in {OWNER, MEMBER, COLLABORATOR}`,
    };
  }

  return {
    authorized: true,
    isCommand: true,
    command,
    dryRun,
    skipAgeCheck,
    reason: null,
  };
}

function formatEntryBadgeCell(item) {
  const badges = Array.isArray(item?.badges) ? item.badges.filter(Boolean) : [];
  const hostKinds = Array.isArray(item?.hostEnhancementKind) ? item.hostEnhancementKind.filter(Boolean) : [];
  if (badges.length === 0) return '`declarative-only`';
  return badges
    .map((b) =>
      b === 'host-enhancement' && hostKinds.length > 0
        ? `\`host-enhancement\` (${hostKinds.map((k) => `\`${k}\``).join(', ')})`
        : `\`${b}\``,
    )
    .join(', ');
}

function normalizeSummaryPayload(summary) {
  if (Array.isArray(summary)) {
    return { results: summary };
  }
  if (summary && Array.isArray(summary.results)) {
    return summary;
  }
  return { results: [] };
}

/**
 * Format clean bilingual (ZH/EN) Markdown PR comments for approved / dry-run / pending-age / rejected outcomes.
 */
export function formatComment({ mode = 'approved', prNumber = '', summary = {}, headSha = '', runUrl = '' } = {}) {
  const { results } = normalizeSummaryPayload(summary);
  const prTag = prNumber ? `#${prNumber}` : 'PR';
  const shortSha = headSha ? `\`${String(headSha).slice(0, 7)}\`` : '';
  const runFooter = runUrl ? `\n\n---\nWorkflow run: ${runUrl}` : '';

  const rows = results.map((r) => {
    const fileCell = `\`${r.file || '-'}\``;
    const nameCell = r.canonicalName ? `\`${r.canonicalName}\`` : '-';
    const verCell = r.version ? `\`${r.version}\`` : '-';
    const statusCell = `\`${r.status || 'UNKNOWN'}\``;
    const badgeCell = formatEntryBadgeCell(r);
    let detailCell = '-';
    if (r.status === 'FAILED' && r.error) {
      detailCell = `\`${String(r.error).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, 220)}\``;
    } else if (r.status === 'PENDING_REPO_AGE' && r.unlockAtUtc) {
      detailCell = `Unlocks: \`${r.unlockAtUtc}\``;
    } else if (r.sha256) {
      detailCell = `\`sha256:${String(r.sha256).slice(0, 12)}...\``;
    }
    return `| ${fileCell} | ${nameCell} | ${verCell} | ${statusCell} | ${badgeCell} | ${detailCell} |`;
  });

  const tableBlock = [
    '| Entry YAML | Canonical Name | Version | Status | Capabilities | Details / 详情 |',
    '| :--- | :--- | :--- | :--- | :--- | :--- |',
    ...(rows.length ? rows : ['| - | - | - | - | - | No entries evaluated |']),
  ].join('\n');

  const warnings = results.flatMap((r) =>
    (Array.isArray(r.warnings) ? r.warnings : []).map((w) => `- \`${r.file}\`: ${w}`),
  );
  const warningBlock = warnings.length
    ? `\n\n**Warnings / 告警**:\n${warnings.join('\n')}`
    : '';

  if (mode === 'dry-run') {
    return [
      `### 🧪 [DRY RUN] Track-1 Admission Check Passed / 预检通过 (${prTag}${shortSha ? ` @ ${shortSha}` : ''})`,
      '',
      '> **仅验证未合入 / Dry-run only**: All static schema, tarball, capability, and anti-collision checks passed without modifying `state/` or merging this PR.',
      '> Maintainers may post `/merge` (or dispatch `merge-pr.yml` with `dry_run=false`) to complete admission.',
      '',
      tableBlock + warningBlock + runFooter,
    ].join('\n');
  }

  if (mode === 'pending-age') {
    const unlockLines = results
      .filter((r) => r.status === 'PENDING_REPO_AGE')
      .map((r) => `- \`${r.file}\` (\`${r.canonicalName || '-'}\`): unlocks at **${r.unlockAtUtc || '24h after creation'}** (UTC)`);
    return [
      `### ⏳ Pending 24h Repository Age Gate / 等待仓库冷启动期满 (${prTag}${shortSha ? ` @ ${shortSha}` : ''})`,
      '',
      'All static, tarball, capability, and anti-collision checks passed, but at least one repository is newer than 24 hours (`MIN_AGE_DAYS = 1`).',
      '所有静态校验、压缩包安全扫描与防碰撞检查均已通过，但仓库创建时间未满 24 小时（`MIN_AGE_DAYS = 1`）。',
      '',
      ...(unlockLines.length ? unlockLines : ['- Waiting for 24h `MIN_AGE_DAYS = 1` threshold.']),
      '',
      '`regate.yml` runs every 6 hours and will automatically re-verify and squash-merge once eligible (or a maintainer can run `/merge` after unlock).',
      '',
      tableBlock + warningBlock + runFooter,
    ].join('\n');
  }

  if (mode === 'rejected') {
    const errorLines = results
      .filter((r) => r.status === 'FAILED' && r.error)
      .map((r) => `- **${r.file}**: ${sanitizeMarkdownCodeBlock(r.error)}`);
    const detailSection = errorLines.length
      ? `\n\n**Diagnostics / 错误详情**:\n\`\`\`text\n${errorLines.join('\n')}\n\`\`\``
      : '';
    return [
      `### ❌ Track-1 Admission Gate Failed / 收录校验未通过 (${prTag}${shortSha ? ` @ ${shortSha}` : ''})`,
      '',
      'One or more checks failed during fork-safe Track-1 admission validation. Please review the diagnostics below and push an updated commit.',
      'Fork 安全校验未通过，请根据下方诊断信息修复后重新提交。',
      '',
      tableBlock + detailSection + warningBlock + runFooter,
    ].join('\n');
  }

  return [
    `### ✅ Track-1 Plugin Admitted & State Locked / 插件已收录并锁定状态 (${prTag}${shortSha ? ` @ ${shortSha}` : ''})`,
    '',
    'PR has been squash-merged onto `main`, `state/ledger.json` & `state/versions-lock.json` have been locked atomically, and the GitHub Pages catalog has been updated.',
    '本 PR 已 Squash 合入 `main`，`state/ledger.json` 与 `state/versions-lock.json` 已原子锁定并同步更新线上目录。',
    '',
    tableBlock + warningBlock + runFooter,
  ].join('\n');
}

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[arg.slice(2)] = argv[++i];
      } else {
        flags[arg.slice(2)] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function runCli() {
  const [subcommand, ...rest] = process.argv.slice(2);
  const { flags } = parseFlags(rest);

  if (subcommand === 'parse-diff') {
    let diffText = '';
    if (flags.base && flags.head) {
      diffText = execFileSync('git', ['diff', '--name-status', String(flags.base), String(flags.head)], {
        encoding: 'utf8',
      });
    } else if (flags.input) {
      diffText = readFileSync(resolve(String(flags.input)), 'utf8');
    } else {
      diffText = readFileSync(0, 'utf8');
    }
    const parsed = parseDiffOutput(diffText);
    console.log(JSON.stringify(parsed));
    return;
  }

  if (subcommand === 'authorize-comment') {
    const body = flags.body !== undefined ? String(flags.body) : process.env.COMMENT_BODY || '';
    const authorAssociation =
      flags.association !== undefined ? String(flags.association) : process.env.AUTHOR_ASSOCIATION || '';
    const rawIsPr =
      flags['is-pr'] !== undefined ? String(flags['is-pr']) : process.env.IS_PULL_REQUEST || '';
    const isPullRequest = rawIsPr === 'true' || rawIsPr === '1' || rawIsPr === 'yes';
    const result = authorizeComment({ body, authorAssociation, isPullRequest });
    console.log(JSON.stringify(result));
    return;
  }

  if (subcommand === 'format-comment') {
    const summaryPath = resolve(String(flags.summary || ''));
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
    const markdown = formatComment({
      mode: String(flags.mode || 'approved'),
      prNumber: flags.pr !== undefined ? String(flags.pr) : '',
      summary,
      headSha: flags['head-sha'] !== undefined ? String(flags['head-sha']) : '',
      runUrl: flags['run-url'] !== undefined ? String(flags['run-url']) : '',
    });
    if (flags.out) {
      const outPath = resolve(String(flags.out));
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, `${markdown}\n`, 'utf8');
    } else {
      process.stdout.write(`${markdown}\n`);
    }
    return;
  }

  console.error('Usage: node scripts/admit-pr-helper.mjs <parse-diff|authorize-comment|format-comment> [options]');
  process.exit(1);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] || '')).href) {
  runCli();
}
