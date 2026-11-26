# AGY Market Catalog — GitOps Auto-Collection & Anti-Collision Specification (`agy-market-catalog/AGENTS.md`)

> **Repository**: `agy-market-catalog` (Zero-backend GitOps plugin registry, two-tier fork-safe PR gate, batched GraphQL release crawler, Track-2 `topic:antigravity-plugin` discovery crawler, and `@agy-market/catalog` mirror data package)  
> **Cross-Repo Contracts**: Read [`../AGENTS.md`](../AGENTS.md) for canonical JSON schemas (`index.json`, `unverified-index.json`, `ledger.json`, `versions-lock.json`, `agy-market.json`).  
> **Security Invariant**: CI workflows in this repository MUST NEVER execute untrusted plugin code, `npm install` scripts, or PR branch code with repository secrets. All tarball inspection and capability profiling are strictly streaming/static.

---

## 1. Repository Layout

```text
agy-market-catalog/
├── AGENTS.md                        # Catalog pipeline, anti-collision & CI security rules (this file)
├── README.md                        # Contributor submission guide (auto-updated table on main)
├── LICENSE                          # MIT License
├── package.json                     # ESM scripts ("@agy-market/catalog" data publishing & node --test)
├── .github/
│   └── workflows/
│       ├── pr-check.yml             # Tier-1 PR lint (pull_request, 0 secrets)
│       ├── pr-gate.yml              # Tier-2 PR admission & auto-merge (workflow_run + git archive)
│       ├── regate.yml               # Every 6h: re-evaluates `pending: repo-age` PRs & auto-merges
│       ├── sync-catalog.yml         # Every 30m: batched GraphQL release sync + Pages & npm publish
│       └── crawl-topics.yml         # Every 6h: Track-2 `topic:antigravity-plugin` -> unverified-index.json
├── data/
│   └── plugins/                     # 1 flat YAML file per Track-1 plugin: <owner>__<repo>[--<subpath>].yml
├── schemas/                         # JSON/YAML validation definitions
├── scripts/
│   ├── validate-entries.mjs         # Validates YAML syntax, slug format & allowlisted keys
│   ├── check-submission.mjs         # Verifies repo age/commits, numeric IDs, release tarball & ledger collisions
│   ├── scan-capabilities.mjs        # 4-layer static capability & safety scanner (permissive CDP/asar policy)
│   ├── sanitize-icon.mjs            # Strips SVG scripts/event-handlers & normalizes PNG/WebP/SVG icons
│   ├── sync-releases.mjs            # Batched GraphQL release poller + append-only versions-lock.json updater
│   ├── crawl-topics.mjs             # Sharded GitHub Topic crawler for Track-2 unverified-index.json
│   ├── probe-npm.mjs                # Optional bidirectional npm mirror verification (anti-squatting)
│   ├── build-catalog.mjs            # Compiles dist/{index,unverified-index,readmes}.json + dist/icons/*
│   └── publish-catalog-npm.mjs      # Publishes @agy-market/catalog via npm OIDC when content hash changes
├── state/
│   ├── ledger.json                  # Authoritative canonicalName + repositoryId/ownerId claim ledger
│   └── versions-lock.json           # Append-only release tag + 40-hex commitSha + tarball sha256 lockfile
└── test/                            # `node --test` collision, RepoJacking, tar-safety & scanner unit tests
```

---

## 2. Conflict-Free Submission Schema (Track 1)

1. **One Flat YAML Per Plugin**:
   - Path: `data/plugins/<owner>__<repo>.yml` (or `data/plugins/<owner>__<repo>--<subpath-with-dashes>.yml` when a monorepo houses multiple Antigravity plugins).
   - Why `__` (double underscore): GitHub usernames cannot contain `_`, so splitting on the first `__` recovers `<owner>` and `<repo>` unambiguously.
   - `README.md` catalog tables are regenerated **only post-merge on `main`**, guaranteeing **zero merge conflicts** across concurrent PRs.
2. **PR Size Cap & Allowed Keys**:
   - **`MAX_ENTRIES_PER_PR = 3`**.
   - Allowed YAML keys: `url` (required `https://github.com/<owner>/<repo>`), `pluginRoot` (optional relative path, default `"."`), `category` (required taxonomy key), `description` (`{ zh, en }`), `releaseAsset` (optional asset filename override).
   - **No Handwritten `npm` or `sha256` Fields**: Hashes, numeric repo IDs, capability badges, and optional npm mirror mappings are 100% machine-computed to prevent spoofing.

