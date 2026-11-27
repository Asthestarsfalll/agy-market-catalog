#!/usr/bin/env node
// Deterministic Track-1 Catalog Table Generator for README.md & README.en.md (`scripts/sync-readme-tables.mjs`).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateEntriesDirectory } from './validate-entries.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

export const CATALOG_TABLE_START = '<!-- CATALOG-TABLE:START -->';
export const CATALOG_TABLE_END = '<!-- CATALOG-TABLE:END -->';

function sanitizeCell(value) {
  return String(value ?? '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\|/g, '\\|');
}

export function formatCapabilityBadges(capabilities = {}) {
  const badges = Array.isArray(capabilities?.badges) ? capabilities.badges.filter(Boolean) : [];
  if (badges.length === 0) {
    return '`declarative-only`';
  }
  const hostKinds = Array.isArray(capabilities?.hostEnhancementKind)
    ? capabilities.hostEnhancementKind.filter(Boolean)
    : [];

  return badges
    .map((badge) => {
      if (badge === 'host-enhancement' && hostKinds.length > 0) {
        return `\`host-enhancement\` (${hostKinds.map((k) => `\`${sanitizeCell(k)}\``).join(', ')})`;
      }
      return `\`${sanitizeCell(badge)}\``;
    })
    .join(', ');
}

export function buildTrack1TableRows({
  entries = [],
  ledger = { schemaVersion: 1, entries: {} },
  versionsLock = { schemaVersion: 1, locks: {} },
} = {}) {
  const entryMap = new Map(entries.map((e) => [e.entrySlug, e]));
  const sortedRecords = Object.values(ledger.entries || {}).sort((a, b) => {
    const sa = String(a?.entrySlug || '');
    const sb = String(b?.entrySlug || '');
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });

  const rows = [];
  for (const rec of sortedRecords) {
    if (!rec || rec.status === 'REPOJACKING_BLOCKED' || rec.status === 'DEPRECATED_GONE') {
      continue;
    }
    const lock = versionsLock.locks?.[rec.entrySlug];
    if (!lock?.latest || !lock.versions?.[lock.latest]) {
      continue;
    }
    const verData = lock.versions[lock.latest];
    const yamlEntry = entryMap.get(rec.entrySlug);
    const manifest = verData.manifest || {};
    const repoFullName = String(rec.repoFullName || yamlEntry?.repoFullName || '').trim();
    const zhDesc = yamlEntry?.description?.zh || manifest.description || '';
    const enDesc = yamlEntry?.description?.en || manifest.description || '';

    rows.push({
      id: rec.entrySlug,
      canonicalName: rec.canonicalName,
      status: rec.status || 'active',
      version: lock.latest,
      repoFullName,
      repoUrl: `https://github.com/${repoFullName}`,
      badgesMarkdown: formatCapabilityBadges(verData.capabilities),
      description: {
        zh: sanitizeCell(zhDesc),
        en: sanitizeCell(enDesc),
      },
    });
  }
  return rows;
}

export function renderTrack1CatalogTable(rows = [], locale = 'zh') {
  const isEn = locale === 'en';
  const header = isEn
    ? '| Catalog ID | Canonical Name | Version | GitHub Repository | Capability Badges | Description |'
    : '| 目录 ID | 规范名 (`canonicalName`) | 版本 | GitHub 仓库 | 能力徽章 | 简介 |';
  const separator = '| :--- | :--- | :--- | :--- | :--- | :--- |';

  if (!rows.length) {
    const emptyLine = isEn
      ? '| _None_ | - | - | - | - | No verified plugins indexed yet. |'
      : '| _暂无_ | - | - | - | - | 暂未收录已验证插件。 |';
    return [header, separator, emptyLine].join('\n');
  }

  const lines = rows.map((row) => {
    const nameCell =
      row.status && row.status !== 'active'
        ? `\`${sanitizeCell(row.canonicalName)}\` (\`${sanitizeCell(row.status)}\`)`
        : `\`${sanitizeCell(row.canonicalName)}\``;
    const repoCell = `[\`${sanitizeCell(row.repoFullName)}\`](${row.repoUrl})`;
    const descCell = isEn ? row.description.en : row.description.zh;
    return `| \`${sanitizeCell(row.id)}\` | ${nameCell} | \`${sanitizeCell(row.version)}\` | ${repoCell} | ${row.badgesMarkdown} | ${descCell} |`;
  });

  return [header, separator, ...lines].join('\n');
}

