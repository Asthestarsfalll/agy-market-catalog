<div align="center">

# AGY Market Catalog (`agy-market-catalog`)

**Zero-Backend GitOps Plugin Registry & Automated Indexing Engine for Google Antigravity**

1-YAML Conflict-Free Submissions · Zero-PR Release Sync · Two-Layer Namespace Anti-Collision · Multilingual `README.zh-CN.md` Extraction · Track-2 `topic:antigravity-plugin` Discovery · 4-Layer Permissive Capability Scanner · Dual Global + China Mirror Delivery

[简体中文](./README.md) · **English** · **[📖 Submission Guide (简体中文)](./docs/SUBMISSION_GUIDE.md)** · [AGY Market Client](https://github.com/azwosile/agy-market) · [Architecture & CI Spec](./AGENTS.md)

</div>

---

> **🚀 Submit Your Plugin in 5 Minutes!**
>
> Read the full step-by-step **[📖 Plugin Submission Guide (`docs/SUBMISSION_GUIDE.md`, Simplified Chinese)](./docs/SUBMISSION_GUIDE.md)** with copy-pasteable `plugin.json`, `agy-market.json`, YAML templates, all 15 categories, packaging commands, and local pre-flight checks.
>
> - **Track 1 (Recommended — Curated Catalog)**: Submit **1 flat YAML PR** once → automated CI admission & squash-merge → **future SemVer releases sync automatically every 30m with 0 PRs**.
> - **Track 2 (Experimental — Zero-PR Auto-Discovery)**: Add GitHub Topic `antigravity-plugin` and publish a SemVer Release → indexed every 6h with automatic `<owner>--<slug>` collision-safe isolation.

> This repository ([`azwosile/agy-market-catalog`](https://github.com/azwosile/agy-market-catalog)) powers the zero-backend plugin registry for **[AGY Market](https://github.com/azwosile/agy-market)**, delivering compiled static feeds via **GitHub Pages** (`https://azwosile.github.io/agy-market-catalog/index.json`, with `gh-pages` raw fallback at `https://raw.githubusercontent.com/azwosile/agy-market-catalog/gh-pages/index.json`) and the OIDC-attested pure-JSON **`@agy-market/catalog`** npm mirror transport package (`registry.npmmirror.com` / Tencent Cloud).

---

## 📦 Verified Catalog Entries (Track 1)

| ID | Canonical Name | Version | Repository | Capability Badges |
| :--- | :--- | :--- | :--- | :--- |
| `azwosile__agy-market` | `agy-market` | `1.1.0` | [`azwosile/agy-market`](https://github.com/azwosile/agy-market) | `sidecar-ui` |
| `azwosile__agy-wallpaper-prism` | `agy-wallpaper-prism` | `2.0.5` | [`azwosile/agy-wallpaper-prism`](https://github.com/azwosile/agy-wallpaper-prism) | `sidecar-ui`, `host-enhancement` (`cdp`) |
| `yunjuanyunshu114-byte__antigravity-observer` | `gemini-neko-cockpit` | `1.2.0` | [`yunjuanyunshu114-byte/antigravity-observer`](https://github.com/yunjuanyunshu114-byte/antigravity-observer) | `sidecar-ui`, `host-enhancement` (`app-asar`) |
| `zou172866__agy-dart` | `agy-dart` | `1.7.0` | [`zou172866/agy-dart`](https://github.com/zou172866/agy-dart) | `global-rules`, `sidecar-ui`, `mcp-stdio`, `lifecycle-hooks` |

---

## 🚀 Submitting a Plugin (Track-1 Single-YAML Pipeline)

> For full copy-paste templates, packaging recipes, and troubleshooting, see **[📖 `docs/SUBMISSION_GUIDE.md`](./docs/SUBMISSION_GUIDE.md)**.

Track 1 uses **one flat YAML file per plugin** for conflict-free concurrent Pull Requests and supports language-agnostic plugins (pure Markdown `skills/`/`rules/`/`agents/`, Sidebar panels, and Python/Rust/Go/Node MCP bundles) — **no `package.json` or npm publication required**.

### 1. Prepare Your Repository & Release
1. **Anti-Spam Cold-Start Threshold**: Repository must be **>= 1 day old (`MIN_AGE_DAYS = 1`)** with **>= 3 commits having distinct Git tree hashes (`MIN_NON_EMPTY_COMMITS = 3`)**.
2. **Strict 10-Field `plugin.json`**: Placed at `pluginRoot` using only Antigravity's native keys (`name`, `displayName`, `description`, `version`, `logo`, `author`, `homepage`, `repository`, `suggestedPrompts`, `disabled`). Any `logo` must be a relative path inside `pluginRoot` (never `https://`).
3. **Prebuilt GitHub Release Archive**: Publish a SemVer GitHub Release attaching a prebuilt `.tar.gz` or `.tgz` bundle (self-contained zero-build bundles may also use SemVer Git tag archives).
4. **Optional `agy-market.json`**: Declare extra `categories`, `tags`, `screenshots`, `platforms`, custom `releaseAsset`, or `preservePaths`.

### 2. Add One YAML File Under `data/plugins/`
Create `data/plugins/<owner>__<repo>.yml` (or `data/plugins/<owner>__<repo>--<subpath>.yml` for monorepos; `__` cleanly separates GitHub `owner` and `repo`):

```yaml
url: https://github.com/author/my-agy-plugin
pluginRoot: .
category: productivity
description:
  zh: 插件中文功能简介（1-2 句）
  en: Concise English summary of what the plugin provides.
```

> **Submission Guardrails**:
> - Max **`3`** added/modified entries per PR (`MAX_ENTRIES_PER_PR = 3`). Machine-computed fields (`sha256`, `npm`, `npmMirrorPkg`, `repositoryId`, `ownerId`) are forbidden in YAML.
> - Allowed `category` values (15): `monitoring-quota`, `context-cache`, `ui-themes`, `agents-reasoning`, `developer-tools`, `mcp-integrations`, `skills-workflows`, `productivity`, `data-science`, `cloud-devops`, `creative-media`, `writing-knowledge`, `automation`, `security`, `other`.
> - Optional `releaseAsset: my-plugin.tar.gz` overrides release asset selection.

#### Allowed Categories (15 Enum Values)

| Category ID | English Label | 中文分类名 |
| :--- | :--- | :--- |
| `monitoring-quota` | Telemetry & Quota | 状态与用量监控 |
| `context-cache` | Context & Cache Boost | 上下文与缓存加速 |
| `ui-themes` | UI, Themes & i18n | 界面美化与汉化 |
| `agents-reasoning` | Agents & Reasoning | 多代理与思考控制 |
| `developer-tools` | Git & DevTools | 开发与版本工具 |
| `mcp-integrations` | Browser & System MCP | 浏览器与系统 MCP |
| `skills-workflows` | Skills & Frameworks | 技能包与工程方法 |
| `productivity` | Workspace & Market | 效率与插件管理 |
| `data-science` | Data & Science | 数据与科学计算 |
| `cloud-devops` | Cloud & DevOps | 云原生与部署 |
| `creative-media` | Creative & Media | 设计与多媒体 |
| `writing-knowledge` | Writing & Knowledge | 写作与知识库 |
| `automation` | Automation | 定时与守护任务 |
| `security` | Security | 安全与审计 |
| `other` | Other | 其他扩展 |

### 3. Two-Tier Fork-Safe Auto-Admission & Zero-PR Sync
1. **Tier 1 (`pr-check.yml`, Zero Secrets)**: Immediately validates PR file paths, YAML schemas, and unit tests.
2. **Tier 2 (`pr-gate.yml`, `workflow_run` on trusted `main`)**: Checks out only trusted `main` and extracts `data/plugins/*.yml` via `git archive` — never executing PR code. Streams and validates the release tarball, checks the anti-collision ledger and 4-layer scanner, locks state (`state/ledger.json` + `state/versions-lock.json`), and squash-merges automatically.
   - Brand-new repos (`< 24h` old) that pass all static/tarball checks receive the `pending: repo-age` label with their exact UTC unlock timestamp and are auto-merged by **`regate.yml` (every 6h)**.
3. **Zero-PR Release Sync**: Once admitted, **`sync-catalog.yml` (every 30m)** automatically polls new SemVer releases, computes digests and capabilities, and republishes GitHub Pages + `@agy-market/catalog`.

---

## 🌐 Multilingual `README.zh-CN.md` Extraction

To render Simplified Chinese documentation out of the box inside AGY Market's Detail Drawer, `scripts/validate-plugin-tarball.mjs` and `scripts/build-catalog.mjs` automatically extract localized READMEs alongside the default `README.md`:

- **Simplified Chinese (`readmeZhMarkdown`)**: Checks `pluginRoot` (then archive root) in priority order:
  1. `README.zh-CN.md` / `README_zh-CN.md` (case-insensitive)
  2. `README.zh.md` / `README_zh.md`
  3. `docs/README.zh-CN.md` / `docs/README.zh.md`
  4. Falls back to `README.md` if it contains Chinese CJK characters.
- **English (`readmeEnMarkdown`)**: Checks `README.en.md`, `README.en-US.md`, `README_en.md`, `docs/README.en.md`, or falls back to an English `README.md`.
- **Backward Compatibility (`readmeMarkdown`)**: Preserves default `README.md`.

`dist/readmes.json` maintains 100% v1 client compatibility via `entries` while adding `entriesZh` and `entriesEn`:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-11-24T00:00:00.000Z",
  "entries": { "owner__repo": "# Default README.md ..." },
  "entriesZh": { "owner__repo": "# 简体中文 README ..." },
  "entriesEn": { "owner__repo": "# English README ..." }
}
```

---

## 🔍 Track 2 — `topic:antigravity-plugin` Auto-Discovery

Public repositories tagged with GitHub topic **`antigravity-plugin`** and shipping a valid SemVer release + `plugin.json` are discovered automatically with zero PRs:
- **`crawl-topics.yml` (every 6 hours)** shards `topic:antigravity-plugin archived:false` by `pushed:` date windows.
- Automatically excludes any `repositoryId` already registered in Track 1.
- Runs the identical tarball inspector, localized README extractor, and 4-layer capability scanner, enforces **`"forceScopedInstall": true`** (`<owner>--<slug>`), and publishes `dist/unverified-index.json`.

---

## 🛡️ Two-Layer Namespace Anti-Collision & Anti-RepoJacking

Because Antigravity enforces a global flat namespace on `plugin.json.name` (silently dropping duplicate names), the catalog combines two layers of protection:

1. **Layer 1 — Central Ledger Reservation (`state/ledger.json`)**:
   - First-come-first-served preservation of clean authored short names (`<dir> === plugin.json.name`, single-hyphen kebab-case `^[a-z0-9]+(-[a-z0-9]+)*$`, `--` disallowed).
   - **Immutable Numeric ID Binding**: Locks GitHub's numeric `repositoryId` & `ownerId` to defeat RepoJacking (`REPOJACKING_BLOCKED` on slug recreation), support seamless renames under the same owner, and pause ownership transfers with capability expansion (`OWNERSHIP_TRANSFER_REVIEW`).
   - Enforces reserved system/official denylists, Levenshtein `== 1` typosquatting warnings, and sub-component checks (`claimedSkills`, `claimedAgents`, and non-generic `mcp_config.json` server keys).
2. **Layer 2 — Double-Hyphen Scoped Fallback (`<owner>--<slug>`)**:
   - GitHub usernames allow single hyphens but forbid consecutive `--`, making `<owner-lower>--<slug>` collision-free across all Track-2 installs and local client conflicts.

---

## 🔬 4-Layer Permissive Static Capability & Safety Scanner (`scripts/scan-capabilities.mjs`)

All checks run strictly via zero-execution in-memory streaming:

- **Hard-Block Redlines (Genuine Supply-Chain & Exfiltration Threats Only)**:
  1. Tarball path traversal (`..`), absolute paths, or symlink/hardlink entries (`typeflag` `'1'` / `'2'`) (no artificial archive size limit; large self-contained bundles are stream-validated).
  2. Immutable tag/digest mutation (`TAG_MUTATION_BLOCKED`) against `state/versions-lock.json`.
  3. `rules/*.md` `@[label](path)` out-of-root file exfiltration (`..`, `~/`, env vars, absolute paths) and Antigravity's `24,000`-byte per-rule ceiling.
  4. Invisible Unicode Tag (`U+E0000..U+E007F`) and bidi override prompt-injection smuggling in `rules/*.md`, `skills/**/SKILL.md`, and `agents/*.md`.
  5. Active SVG XSS (`<script>`, `foreignObject`, `javascript:`, `on*=`) stripped by `scripts/sanitize-icon.mjs` + magic-byte checks for PNG/JPEG/WebP icons.
- **Permissive Capability Profiling (CDP & `app.asar` Welcomed)**:
  - Legitimate Antigravity host enhancements — including **CDP bridges** and **`resources/app.asar` patches** — are **explicitly welcomed in Track 1** and labeled transparently with a gentle `host-enhancement` (`💡 Host UI Enhancement`) badge alongside `declarative-only`, `global-rules`, `sidecar-ui`, `mcp-stdio`, `mcp-remote`, and `lifecycle-hooks`.

---

## 💻 Commands

> Requires **Node.js >= 22.0.0** (zero runtime dependencies).

```powershell
# Validate data/plugins/*.yml schemas & allowlists
npm run validate

# Build dist/{index,unverified-index,readmes}.json & dist/icons/*
npm run build

# Run anti-collision, RepoJacking, tar/PAX safety, multilingual README & 4-layer capability scanner tests
npm test

# Manually evaluate a submission entry
node scripts/check-submission.mjs data/plugins/owner__repo.yml

# Dry-run release sync offline
node scripts/sync-releases.mjs --offline
```

---

## 📚 Guides & Architecture

- **[📖 Plugin Submission Guide (`docs/SUBMISSION_GUIDE.md`)](./docs/SUBMISSION_GUIDE.md)** — Full step-by-step author tutorial, templates & FAQ (Simplified Chinese)
- Read **[`AGENTS.md`](./AGENTS.md)** and **[`../AGENTS.md`](../AGENTS.md)** before modifying scripts, schemas, or GitHub Actions workflows.

## 📄 License

[MIT License](./LICENSE)