---

## 3. Two-Tier Fork-Safe Auto-Admission Pipeline

### 3.1 Tier 1 — `pr-check.yml` (`on: pull_request`, Zero Secrets)
Runs immediately on untrusted fork PRs with `permissions: contents: read`:
- Verifies changed files match `^data/plugins/[a-z0-9-]+__[a-z0-9._-]+\\.yml$` (`<= 3` added/modified entries).
- Blocks accidental stale-fork mass deletions (`> 2` deleted `.yml` files).
- Runs `node scripts/validate-entries.mjs` and the `node --test` collision & schema suite.

### 3.2 Tier 2 — `pr-gate.yml` (`on: workflow_run` of Tier 1, Trusted `origin/main`)
**Never use `pull_request_target` checkout on PR branches.** Instead:
1. Check out trusted `origin/main`.
2. Extract **only** `data/plugins/*.yml` from the PR head SHA into a temporary scratch directory via `git archive` (no code or scripts from the PR are ever materialized or executed).
3. Run `scripts/check-submission.mjs` against added/modified entries:
   - **Repository Liveness & Origin**: Confirm GitHub repository exists (`200 OK`), `archived === false`, `disabled === false`, and is not a clone/fork of first-party Antigravity product repositories.
   - **Cold-Start Anti-Spam Gate (`MIN_AGE_DAYS = 1` + `MIN_NON_EMPTY_COMMITS = 3`)**:
     - Verify `Date.now() - Date.parse(repo.created_at) >= 86_400_000` (**>= 1 full day**).
     - Fetch default-branch commit history and verify **at least 3 commits with distinct root Git `commit.tree.sha` hashes** (defeating `git commit --allow-empty` 10-second loop gaming while remaining friendly to genuine young repos).
     - If all checks pass *except* `MIN_AGE_DAYS = 1`, apply label `pending: repo-age` and post a friendly comment stating the exact UTC timestamp when **`regate.yml`** (scheduled every 6 hours) will re-verify and auto-merge the PR.
   - **Mandatory Prebuilt Release Tarball Check (Language-Agnostic, Non-npm Native)**:
     - Require at least one published GitHub Release containing a `.tar.gz` or `.tgz` prebuilt plugin bundle (selected via `agy-market.json` / YAML `releaseAsset`, or single `.tar.gz`/`.tgz` release asset; **never** raw GitHub `source archive` unless it already contains prebuilt self-contained files with zero build step, though dedicated release asset tarballs are preferred).
     - **Do NOT require `package.json` or npm publication**—pure Markdown `skills/`/`rules/`/`agents/` plugins and Python/Rust/Go MCP plugins are first-class citizens.
     - Stream-inspect the tarball (`node:zlib` + safe tar parser with no artificial archive size limit, discarding >4 MB non-text binary payloads from RAM while rejecting `..` traversal and symlinks):
       1. Confirm `<pluginRoot>/plugin.json` exists and parses cleanly.
       2. Confirm every top-level key in `plugin.json` belongs to Antigravity's 10-field allowlist (`name`, `displayName`, `description`, `version`, `author`, `homepage`, `repository`, `logo`, `suggestedPrompts`, `disabled`).
       3. Confirm `plugin.json.logo` (if set) is a relative path ending in `.svg`, `.png`, `.jpg`, `.jpeg`, or `.webp` whose file exists inside `<pluginRoot>/` (never an `https://` URL).
   - **Ledger Collision & Anti-Squatting Check** (see §4) + **4-Layer Static Safety Scan** (see §6).
4. When all gates pass: commit updated `state/ledger.json` + `state/versions-lock.json` and trigger automatic squash-merge of the PR.

---

## 4. Authoritative Anti-Collision & Anti-RepoJacking Ledger (`state/ledger.json`)

1. **Global `canonicalName` Uniqueness**:
   - In Track 1, `canonicalName` MUST equal `plugin.json.name` (`^[a-z0-9]+(-[a-z0-9]+)*$`, single hyphens only; `--` is reserved exclusively for Layer-2 scoped installs).
   - If `canonicalName` is already claimed by another `repositoryId` in `state/ledger.json`, fail PR check with `ERR_NAME_COLLISION` and instruct the author either to pick a distinct `plugin.json.name` (while keeping their human title in `displayName`) or use scoped naming.
