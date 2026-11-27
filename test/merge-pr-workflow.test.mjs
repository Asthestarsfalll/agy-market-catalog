import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { authorizeComment, formatComment, parseDiffOutput } from '../scripts/admit-pr-helper.mjs';
import { evaluateSubmission } from '../scripts/check-submission.mjs';
import { createTarGzBuffer } from '../scripts/lib/tar-stream.mjs';
import {
  buildTrack1TableRows,
  CATALOG_TABLE_END,
  CATALOG_TABLE_START,
  formatCapabilityBadges,
  renderTrack1CatalogTable,
  replaceCatalogTableSection,
  syncReadmeTables,
} from '../scripts/sync-readme-tables.mjs';

const __testDir = dirname(fileURLToPath(import.meta.url));
const CATALOG_REPO_ROOT = resolve(__testDir, '..');
const WORKFLOWS_DIR = join(CATALOG_REPO_ROOT, '.github', 'workflows');

const CLEAN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect x="16" y="16" width="96" height="96" rx="20" fill="#6366f1"/></svg>`;
const COMMIT_SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function assertPureLfNoBom(content, label) {
  assert.equal(content.charCodeAt(0) === 0xfeff, false, `${label} must not contain a UTF-8 BOM`);
  assert.equal(content.includes('\r'), false, `${label} must use pure LF line endings`);
}

function assertValidWorkflowYamlSyntax(content, filename) {
  const lines = content.split('\n');
  let inBlockScalar = false;
  let blockIndent = -1;

  for (let idx = 0; idx < lines.length; idx++) {
    const lineNo = idx + 1;
    const raw = lines[idx];
    if (!raw.trim() || /^\s*#/.test(raw)) continue;

    const indent = raw.match(/^ */)[0].length;
    if (inBlockScalar) {
      if (indent > blockIndent) continue;
      inBlockScalar = false;
      blockIndent = -1;
    }

    assert.equal(raw.includes('\t'), false, `${filename}:${lineNo} contains forbidden tab indentation`);

    const trimmed = raw.trim();
    if (/^(?:-\s+)?[A-Za-z0-9_.-]+\s*:\s*[>|][+-]?\d*\s*(?:#.*)?$/.test(trimmed) || /^run\s*:\s*[>|][+-]?\s*$/.test(trimmed)) {
      inBlockScalar = true;
      blockIndent = indent;
      continue;
    }

    // Catch the exact GitHub Actions YAML failure mode from regate.yml#L26:
    // unquoted `- name: foo: bar` scalar containing `: `
    const stepNameMatch = /^-\s*name\s*:\s*(.+)$/.exec(trimmed);
    if (stepNameMatch) {
      const val = stepNameMatch[1].trim();
      const isQuoted =
        (val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"));
      if (!isQuoted) {
        assert.equal(
          /:\s/.test(val),
          false,
          `${filename}:${lineNo} has unquoted ': ' inside step name scalar: ${trimmed}`,
        );
      }
    }
  }

  assert.match(content, /^name:\s+\S+/m, `${filename} missing top-level name`);
  assert.match(content, /^on:\s*$/m, `${filename} missing top-level on:`);
  assert.match(content, /^jobs:\s*$/m, `${filename} missing top-level jobs:`);
}

function makeRichTarball({ name = 'alpha-plugin', version = '1.0.0', extraFiles = {} } = {}) {
  return createTarGzBuffer({
    'plugin.json': JSON.stringify({
      name,
      displayName: name,
      version,
      description: 'Test Antigravity plugin bundle',
      logo: 'assets/logo.svg',
      suggestedPrompts: ['Run plugin'],
    }),
    'assets/logo.svg': CLEAN_SVG,
    'README.md': `# ${name}\n\nTest plugin readme.`,
    [`skills/${name}/SKILL.md`]: `---\nname: ${name}\ndescription: Test skill\n---\n# ${name}\n\nSkill docs.\n`,
    ...extraFiles,
  });
}

