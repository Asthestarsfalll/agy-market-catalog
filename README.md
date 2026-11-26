<div align="center">

# AGY Market Catalog · 反重力插件目录 (`agy-market-catalog`)

**Google Antigravity 零后端 GitOps 官方插件目录与自动化收录引擎**

单文件 YAML 零冲突提交 · 后续发版 0 PR 自动同步 · 双层命名防碰撞与防 RepoJacking · 多语言中文 README 自动提取 · Track 2 `topic:antigravity-plugin` 自动发现 · 4 层宽容静态能力扫描 · 双通道全球 + 中国镜像分发

**简体中文** · [English](./README.en.md) · **[📖 申请收录插件完整教程](./docs/SUBMISSION_GUIDE.md)** · [AGY Market 客户端](https://github.com/azwosile/agy-market) · [架构与 CI 规范](./AGENTS.md)

</div>

---

> **🚀 插件作者快速入口 — 5 分钟上架你的 Antigravity 插件！**
>
> 👉 点击阅读 **[📖 申请收录插件完整教程 (`docs/SUBMISSION_GUIDE.md`)](./docs/SUBMISSION_GUIDE.md)**（含可直接复制粘贴的 `plugin.json`、`agy-market.json`、单文件 YAML 模板、15 个分类枚举表、打包命令与本地自检脚本）。
>
> - **方式一（推荐 · Track 1 官方认证目录）**：提交 **1 个 YAML 文件 PR** → 全自动门禁校验与自动合并 → **后续每次发版 0 PR 每 30 分钟自动同步**！
> - **方式二（Track 2 实验源免 PR）**：给公开 GitHub 仓库添加 Topic `antigravity-plugin` 并发布正式 SemVer Release → 每 6 小时自动发现，采用 `<owner>--<slug>` 安全隔离安装。
> - **语言无关 & 欢迎宿主增强**：纯 Markdown（`skills/` / `rules/` / `agents/`）、Sidebar 侧边栏、Python / Rust / Go / Node MCP 均**无需发布 npm**；CDP 与 `app.asar` 宿主界面增强插件**100% 欢迎收录**。

> 本仓库（[`azwosile/agy-market-catalog`](https://github.com/azwosile/agy-market-catalog)）是 **[AGY Market](https://github.com/azwosile/agy-market)** 的官方零后端目录注册表。
>
> 编译产物同步分发至全球主通道（`GitHub Pages`：`https://azwosile.github.io/agy-market-catalog/index.json` 及 `gh-pages` Raw 回退：`https://raw.githubusercontent.com/azwosile/agy-market-catalog/gh-pages/index.json`）与中国大陆镜像通道（`@agy-market/catalog` on `registry.npmmirror.com` / 腾讯云镜像）。

---

## 📦 已验证收录插件（Track 1）

| 目录 ID | 规范名 (`canonicalName`) | 版本 | GitHub 仓库 | 能力徽章 |
| :--- | :--- | :--- | :--- | :--- |
| `azwosile__agy-market` | `agy-market` | `1.1.0` | [`azwosile/agy-market`](https://github.com/azwosile/agy-market) | `sidecar-ui` |
| `azwosile__agy-wallpaper-prism` | `agy-wallpaper-prism` | `2.0.5` | [`azwosile/agy-wallpaper-prism`](https://github.com/azwosile/agy-wallpaper-prism) | `sidecar-ui`, `host-enhancement` (`cdp`) |
| `yunjuanyunshu114-byte__antigravity-observer` | `gemini-neko-cockpit` | `1.2.0` | [`yunjuanyunshu114-byte/antigravity-observer`](https://github.com/yunjuanyunshu114-byte/antigravity-observer) | `sidecar-ui`, `host-enhancement` (`app-asar`) |
| `zou172866__agy-dart` | `agy-dart` | `1.7.0` | [`zou172866/agy-dart`](https://github.com/zou172866/agy-dart) | `global-rules`, `sidecar-ui`, `mcp-stdio`, `lifecycle-hooks` |

---

## 🚀 提交你的插件（Track 1 单文件 YAML 提交流程）

> 完整图文与复制即用模板请直接查阅 **[📖 申请收录插件完整教程 (`docs/SUBMISSION_GUIDE.md`)](./docs/SUBMISSION_GUIDE.md)**。

Track 1 采用 **「一插件一 YAML 文件」** 的零冲突提交设计，支持纯 Markdown（`skills/` / `rules/` / `agents/`）、Sidebar 侧边栏界面以及 Python / Rust / Go / Node 等任意语言插件——**完全无需发布到 npm，也无需包含 `package.json`**。

### 第 1 步：准备插件仓库与 GitHub Release
1. 仓库需满足防垃圾冷启动门槛：**创建时长 >= 1 天（`MIN_AGE_DAYS = 1`）** 且包含 **>= 3 个不同 Git Tree 哈希的非空提交（`MIN_NON_EMPTY_COMMITS = 3`）**。
2. 插件根目录（`pluginRoot`）包含符合 Antigravity 严格 10 字段白名单的 `plugin.json`（允许键：`name`、`displayName`、`description`、`version`、`logo`、`author`、`homepage`、`repository`、`suggestedPrompts`、`disabled`；`logo` 须为包内相对路径，不可使用 `https://`）。
3. 发布至少一个正式 SemVer GitHub Release，并附带预构建完成的 `.tar.gz` 或 `.tgz` 压缩包（零构建步骤的纯声明式/自包含插件也支持直接使用 SemVer Tag 归档）。
4. （可选）在仓库根目录或 `pluginRoot` 添加 `agy-market.json` 伴随清单，声明多分类（`categories`）、标签（`tags`）、截图（`screenshots`）、平台（`platforms`）、自定义资产名（`releaseAsset`）与更新保留路径（`preservePaths`）。

### 第 2 步：新增单个 YAML 文件并提交 PR
在 `data/plugins/` 下新建 `data/plugins/<owner>__<repo>.yml`（若 Monorepo 包含多个子插件，命名为 `data/plugins/<owner>__<repo>--<subpath>.yml`；双下划线 `__` 用于无歧义分隔 GitHub 用户名与仓库名）：

```yaml
url: https://github.com/author/my-agy-plugin
pluginRoot: .
category: productivity
description:
  zh: 插件简体中文功能简介（1-2 句，直接展示在市场中文卡片中）
  en: Concise English summary of what the plugin provides.
```

> **规则速览**：
> - 单个 PR 最多新增/修改 **`3`** 个条目（`MAX_ENTRIES_PER_PR = 3`），禁止手写 `sha256`、`npm`、`npmMirrorPkg`、`repositoryId`、`ownerId` 等机算字段。
> - 允许的 `category` 枚举（15 个）：`monitoring-quota`、`context-cache`、`ui-themes`、`agents-reasoning`、`developer-tools`、`mcp-integrations`、`skills-workflows`、`productivity`、`data-science`、`cloud-devops`、`creative-media`、`writing-knowledge`、`automation`、`security`、`other`。
> - 如需指定 Release 资产文件名，可添加可选字段 `releaseAsset: my-plugin.tar.gz`。

#### 分类枚举说明表（15 个合法枚举）

| 枚举值 (`category`) | 中文分类名 | English Label |
| :--- | :--- | :--- |
| `monitoring-quota` | 状态与用量监控 | Telemetry & Quota |
| `context-cache` | 上下文与缓存加速 | Context & Cache Boost |
| `ui-themes` | 界面美化与汉化 | UI, Themes & i18n |
| `agents-reasoning` | 多代理与思考控制 | Agents & Reasoning |
| `developer-tools` | 开发与版本工具 | Git & DevTools |
| `mcp-integrations` | 浏览器与系统 MCP | Browser & System MCP |
| `skills-workflows` | 技能包与工程方法 | Skills & Frameworks |
| `productivity` | 效率与插件管理 | Workspace & Market |
| `data-science` | 数据与科学计算 | Data & Science |
| `cloud-devops` | 云原生与部署 | Cloud & DevOps |
| `creative-media` | 设计与多媒体 | Creative & Media |
| `writing-knowledge` | 写作与知识库 | Writing & Knowledge |
| `automation` | 定时与守护任务 | Automation |
| `security` | 安全与审计 | Security |
| `other` | 其他扩展 | Other |

### 第 3 步：双层 Fork 安全 CI 自动准入与零 PR 自动同步
1. **Tier 1（`pr-check.yml`，零 Secret）**：即时校验 PR 路径白名单、YAML 结构并运行单元测试。
2. **Tier 2（`pr-gate.yml`，`workflow_run` 运行在可信 `main` 分支）**：仅通过 `git archive` 提取 PR 中的 `data/plugins/*.yml`，永不检出或执行 PR 代码。自动流式校验压缩包、防冲突账本与 4 层静态安全扫描；全部通过后自动写入 `state/ledger.json` 与 `state/versions-lock.json` 并自动 Squash Merge！
   - 若新仓库未满 24 小时但其余校验全过，CI 会自动贴上 `pending: repo-age` 标签并告知解锁 UTC 时间，由 **`regate.yml`（每 6 小时）** 自动复审合并。
3. **后续发版 0-PR 自动同步**：合并后 **`sync-catalog.yml`（每 30 分钟）** 自动拉取新 SemVer Release、重新计算 `sha256` 与能力画像，并同步发布至 GitHub Pages 与 `@agy-market/catalog` npm 镜像包。

---

## 🌐 多语言中文 README 支持（`README.zh-CN.md`）

为让用户在 **AGY Market** 侧边栏详情抽屉中开箱即阅简体中文文档，本仓库的压缩包检验器（`scripts/validate-plugin-tarball.mjs`）与目录编译器（`scripts/build-catalog.mjs`）原生支持多语言 README 自动提取：

### 自动探测优先级
- **简体中文文档（`readmeZhMarkdown`）**：按顺序探测 `pluginRoot`（及压缩包根目录兜底）中的：
  1. `README.zh-CN.md` / `README_zh-CN.md`（不区分大小写）
  2. `README.zh.md` / `README_zh.md`
  3. `docs/README.zh-CN.md` / `docs/README.zh.md`
  4. 若未提供独立中文文件，但主 `README.md` 包含中文 CJK 字符，则自动采用 `README.md`。
- **英文文档（`readmeEnMarkdown`）**：按顺序探测 `README.en.md`、`README.en-US.md`、`README_en.md`、`docs/README.en.md`；若无独立英文文件且主 `README.md` 为英文文档，则自动采用 `README.md`。
- **向后兼容（`readmeMarkdown`）**：始终保留主 `README.md` 内容。

### `dist/readmes.json` 输出格式（100% 兼容 v1 客户端）
```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-11-24T00:00:00.000Z",
  "entries": {
    "owner__repo": "# Default README.md ..."
  },
  "entriesZh": {
    "owner__repo": "# 简体中文 README ..."
  },
  "entriesEn": {
    "owner__repo": "# English README ..."
  }
}
```
> **给插件作者的建议**：如果仓库默认 `README.md` 是英文，强烈建议同目录附带一份 **`README.zh-CN.md`**；若默认 `README.md` 是简体中文，则附带一份 **`README.en.md`**，目录构建器会自动同时索引双语文档！

---

## 🔍 Track 2：`topic:antigravity-plugin` 自动发现

无需提交 PR，只要为公开 GitHub 仓库添加主题标签 **`antigravity-plugin`** 并发布有效 SemVer Release（含 `plugin.json`）：
- **`crawl-topics.yml`（每 6 小时）** 按 `pushed:` 时间分片扫描 `topic:antigravity-plugin archived:false`。
- 自动跳过已在 Track 1 注册的 `repositoryId`。
- 执行与 Track 1 完全一致的压缩包校验、多语言 README 提取与 4 层静态能力扫描，并强制标记 **`"forceScopedInstall": true`**（安装时自动启用 `<owner>--<slug>` 隔离）。
- 产物编译至 `dist/unverified-index.json`（及 `dist/readmes.json`），用户在 AGY Market 设置中开启「实验性 Track 2」即可一键浏览与安装。

---

## 🛡️ 双层命名防碰撞与防 RepoJacking 机制

Antigravity 对 `plugin.json.name` 采用全局扁平命名空间——若两款本地插件同名，后发现的插件会被宿主静默丢弃。本目录采用双层纵深防御：

1. **Layer 1：Track 1 中央账本保留原生短名（`state/ledger.json`）**
   - 先到先得保留作者原生简洁短名（`<dir> === plugin.json.name`，仅允许单连字符小写 kebab-case `^[a-z0-9]+(-[a-z0-9]+)*$`，禁用 `--`）。
   - **不可变数字 ID 绑定（防 RepoJacking）**：账本永久绑定 GitHub 数字 `repositoryId` 与 `ownerId`：
     - 旧 `owner/repo` 路径出现不同 `repositoryId`（删号重建冒充）→ 硬性熔断 **`REPOJACKING_BLOCKED`**。
     - 同一 `repositoryId` 同主人改名 → 无缝迁移 `repoFullName`。
     - 同一 `repositoryId` 所有权转移且新版本权限扩张 → 挂起至 **`OWNERSHIP_TRANSFER_REVIEW`**。
   - **保留名黑名单 & 仿冒预警**：拦截内置插件（`swarm`、`agy-market`）、内置 Skills/Subagents 与官方市场 slug；对编辑距离 `Levenshtein == 1` 的近似名称发出 `WARN_TYPOSQUAT_SUSPECT` 警告，并拦截 Track 1 之间的 Skill、Subagent 重名与裸通用 MCP 键名（`search`、`db`、`fetch` 等）。
2. **Layer 2：双连字符作用域隔离（`<owner>--<slug>`）**
   - GitHub 用户名允许单连字符但不允许连续双连字符 `--`，因此 `<owner-lower>--<slug>` 在数学上天然无碰撞。
   - 自动应用于所有 **Track 2 实验性插件** 以及客户端本地预检发现的跨来源同名冲突。

---

## 🔬 4 层宽容静态能力与安全扫描器（`scripts/scan-capabilities.mjs`）

CI 全程仅在内存中流式只读分析，**绝不执行任何插件代码或 `npm install`**：

### 硬性拦截红线（仅拦截真实供应链与窃密攻击）
1. **压缩包路径穿越与符号链接投毒**：拒绝包含 `..`、绝对路径或 symlink / hardlink（`typeflag` `'1'` / `'2'`）的 tar 条目（已取消人工包体积上限，支持大体积自包含插件流式校验）。
2. **已锁定 Tag 篡改（`TAG_MUTATION_BLOCKED`）**：`state/versions-lock.json` 中已记录版本的 `commitSha` 或 `sha256` 发生任何变化即硬性拦截。
3. **`rules/*.md` 本地文件外泄与超限**：拦截正文中 `@[label](path)` 引用 `..`、`~/`、环境变量或绝对路径的行为，并强制遵守单条规则 `<= 24,000` 字节上限。
4. **不可见提示词注入走私**：拦截 `rules/*.md`、`skills/**/SKILL.md`、`agents/*.md` 中的 Unicode Tag 区段（`U+E0000..U+E007F`）与双向文本覆写字符。
5. **SVG 主动 XSS 清洗**：`scripts/sanitize-icon.mjs` 自动剥离 SVG 图标中的 `<script>`、`foreignObject`、`javascript:` 与 `on*=` 事件属性，并验证 PNG/JPEG/WebP 魔数。

### 宽容能力画像（明确欢迎 CDP 与 `app.asar` 界面增强）
所有合法的 Antigravity 扩展形态——包括 **CDP 调试桥接**（如毛玻璃/动态壁纸皮肤）与 **`resources/app.asar` 补丁**（如应用内桌面挂件）——**完全允许进入 Track 1，绝不封禁或降权**，仅透明标注温和的 `host-enhancement`（`💡 宿主界面增强`）徽章，同时完整画像 `declarative-only`、`global-rules`、`sidecar-ui`、`mcp-stdio`、`mcp-remote` 与 `lifecycle-hooks`。

---

## 💻 本地校验、编译与测试命令

> 运行环境要求：**Node.js >= 22.0.0**（零外部 npm 运行时依赖）。

```powershell
# 校验 data/plugins/*.yml 格式、命名与白名单
npm run validate

# 编译生成 dist/{index.json, unverified-index.json, readmes.json} 与 dist/icons/*
npm run build

# 运行防碰撞、RepoJacking、Tar/PAX 安全、多语言 README 提取与 4 层能力扫描单元测试
npm test

# （维护者 / 作者自检）模拟完整 Tier-2 门禁验证单个插件提交文件
node scripts/check-submission.mjs data/plugins/owner__repo.yml

# （维护者）离线演练同步脚本
node scripts/sync-releases.mjs --offline
```

---

## 📚 教程与架构规范

- **[📖 申请收录插件完整教程 (`docs/SUBMISSION_GUIDE.md`)](./docs/SUBMISSION_GUIDE.md)** — 插件作者一步步收录指南、模板与 FAQ
- **[`AGENTS.md`](./AGENTS.md)** 与 **[`../AGENTS.md`](../AGENTS.md)** — 修改脚本、Schema 或 GitHub Actions 工作流前必读

## 📄 许可证

[MIT License](./LICENSE)