2. **Reserved System & Official Denylist + Typosquatting Guard**:
   - Reject built-in plugin names (`swarm`), market self-name (`agy-market`), built-in subagents (`self`, `browser`, `research`, `deepagent`, `review-agent`, `image-generator`), built-in skills (`plugin`, `agy-customizations`, `antigravity-guide`, `automation`, `generative_ui`, `mcp-app-development`, `migrate-agent-settings`, `migrate-workflows`, `run-workflow`, `swarm_monitor`, `swarm_pane`, `ui-plugin-navigation`), and reserved official Agent Marketplace IDs.
   - Flag Levenshtein distance `== 1` against top installed plugins (`WARN_TYPOSQUAT_SUSPECT`).
3. **Sub-Component Collision Checks**:
   - Verify `skills/<skill>/SKILL.md` frontmatter `name` matches `<skill>` directory name and does not collide with `claimedSkills` of active Track-1 plugins.
   - Verify `agents/<agent>.md` names do not collide with built-in subagents or `claimedAgents`.
   - Verify `mcp_config.json` server keys avoid bare generic names (`search`, `db`, `filesystem`, `fetch`).
4. **Immutable Numeric GitHub ID Binding (Defeating RepoJacking)**:
   - Every ledger record stores numeric `repositoryId` (`repo.id`) and `ownerId` (`repo.owner.id`).
   - During every scheduled sync, query by numeric ID (`/repositories/<repositoryId>`) as well as current `owner/repo`:
     - **Case A (`repositoryId` changed at old `owner/repo` URL)**: Original author deleted/renamed account and a third party recreated `<owner>/<repo>` -> **Hard-block (`REPOJACKING_BLOCKED`)**, freeze last safe version, never pull from the impostor repo.
     - **Case B (`repositoryId` unchanged, `repo.full_name` renamed under same `ownerId`)**: Update `repoFullName` seamlessly while preserving `canonicalName` and leave a redirect alias from old `id`.
     - **Case C (`repositoryId` unchanged, `ownerId` changed — Repository Ownership Transfer)**: Transition status to `OWNERSHIP_TRANSFER_REVIEW`; hold automatic updates if new release expands capabilities (`hooks.json`, `mcp_config.json`, `sidecar.json`, `app.asar`) until verified.

---

## 5. Dual-Track Automated Crawlers & Mirror Publishing

### 5.1 Track-1 Zero-PR Release Sync (`sync-catalog.yml`, Every 30 Minutes)
- Batch-query registered `repositoryId`s via **GitHub GraphQL API** (`nodes(ids: [...])`, **50–80 repositories per request** -> ~20–80 quota points per run even at 5,000+ plugins).
- For any repo with a new SemVer GitHub Release tag:
  1. Verify existing locked tags in `state/versions-lock.json` were NOT force-pushed or re-uploaded with a different `commitSha` or `sha256` (if mutated -> **`TAG_MUTATION_BLOCKED`**).
  2. Stream-download the new release `.tar.gz`, validate `plugin.json` + optional `agy-market.json`, run `scan-capabilities.mjs`, sanitize icon into `dist/icons/<entrySlug>.<ext>`, and append the new version (`gitTag`, `commitSha`, `tarballUrl`, `sha256`, `sizeBytes`) to `state/versions-lock.json`.

### 5.2 Track-2 Built-In Topic Discovery (`crawl-topics.yml`, Every 6 Hours)
- Built into MVP v1 to provide zero-friction discovery alongside Track 1.
- Queries GitHub Search API for `topic:antigravity-plugin archived:false` sharded by `pushed:` windows to stay below the 1,000-result cap and 30 req/min limit.
- Skips any `repositoryId` already registered in Track 1 (`state/ledger.json`).
- Validates presence of a prebuilt release `.tar.gz` (or valid self-contained plugin archive) + `plugin.json`, runs the same 4-layer static capability scanner, sets **`"forceScopedInstall": true`** (`<owner-lower>--<slug>`), and outputs **`dist/unverified-index.json`**.