test('All .github/workflows/*.yml pass LF/BOM, YAML syntax, fork-safety, and concurrency invariants', () => {
  const wfFiles = readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort();

  assert.deepEqual(wfFiles, [
    'crawl-topics.yml',
    'ingest-nomination.yml',
    'merge-pr.yml',
    'pr-check.yml',
    'pr-gate.yml',
    'regate.yml',
    'sync-catalog.yml',
  ]);

  for (const wf of wfFiles) {
    const raw = readFileSync(join(WORKFLOWS_DIR, wf), 'utf8');
    assertPureLfNoBom(raw, wf);
    assertValidWorkflowYamlSyntax(raw, wf);
    assert.equal(raw.includes('pull_request_target'), false, `${wf} must never use pull_request_target`);
  }

  for (const stateWf of [
    'crawl-topics.yml',
    'ingest-nomination.yml',
    'merge-pr.yml',
    'pr-gate.yml',
    'regate.yml',
    'sync-catalog.yml',
  ]) {
    const raw = readFileSync(join(WORKFLOWS_DIR, stateWf), 'utf8');
    assert.match(raw, /group:\s*catalog-state-publish/, `${stateWf} missing shared concurrency group`);
    assert.match(raw, /cancel-in-progress:\s*false/, `${stateWf} must set cancel-in-progress: false`);
    assert.match(raw, /timeout-minutes:\s*\d+/, `${stateWf} missing timeout-minutes`);
  }

  for (const wfName of ['merge-pr.yml', 'pr-gate.yml', 'regate.yml']) {
    const wfBody = readFileSync(join(WORKFLOWS_DIR, wfName), 'utf8');
    assert.ok(wfBody.includes('ERR_PR_SYMLINK_FORBIDDEN'), `${wfName} must block extracted symlinks`);
    assert.ok(wfBody.includes('[ -L '), `${wfName} must check [ -L ... ] before copying extracted YAML`);
    assert.ok(wfBody.includes('cp -P '), `${wfName} must use cp -P when copying extracted YAML`);
  }

  const mergePr = readFileSync(join(WORKFLOWS_DIR, 'merge-pr.yml'), 'utf8');
  assert.ok(mergePr.includes('workflow_dispatch:'));
  assert.ok(mergePr.includes('pr_number:'));
  assert.ok(mergePr.includes('dry_run:'));
  assert.ok(mergePr.includes('skip_age_check:'));
  assert.ok(mergePr.includes('issue_comment:'));
  assert.ok(mergePr.includes('github.event.issue.pull_request != null'));
  assert.ok(mergePr.includes('OWNER') && mergePr.includes('MEMBER') && mergePr.includes('COLLABORATOR'));
  assert.ok(mergePr.includes('content=rocket'));
  assert.ok(mergePr.includes('ref: main'));
  assert.ok(mergePr.includes('git archive "$PR_HEAD_SHA"'));
  assert.ok(mergePr.includes('admit-pr-helper.mjs parse-diff'));
  assert.ok(mergePr.includes('admit-pr-helper.mjs authorize-comment'));
  assert.ok(mergePr.includes('admit-pr-helper.mjs format-comment'));
  assert.ok(mergePr.includes('check-submission.mjs'));
  assert.ok(mergePr.includes('--match-head-commit'));
  assert.ok(mergePr.includes('git reset --hard origin/main'));
  assert.ok(mergePr.includes('sync-readme-tables.mjs --write'));
  assert.ok(mergePr.includes('build-catalog.mjs'));
  assert.ok(mergePr.includes('gh-pages:gh-pages'));

  for (const gateWfName of ['pr-gate.yml', 'regate.yml']) {
    const gateWf = readFileSync(join(WORKFLOWS_DIR, gateWfName), 'utf8');
    assert.equal(gateWf.includes('approved-state'), false, `${gateWfName} must not clobber state with stale snapshot`);
    assert.equal(gateWf.includes('regate-state-'), false, `${gateWfName} must not clobber state with stale snapshot`);
    assert.ok(gateWf.includes('--match-head-commit'), `${gateWfName} must guard merge with --match-head-commit`);
    assert.ok(gateWf.includes('git reset --hard origin/main'), `${gateWfName} must reset to merged origin/main`);
    assert.ok(gateWf.includes('sync-readme-tables.mjs --write'), `${gateWfName} must sync README tables`);
    assert.ok(gateWf.includes('build-catalog.mjs'), `${gateWfName} must rebuild dist/`);
    assert.ok(gateWf.includes('gh-pages:gh-pages'), `${gateWfName} must deploy gh-pages`);
  }

  const regateWf = readFileSync(join(WORKFLOWS_DIR, 'regate.yml'), 'utf8');
  assert.equal(/echo "\$prs"\s*\|\s*while read/.test(regateWf), false, 'regate.yml must not run while loop in pipe subshell');

  const prCheckWf = readFileSync(join(WORKFLOWS_DIR, 'pr-check.yml'), 'utf8');
  assert.ok(prCheckWf.includes('admit-pr-helper.mjs parse-diff'));
  assert.ok(prCheckWf.includes('git merge-base'));

  const ingestWf = readFileSync(join(WORKFLOWS_DIR, 'ingest-nomination.yml'), 'utf8');
  assert.match(ingestWf, /types:\s*\[opened,\s*labeled\]/);

  const syncWf = readFileSync(join(WORKFLOWS_DIR, 'sync-catalog.yml'), 'utf8');
  assert.ok(syncWf.includes('node scripts/sync-readme-tables.mjs --write'));
  assert.ok(syncWf.includes('README.md') && syncWf.includes('README.en.md'));
});