export function replaceCatalogTableSection(rawMarkdown, tableMarkdown) {
  const normalized = String(rawMarkdown ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const startIdx = normalized.indexOf(CATALOG_TABLE_START);
  const endIdx = normalized.indexOf(CATALOG_TABLE_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return {
      skipped: true,
      changed: false,
      content: normalized,
    };
  }
  const before = normalized.slice(0, startIdx + CATALOG_TABLE_START.length);
  const after = normalized.slice(endIdx);
  const nextContent = `${before}\n${tableMarkdown}\n${after}`;
  return {
    skipped: false,
    changed: nextContent !== normalized,
    content: nextContent,
  };
}

export function syncReadmeTables({ repoRoot = REPO_ROOT, write = false, check = false } = {}) {
  const resolvedRoot = resolve(repoRoot);
  const entries = validateEntriesDirectory(join(resolvedRoot, 'data', 'plugins'));
  const ledgerPath = join(resolvedRoot, 'state', 'ledger.json');
  const lockPath = join(resolvedRoot, 'state', 'versions-lock.json');

  const ledger = existsSync(ledgerPath)
    ? JSON.parse(readFileSync(ledgerPath, 'utf8'))
    : { schemaVersion: 1, entries: {} };
  const versionsLock = existsSync(lockPath)
    ? JSON.parse(readFileSync(lockPath, 'utf8'))
    : { schemaVersion: 1, locks: {} };

  const rows = buildTrack1TableRows({ entries, ledger, versionsLock });
  const targets = [
    { relPath: 'README.md', locale: 'zh' },
    { relPath: 'README.en.md', locale: 'en' },
  ];

  const results = [];
  const outOfSyncFiles = [];

  for (const target of targets) {
    const absPath = join(resolvedRoot, target.relPath);
    if (!existsSync(absPath)) {
      results.push({ file: target.relPath, status: 'missing', changed: false });
      continue;
    }

    const raw = readFileSync(absPath, 'utf8');
    const hadCrlfOrBom = raw.includes('\r\n') || raw.charCodeAt(0) === 0xfeff;
    const tableMarkdown = renderTrack1CatalogTable(rows, target.locale);
    const replaced = replaceCatalogTableSection(raw, tableMarkdown);

    if (replaced.skipped) {
      results.push({ file: target.relPath, status: 'skipped_no_markers', changed: false });
      continue;
    }

    const needsWrite = replaced.changed || hadCrlfOrBom;
    if (replaced.changed) {
      outOfSyncFiles.push(target.relPath);
    }

    if (write && needsWrite) {
      writeFileSync(absPath, replaced.content, 'utf8');
      results.push({ file: target.relPath, status: 'updated', changed: true });
    } else if (replaced.changed) {
      results.push({ file: target.relPath, status: 'out_of_sync', changed: true });
    } else {
      results.push({ file: target.relPath, status: 'in_sync', changed: false });
    }
  }

  return {
    ok: !(check && outOfSyncFiles.length > 0),
    rowCount: rows.length,
    outOfSyncFiles,
    results,
  };
}

function parseCliArgs(argv = process.argv.slice(2)) {
  const opts = {
    write: false,
    check: false,
    repoRoot: REPO_ROOT,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--write') opts.write = true;
    else if (arg === '--check') opts.check = true;
    else if (arg === '--repo-root' && i + 1 < argv.length) opts.repoRoot = argv[++i];
    else if (arg.startsWith('--repo-root=')) opts.repoRoot = arg.slice('--repo-root='.length);
  }
  if (!opts.write && !opts.check) {
    opts.check = true;
  }
  return opts;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] || '')).href) {
  const opts = parseCliArgs(process.argv.slice(2));
  const summary = syncReadmeTables(opts);
  for (const r of summary.results) {
    console.log(`[sync-readme-tables] ${r.file}: ${r.status}`);
  }
  if (!summary.ok) {
    console.error(`[sync-readme-tables] Out of sync: ${summary.outOfSyncFiles.join(', ')}`);
    process.exit(1);
  }
}