### 5.3 Dual Static Delivery (`GitHub Pages` + `@agy-market/catalog` npm Mirror)
- `build-catalog.mjs` outputs deterministic `{index.json, unverified-index.json, readmes.json, icons/*}`.
- **Channel 1**: Deploys static artifacts to GitHub Pages (with CORS `*` and immutable icon cache headers).
- **Channel 2**: If the SHA-256 of `{index.json, unverified-index.json, readmes.json}` changed since the last run, `publish-catalog-npm.mjs` publishes a new `YYYY.MMDD.RUN` version of **`@agy-market/catalog`** to npm using **GitHub Actions OIDC Provenance** (`--provenance`). Mainland China mirrors (`registry.npmmirror.com`, `mirrors.cloud.tencent.com/npm`) automatically sync this pure-JSON data package within minutes—giving `agy-market` clients zero-backend China high availability even though individual Antigravity plugins are NOT npm packages.
- **Optional `probe-npm.mjs` Anti-Squatting Check**: Only when a plugin bundle *also* includes a `package.json` published on npm AND `registry.npmjs.org/<pkg>.latest.repository` points back to the exact verified `owner/repo` (`repositoryId`), populate `distribution.npmMirrorPkg` as an auxiliary tarball mirror.

---

## 6. Four-Layer Static Capability & Safety Scanner (`scripts/scan-capabilities.mjs`)

### 6.1 Hard-Block Rules (Genuine Supply-Chain / Exfiltration Attacks Only)
CI rejects a release ONLY when any of the following redlines are tripped:
1. **Archive Traversal / Symlink Poisoning**: Tarball contains `..` path segments, absolute paths, or symlink/hardlink entries (`typeflag` `'1'` or `'2'`).
2. **Tag / Digest Mutation**: An already-recorded `gitTag` in `state/versions-lock.json` changes its `commitSha` or asset `sha256` (`TAG_MUTATION_BLOCKED`).
3. **Rules Local-File Exfiltration (`@[label](path)` Escape)**: Antigravity expands `@[label](path)` inside `rules/*.md`. Any `rules/*.md` referencing `..`, `~/`, environment variables, or absolute paths outside `<pluginRoot>` (e.g., attempting to inline `~/.ssh/id_rsa` or `~/.gemini/config/config.json` into the LLM context) is **hard-blocked**.
4. **Invisible Prompt-Injection Smuggling**: Unicode Tag block characters (`U+E0000..U+E007F`) or bidirectional override spoofing characters inside `rules/*.md`, `skills/**/SKILL.md`, or `agents/*.md`.
5. **Active SVG XSS**: `<script>`, `foreignObject`, `javascript:` URIs, or `on*=` event attributes inside SVG logos (automatically stripped by `sanitize-icon.mjs`, or rejected if malformed).

### 6.2 Permissive Capability Profiling (Including `CDP` & `app.asar`)
All legitimate Antigravity extension mechanisms—including **CDP bridges** and **`resources/app.asar` modifications**—are **permitted** and profiled transparently into `capabilities`:
- **`declarative-only`**: Only `skills/` and/or `agents/`, zero `rules/`, `sidecars/`, `mcp_config.json`, or `hooks.json`.
- **`global-rules`**: Contains `rules/*.md`; computes `rulesEstimatedTokens` (`Math.ceil(utf8Bytes / 4)`) and enforces Antigravity's `<= 24,000` bytes/file ceiling.
- **`sidecar-ui`**: Contains `sidecars/*/sidecar.json`.
- **`mcp-stdio` / `mcp-remote`**: Parsed from `mcp_config.json` (records remote `https://` hostnames in `mcpRemoteDomains[]`).
- **`lifecycle-hooks`**: Contains `<pluginRoot>/hooks.json` (records subscribed hook events such as `SessionStart`, `PreToolUse`, `PostToolUse`, `Stop` in `hookEvents[]`).
- **`host-enhancement` (Subtle / Mild Notice Only)**: Triggered when static scan detects CDP usage (`--remote-debugging-port`, `webSocketDebuggerUrl`, `Runtime.evaluate`) or `app.asar` patching (`app.asar`, `asar.extractAll`, `asar.createPackage`). **Never block or penalize these plugins**—record `hostEnhancementKind: ["cdp" | "app-asar"]` so `agy-market` renders a gentle `💡 宿主界面增强` tag beside the Install button.