test('admit-pr-helper parseDiffOutput handles renames, limits, and forbidden paths', () => {
  const okDiff = parseDiffOutput(
    [
      'A\tdata/plugins/alice__one.yml',
      'M\tdata/plugins/alice__two.yml',
      'R100\tdata/plugins/alice__old.yml\tdata/plugins/alice__renamed.yml',
    ].join('\n'),
  );
  assert.deepEqual(okDiff.deleted, ['data/plugins/alice__old.yml']);
  assert.deepEqual(okDiff.changedYmls, [
    'data/plugins/alice__one.yml',
    'data/plugins/alice__renamed.yml',
    'data/plugins/alice__two.yml',
  ]);

  assert.throws(
    () => parseDiffOutput('R100\tdata/plugins/alice__one.yml\tscripts/evil.mjs\n'),
    /ERR_PR_PATH_FORBIDDEN/,
  );
  assert.throws(
    () => parseDiffOutput('R100\tREADME.md\tdata/plugins/alice__one.yml\n'),
    /ERR_PR_PATH_FORBIDDEN/,
  );
  assert.throws(
    () =>
      parseDiffOutput(
        [
          'A\tdata/plugins/a__1.yml',
          'A\tdata/plugins/a__2.yml',
          'A\tdata/plugins/a__3.yml',
          'A\tdata/plugins/a__4.yml',
        ].join('\n'),
      ),
    /ERR_PR_TOO_MANY_ENTRIES/,
  );
  assert.throws(
    () => parseDiffOutput(['D\tdata/plugins/a__1.yml', 'D\tdata/plugins/a__2.yml', 'D\tdata/plugins/a__3.yml'].join('\n')),
    /ERR_PR_MASS_DELETION/,
  );

  const cliOut = execFileSync(process.execPath, [join(CATALOG_REPO_ROOT, 'scripts', 'admit-pr-helper.mjs'), 'parse-diff'], {
    input: 'A\tdata/plugins/bob__tool.yml\n',
    encoding: 'utf8',
  });
  assert.deepEqual(JSON.parse(cliOut).changedYmls, ['data/plugins/bob__tool.yml']);
});

test('admit-pr-helper authorizeComment enforces slash grammar, PR context, and maintainer associations', () => {
  assert.deepEqual(
    authorizeComment({ body: '  /merge --dry-run --skip-age-check \n', authorAssociation: 'OWNER', isPullRequest: true }),
    {
      authorized: true,
      isCommand: true,
      command: 'merge',
      dryRun: true,
      skipAgeCheck: true,
      reason: null,
    },
  );
  assert.equal(authorizeComment({ body: '/admit', authorAssociation: 'COLLABORATOR', isPullRequest: true }).authorized, true);
  assert.equal(authorizeComment({ body: '/merge', authorAssociation: 'MEMBER', isPullRequest: true }).authorized, true);

  const nonMaintainer = authorizeComment({ body: '/merge', authorAssociation: 'CONTRIBUTOR', isPullRequest: true });
  assert.equal(nonMaintainer.authorized, false);
  assert.equal(nonMaintainer.isCommand, true);
  assert.match(nonMaintainer.reason, /ERR_UNAUTHORIZED_ASSOCIATION/);

  const onIssue = authorizeComment({ body: '/merge', authorAssociation: 'OWNER', isPullRequest: false });
  assert.equal(onIssue.authorized, false);

  const badFlags = authorizeComment({ body: '/merge --evil;id', authorAssociation: 'OWNER', isPullRequest: true });
  assert.equal(badFlags.authorized, false);
  assert.equal(badFlags.isCommand, true);

  const chatter = authorizeComment({ body: 'Looks great! Thanks for /merge tip', authorAssociation: 'OWNER', isPullRequest: true });
  assert.equal(chatter.authorized, false);
  assert.equal(chatter.isCommand, false);

  const cliAuth = execFileSync(
    process.execPath,
    [join(CATALOG_REPO_ROOT, 'scripts', 'admit-pr-helper.mjs'), 'authorize-comment'],
    {
      env: { ...process.env, COMMENT_BODY: '/merge --dry-run', AUTHOR_ASSOCIATION: 'OWNER', IS_PULL_REQUEST: 'true' },
      encoding: 'utf8',
    },
  );
  assert.equal(JSON.parse(cliAuth).authorized, true);
  assert.equal(JSON.parse(cliAuth).dryRun, true);
});

test('admit-pr-helper formatComment renders bilingual ZH/EN comments for all 4 modes', () => {
  const summary = {
    results: [
      {
        file: 'data/plugins/alice__tool.yml',
        status: 'APPROVED',
        canonicalName: 'alice-tool',
        version: '1.2.3',
        sha256: 'deadbeef1234567890',
        badges: ['sidecar-ui', 'host-enhancement'],
        hostEnhancementKind: ['cdp'],
        unlockAtUtc: null,
        warnings: ['WARN_TYPOSQUAT_SUSPECT: close to tool'],
        error: null,
      },
      {
        file: 'data/plugins/bob__new.yml',
        status: 'PENDING_REPO_AGE',
        canonicalName: 'bob-new',
        version: '0.1.0',
        sha256: 'cafe123456',
        badges: [],
        hostEnhancementKind: [],
        unlockAtUtc: '2026-11-28T00:00:00.000Z',
        warnings: [],
        error: null,
      },
      {
        file: 'data/plugins/eve__bad.yml',
        status: 'FAILED',
        canonicalName: null,
        version: null,
        sha256: null,
        badges: [],
        hostEnhancementKind: [],
        unlockAtUtc: null,
        warnings: [],
        error: 'ERR_MISSING_PREBUILT_RELEASE ```breakout```',
      },
    ],
  };

  const dryRunMd = formatComment({ mode: 'dry-run', prNumber: 42, summary, headSha: COMMIT_SHA_A });
  assert.ok(dryRunMd.includes('[DRY RUN]'));
  assert.ok(dryRunMd.includes('`host-enhancement` (`cdp`)'));
  assert.ok(dryRunMd.includes('WARN_TYPOSQUAT_SUSPECT'));

  const pendingMd = formatComment({ mode: 'pending-age', prNumber: 42, summary });
  assert.ok(pendingMd.includes('2026-11-28T00:00:00.000Z'));
  assert.ok(pendingMd.includes('MIN_AGE_DAYS = 1'));

  const rejectedMd = formatComment({ mode: 'rejected', prNumber: 42, summary });
  assert.ok(rejectedMd.includes("'''breakout'''"));
  assert.ok(rejectedMd.includes('ERR_MISSING_PREBUILT_RELEASE'));

  const approvedMd = formatComment({ mode: 'approved', prNumber: 42, summary, runUrl: 'https://github.com/example/runs/1' });
  assert.ok(approvedMd.includes('#42'));
  assert.ok(approvedMd.includes('state/ledger.json'));
});

test('sync-readme-tables deterministically generates Track-1 tables, handles markers/LF, and skips markerless files', () => {
  const pkg = JSON.parse(readFileSync(join(CATALOG_REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['sync:readme'], 'node scripts/sync-readme-tables.mjs --write');

  const tmp = mkdtempSync(join(tmpdir(), 'agy-readme-sync-'));
  try {
    mkdirSync(join(tmp, 'data', 'plugins'), { recursive: true });
    mkdirSync(join(tmp, 'state'), { recursive: true });

    writeFileSync(
      join(tmp, 'data', 'plugins', 'zou172866__agy-dart.yml'),
      'url: https://github.com/zou172866/agy-dart\npluginRoot: .\ncategory: context-cache\ndescription:\n  zh: 高速上下文加速 | 缓存守卫\n  en: Context accelerator | cache guard\n',
      'utf8',
    );
    writeFileSync(
      join(tmp, 'data', 'plugins', 'azwosile__agy-market.yml'),
      'url: https://github.com/azwosile/agy-market\npluginRoot: .\ncategory: developer-tools\ndescription:\n  zh: 官方市场客户端\n  en: Official marketplace client\n',
      'utf8',
    );
    writeFileSync(
      join(tmp, 'state', 'ledger.json'),
      JSON.stringify({
        schemaVersion: 1,
        entries: {
          'agy-dart': {
            entrySlug: 'zou172866__agy-dart',
            canonicalName: 'agy-dart',
            repoFullName: 'zou172866/Antigravity-agy-dart',
            status: 'active',
          },
          'agy-market': {
            entrySlug: 'azwosile__agy-market',
            canonicalName: 'agy-market',
            repoFullName: 'azwosile/agy-market',
            status: 'active',
          },
          'gone-plugin': {
            entrySlug: 'old__gone',
            canonicalName: 'gone-plugin',
            repoFullName: 'old/gone',
            status: 'DEPRECATED_GONE',
          },
        },
      }),
      'utf8',
    );
    writeFileSync(
      join(tmp, 'state', 'versions-lock.json'),
      JSON.stringify({
        schemaVersion: 1,
        locks: {
          'zou172866__agy-dart': {
            latest: '1.7.8',
            versions: {
              '1.7.8': {
                manifest: { description: 'Fallback' },
                capabilities: { badges: ['global-rules', 'sidecar-ui'], hostEnhancementKind: [] },
              },
            },
          },
          'azwosile__agy-market': {
            latest: '1.7.1',
            versions: {
              '1.7.1': {
                manifest: { description: 'Fallback' },
                capabilities: { badges: ['sidecar-ui', 'host-enhancement'], hostEnhancementKind: ['cdp'] },
              },
            },
          },
          'old__gone': {
            latest: '0.1.0',
            versions: { '0.1.0': { manifest: { description: 'Gone' }, capabilities: { badges: [] } } },
          },
        },
      }),
      'utf8',
    );

    // Without markers: silently skips and --check passes
    writeFileSync(join(tmp, 'README.md'), '# Header\r\nNo markers yet\r\n', 'utf8');
    const skipRes = syncReadmeTables({ repoRoot: tmp, check: true });
    assert.equal(skipRes.ok, true);
    assert.equal(skipRes.results[0].status, 'skipped_no_markers');

    // Add markers with CRLF + BOM + stale content
    writeFileSync(
      join(tmp, 'README.md'),
      `\uFEFF# Header\r\n${CATALOG_TABLE_START}\r\nstale\r\n${CATALOG_TABLE_END}\r\nFooter\r\n`,
      'utf8',
    );
    writeFileSync(
      join(tmp, 'README.en.md'),
      `# Header EN\n${CATALOG_TABLE_START}\nstale\n${CATALOG_TABLE_END}\nFooter EN\n`,
      'utf8',
    );

    const checkFail = syncReadmeTables({ repoRoot: tmp, check: true });
    assert.equal(checkFail.ok, false);
    assert.deepEqual(checkFail.outOfSyncFiles, ['README.md', 'README.en.md']);

    const writeRes = syncReadmeTables({ repoRoot: tmp, write: true });
    assert.equal(writeRes.rowCount, 2);

    const zhOut = readFileSync(join(tmp, 'README.md'), 'utf8');
    const enOut = readFileSync(join(tmp, 'README.en.md'), 'utf8');
    assertPureLfNoBom(zhOut, 'synced README.md');
    assertPureLfNoBom(enOut, 'synced README.en.md');

    assert.ok(zhOut.includes('`1.7.1`'));
    assert.ok(zhOut.includes('`1.7.8`'));
    assert.ok(zhOut.includes('[`zou172866/Antigravity-agy-dart`](https://github.com/zou172866/Antigravity-agy-dart)'));
    assert.ok(zhOut.includes('`host-enhancement` (`cdp`)'));
    assert.ok(zhOut.includes('高速上下文加速 \\| 缓存守卫'));
    assert.ok(enOut.includes('Context accelerator \\| cache guard'));
    assert.equal(zhOut.includes('gone-plugin'), false);

    // Idempotent check via CLI
    execFileSync(
      process.execPath,
      [join(CATALOG_REPO_ROOT, 'scripts', 'sync-readme-tables.mjs'), '--check', '--repo-root', tmp],
      { encoding: 'utf8' },
    );

    // Sanity check unit exports directly
    assert.equal(formatCapabilityBadges({ badges: [] }), '`declarative-only`');
    assert.equal(
      replaceCatalogTableSection('plain text', 'table').skipped,
      true,
    );
    assert.ok(renderTrack1CatalogTable(buildTrack1TableRows({ entries: [], ledger: { entries: {} }, versionsLock: { locks: {} } }), 'en').includes('_None_'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('check-submission evaluates all multi-entry files into --json-summary and supports --allow-pending-age', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agy-check-sub-'));
  const oldTar = makeRichTarball({ name: 'old-ok', version: '1.0.0' });
  const youngTar = makeRichTarball({ name: 'young-ok', version: '2.0.0' });

  const now = Date.now();
  const oldCreatedAt = new Date(now - 72 * 3_600_000).toISOString();
  const youngCreatedAt = new Date(now - 2 * 3_600_000).toISOString();

  // Direct unit check for evaluateSubmission allowPendingAge
  const baseEvalArgs = {
    entry: { entrySlug: 'alice__young-ok', repoFullName: 'alice/young-ok', pluginRoot: '.' },
    repoMeta: { id: 202, owner: { id: 20 }, full_name: 'alice/young-ok', created_at: youngCreatedAt, stargazers_count: 1 },
    commits: [
      { commit: { tree: { sha: 't1111111' } } },
      { commit: { tree: { sha: 't2222222' } } },
      { commit: { tree: { sha: 't3333333' } } },
    ],
    releaseInfo: { tagName: 'v2.0.0', commitSha: COMMIT_SHA_A, tarballUrl: 'https://example.invalid/y.tgz', publishedAt: now },
    tarballBuffer: youngTar,
    ledger: { schemaVersion: 1, entries: {} },
    versionsLock: { schemaVersion: 1, locks: {} },
    nowMs: now,
  };
  assert.equal(evaluateSubmission({ ...baseEvalArgs, allowPendingAge: false }).status, 'PENDING_REPO_AGE');
  const overridden = evaluateSubmission({ ...baseEvalArgs, allowPendingAge: true });
  assert.equal(overridden.status, 'APPROVED');
  assert.ok(overridden.warnings.some((w) => w.startsWith('WARN_AGE_OVERRIDE_USED')));

  let server;
  let port = 0;
  try {
    server = createServer((req, res) => {
      const url = req.url || '';
      if (url === '/repos/alice/old-ok') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 101, owner: { id: 10 }, full_name: 'alice/old-ok', created_at: oldCreatedAt, stargazers_count: 5 }));
      } else if (url === '/repos/alice/young-ok') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 202, owner: { id: 20 }, full_name: 'alice/young-ok', created_at: youngCreatedAt, stargazers_count: 2 }));
      } else if (url === '/repos/alice/bad-entry') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Not Found' }));
      } else if (url.endsWith('/commits?per_page=15')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify([
            { commit: { tree: { sha: '11111111' } } },
            { commit: { tree: { sha: '22222222' } } },
            { commit: { tree: { sha: '33333333' } } },
          ]),
        );
      } else if (url === '/repos/alice/old-ok/releases/latest') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            tag_name: 'v1.0.0',
            published_at: oldCreatedAt,
            assets: [{ name: 'old-ok.tar.gz', browser_download_url: `http://127.0.0.1:${port}/downloads/old-ok.tar.gz` }],
          }),
        );
      } else if (url === '/repos/alice/young-ok/releases/latest') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            tag_name: 'v2.0.0',
            published_at: youngCreatedAt,
            assets: [{ name: 'young-ok.tar.gz', browser_download_url: `http://127.0.0.1:${port}/downloads/young-ok.tar.gz` }],
          }),
        );
      } else if (url.includes('/commits/v1.0.0') || url.includes('/commits/v2.0.0')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sha: COMMIT_SHA_A }));
      } else if (url === '/downloads/old-ok.tar.gz') {
        res.writeHead(200, { 'Content-Type': 'application/gzip' });
        res.end(oldTar);
      } else if (url === '/downloads/young-ok.tar.gz') {
        res.writeHead(200, { 'Content-Type': 'application/gzip' });
        res.end(youngTar);
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    port = server.address().port;

    mkdirSync(join(tmp, 'data', 'plugins'), { recursive: true });
    mkdirSync(join(tmp, 'state'), { recursive: true });
    writeFileSync(join(tmp, 'state', 'ledger.json'), JSON.stringify({ schemaVersion: 1, entries: {} }), 'utf8');
    writeFileSync(join(tmp, 'state', 'versions-lock.json'), JSON.stringify({ schemaVersion: 1, locks: {} }), 'utf8');

    const oldYaml = join(tmp, 'data', 'plugins', 'alice__old-ok.yml');
    const badYaml = join(tmp, 'data', 'plugins', 'alice__bad-entry.yml');
    const youngYaml = join(tmp, 'data', 'plugins', 'alice__young-ok.yml');

    writeFileSync(oldYaml, 'url: https://github.com/alice/old-ok\npluginRoot: .\ncategory: productivity\ndescription:\n  zh: 测试旧插件\n  en: Old ok plugin\n', 'utf8');
    writeFileSync(badYaml, 'url: https://github.com/alice/bad-entry\npluginRoot: .\ncategory: productivity\ndescription:\n  zh: 测试失败插件\n  en: Bad entry plugin\n', 'utf8');
    writeFileSync(youngYaml, 'url: https://github.com/alice/young-ok\npluginRoot: .\ncategory: productivity\ndescription:\n  zh: 测试新插件\n  en: Young ok plugin\n', 'utf8');

    const env = {
      ...process.env,
      AGY_CATALOG_REPO_ROOT: tmp,
      AGY_GITHUB_API_BASE: `http://127.0.0.1:${port}`,
    };

    const runCliAsync = (args) =>
      new Promise((resolveProc, rejectProc) => {
        const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => {
          stdout += d;
        });
        child.stderr.on('data', (d) => {
          stderr += d;
        });
        child.on('error', rejectProc);
        child.on('close', (status) => resolveProc({ status, stdout, stderr }));
      });

    // 1. Mixed 3-entry PR: APPROVED + FAILED + PENDING_REPO_AGE -> must evaluate ALL 3 and exit 1
    const mixedSummaryPath = join(tmp, 'mixed-summary.json');
    const mixedRun = await runCliAsync([
      join(CATALOG_REPO_ROOT, 'scripts', 'check-submission.mjs'),
      '--json-summary',
      mixedSummaryPath,
      oldYaml,
      badYaml,
      youngYaml,
    ]);
    assert.equal(mixedRun.status, 1);
    const mixedSummary = JSON.parse(readFileSync(mixedSummaryPath, 'utf8'));
    assert.equal(mixedSummary.overallStatus, 'FAILED');
    assert.deepEqual(mixedSummary.counts, { total: 3, approved: 1, pendingRepoAge: 1, failed: 1 });
    assert.equal(mixedSummary.results[0].status, 'APPROVED');
    assert.equal(mixedSummary.results[0].version, '1.0.0');
    assert.ok(mixedSummary.results[0].sha256);
    assert.equal(mixedSummary.results[1].status, 'FAILED');
    assert.match(mixedSummary.results[1].error, /404/);
    assert.equal(mixedSummary.results[2].status, 'PENDING_REPO_AGE');
    assert.ok(mixedSummary.results[2].unlockAtUtc);

    // 2. APPROVED + PENDING_REPO_AGE -> exit 78
    const pendingSummaryPath = join(tmp, 'pending-summary.json');
    const pendingRun = await runCliAsync([
      join(CATALOG_REPO_ROOT, 'scripts', 'check-submission.mjs'),
      '--json-summary',
      pendingSummaryPath,
      oldYaml,
      youngYaml,
    ]);
    assert.equal(pendingRun.status, 78);
    assert.equal(JSON.parse(readFileSync(pendingSummaryPath, 'utf8')).overallStatus, 'PENDING_REPO_AGE');

    // 3. --allow-pending-age --write-state -> exit 0 and writes ledger/lock in temp repo
    const overrideSummaryPath = join(tmp, 'override-summary.json');
    const overrideRun = await runCliAsync([
      join(CATALOG_REPO_ROOT, 'scripts', 'check-submission.mjs'),
      '--write-state',
      '--allow-pending-age',
      '--json-summary',
      overrideSummaryPath,
      oldYaml,
      youngYaml,
    ]);
    assert.equal(overrideRun.status, 0);
    const overrideSummary = JSON.parse(readFileSync(overrideSummaryPath, 'utf8'));
    assert.equal(overrideSummary.overallStatus, 'APPROVED');
    assert.ok(overrideSummary.results[1].warnings.some((w) => w.startsWith('WARN_AGE_OVERRIDE_USED')));
    const writtenLedger = JSON.parse(readFileSync(join(tmp, 'state', 'ledger.json'), 'utf8'));
    assert.ok(writtenLedger.entries['old-ok']);
    assert.ok(writtenLedger.entries['young-ok']);
  } finally {
    if (server) await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(tmp, { recursive: true, force: true });
  }
});
