---
name: matt-setup
description: 为当前仓库配置 issue tracker、ready-for-agent 标签词汇和领域文档布局，使规格与 tickets 发布链可执行。
disable-model-invocation: true
metadata:
  pi-scope: parent
  pi-class: interaction
  pi-dispatch: none
  pi-depends-on: ""
  pi-upstream-path: skills/engineering/setup-matt-pocock-skills/SKILL.md
  pi-upstream-sha: 3cca18b368ae95cdbdebbff572ccafa662551015
---

# Setup Matt Pocock Skills

本 skill 是 Pi-only 的一次性仓库配置流程，必须留在当前父会话中执行。它只建立其他 skills 读取的项目内 Markdown 契约，不启动 subagent、不修改 skill 文件、不猜测 tracker，也不创建远端 issue、label 或其他外部资源。

## 探索

写入前读取真实仓库状态：

1. `git remote -v` 与 `.git/config`，识别 GitHub、GitLab 或无 remote；不要仅凭目录名推断。
2. 根目录 `AGENTS.md`；Pi-only 移植不读取或创建 `CLAUDE.md`。
3. `.x-matt/agents/`、`.x-matt/work/`、`.x-matt/context/` 与 `.x-matt/adr/`。
4. 使用 Pi 为已加载 `matt-setup` 提供的绝对 skill `location`，从该 `SKILL.md` 所在目录逐级向上，定位第一个同时包含 `package.json` 与 `config/skill-registry.json` 的目录作为 package root；不得从目标项目 cwd 或目标项目的 `.pi/` 猜测 package 内容。以该 package 的 `config/skill-registry.json` 为 skill 存在性和 `scope` / `class` / `dispatch` metadata 的权威来源；`package.json#pi.skills` 只交叉核验对应 skill 路径已作为 package resource 暴露，不能用它推导 metadata。本版本 invariant 是 `triage` 未登记，`matt-wayfinder` 与 `matt-archive` 都已登记为 `parent` / `interaction` / `dispatch: none`；同一 package 的实际文件与该 invariant 不一致时停止并报告 package drift。即使尚未移植 triage，`matt-to-spec` 与 `matt-to-tickets` 仍需要 `ready-for-agent` 映射；wayfinder 已登记时 tracker 契约还必须包含可执行的 Wayfinding operations，archive 已登记时必须包含 shipped 契约。
5. `pnpm-workspace.yaml`、`package.json#workspaces` 和真实的多包目录，只在证据充分时判断为 multi-context。

先总结已存在、缺失和可能复用的配置。已有 `.x-matt/agents/*.md` 时按更新处理，保留用户自定义内容，不从头覆盖。

## 分段决策

每节只问一个问题，使用 `ask_user_question`，并把有仓库证据的推荐项放在第一位。

### A. Issue tracker

必须由用户确认 issues 的实际存储位置：

- GitHub remote：推荐 GitHub，使用 `gh`。
- GitLab remote：推荐 GitLab，使用 `glab`。
- 无可识别 remote：推荐 Local Markdown，写入 `.x-matt/work/<feature-slug>/`。
- Other：要求用户提供一段可执行说明，至少包含 create、read、label/status、blocking relationship 和结果核验方式。

选择 GitHub/GitLab 时先只读核验 CLI、认证和 remote 解析；失败时保持未配置，不写一个看似可用的契约。不得以 setup 名义创建远端 issue、label、project 或 repository。

### B. Label vocabulary

询问是否保留 canonical labels，推荐是：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。用户拒绝时收集现有 tracker 中的实际映射。该文件只定义语义映射，不创建远端 labels；GitHub/GitLab 缺少 `ready-for-agent` 时必须报告下游发布仍会 fail closed。

即使 `triage` 尚未登记，也要写 `.x-matt/agents/triage-labels.md`，因为 `matt-to-spec`、`matt-to-tickets` 和 Local Markdown lifecycle 需要区分 `spec-ready`、`shipped`、`ready-for-agent`、`resolved` 与 `out-of-scope`。`spec-ready` / `shipped` 是 parent spec lifecycle，`resolved` / `out-of-scope` 是 ticket terminal 状态；`ready-for-agent` 是 canonical triage role，也是可实现 ticket 的入口状态。

### C. Domain docs

没有真实 monorepo signals 时直接采用 single-context：glossary 按需创建在 `.x-matt/context/CONTEXT.md`，ADR 位于 `.x-matt/adr/`；setup 本身不创建空 glossary 或 ADR。只有发现真实多 context 时才询问是否采用 `.x-matt/context/CONTEXT-MAP.md`，并把各 context 的 glossary 放在 `.x-matt/context/<context>/CONTEXT.md`、ADR 放在 `.x-matt/adr/<context>/`。所有 Matt 管理的领域文档必须留在 `.x-matt/` 内。

### D. Pi instruction file

根目录已有 `AGENTS.md` 时更新其中唯一的 `## Agent skills` block。不存在时询问是否创建项目级 `AGENTS.md`；用户拒绝则只写 `.x-matt/agents/`，并明确 Pi 不会自动获得这些入口说明。不得编辑用户级 `~/.pi/agent/AGENTS.md`。

## 写入前确认

展示完整 draft 并取得一次明确批准，至少包括：

- `AGENTS.md` 中将新增或替换的 `## Agent skills` block；
- `.x-matt/agents/issue-tracker.md`；
- `.x-matt/agents/triage-labels.md`；
- `.x-matt/agents/domain.md`。

用户要求修改时更新 draft 并再次确认；批准前不得写文件。

`AGENTS.md` block 使用：

```markdown
## Agent skills

### Issue tracker

<issues 存储位置的一行摘要>。见 `.x-matt/agents/issue-tracker.md`。
已完成的 parent spec 只能由用户显式运行 `matt-archive` 归档；默认把 `.x-matt/work/shipped/` 视为不存在，只有用户在同一会话点名具体归档标题或路径时才可只读该对象。

### Triage labels

<canonical role 到实际 label/status 的一行摘要>。见 `.x-matt/agents/triage-labels.md`。

### Domain docs

<single-context 或 multi-context 的一行摘要>。见 `.x-matt/agents/domain.md`。
```

## 配置内容

本 package 已将 setup 所需的 tracker、label、domain 和 Wayfinding 行为契约内置在本 skill 中。安装后不要从用户项目寻找 `vendor/`；`vendor/` 只用于本仓库维护者的上游 provenance 与 drift 检查。

只保留当前已移植能力需要且可执行的约定；`triage` 尚未移植，可以标注为未来约定，但不得声称当前可调用。`matt-wayfinder` 与 `matt-archive` 已移植：配置不得省略 wayfinder 需要的 map、child decision ticket、blocking、frontier、claim、release、resolve、out-of-scope、fog graduation 和结果核验，也不得省略 archive 需要的 `shipped` 状态、唯一目录、资格 gate、路径改写、前后完整重读、独立提交和默认不可见规则。

Local Markdown 至少定义：active spec 路径、每 implementation ticket 文件路径、唯一 archived 路径 `.x-matt/work/shipped/<feature-slug>/`、`Type`、`Parent`、`Status`、`Source session: pi:<PI_SESSION_ID>`、`Blocked by`、comments 和发布后读取核验；parent spec 只能使用 `spec-ready` / `shipped`，可实现 ticket 使用 `ready-for-agent`，完成或明确排除的 ticket 使用 `resolved` / `out-of-scope`。明确由 implement 父会话在最终提交中写回 `resolved`，但不得修改 parent spec；只有用户显式调用 `matt-archive` 才能核验全部 ticket、当前分支提交和持久知识后写 `shipped`、移动目录并创建独立提交。spec 还必须在 `Reference Inputs` 中保留经脱敏、后续工作依赖且不能安全压缩的用户事实、说明、样例和约束，包括但不限于业务规则、现状描述、操作步骤及技术 contract，不能只保存 agent 的行为摘要。

所有 Local Markdown 操作还必须规定：默认把 `.x-matt/work/shipped/` 视为不存在，feature 枚举、frontier 与 spec/ticket 查找都跳过它；用户在同一会话点名准确归档标题或路径时只允许读取对应对象作为历史依据，不能据此重新开启、改写、创建 ticket、进入 frontier/implement 或充当 code-review Spec 轴。用户未点名却询问历史内容时，要求其提供准确标题或路径，不自行搜索。

Local Markdown 的 Wayfinding schema 是唯一的，不得另拟字段或嵌套路径：

- Map：`.x-matt/work/<effort>/map.md`
- Child decision ticket：`.x-matt/work/<effort>/decisions/<NN>-<slug>.md`
- implementation tickets 继续位于 `.x-matt/work/<feature-slug>/issues/`；decision tickets 不得放入 `issues/`

Map 至少使用：

```markdown
# <Map title>

Type: wayfinder-map
Status: active

## Destination

<整张 map 的 destination>

## Notes

<长期约束；不得包含 agent 自行授予的 execution override>

## Decisions so far

## Not yet specified

## Out of scope
```

Child decision ticket 至少使用：

```markdown
# <NN>: <Decision title>

Type: <research|prototype|grilling|task>
Parent: <仓库相对 map 路径>
Status: open
Claimed by: None
Blocked by: <仓库相对 decision ticket 路径，或 None>

## Question

<本 ticket 需要解决的一个问题>

## Answer
```

Map 使用 `active`/`cleared` 生命周期；decision ticket 使用 `open`/`claimed`/`resolved`/`out-of-scope`。claim identity 只能写入 `Claimed by`，固定为 `pi:<PI_SESSION_ID>`；`PI_SESSION_ID` 缺失时 fail closed。不得使用 metadata 字段 `Claim:`，也不得用模型名、时间戳、工作区路径或 agent 自拟字符串代替 session identity。Wayfinding operations 还必须逐项定义 blocking、frontier、claim、release、resolve、out-of-scope、fog graduation 和结果核验。

GitHub/GitLab 至少定义：CLI、repo 解析、create/read、label、native blocking/sub-issue 优先级、fallback body reference、Wayfinding operations 和发布后查询核验。Other 必须达到同等可执行程度，否则停止。

## 写入与验证

1. 对批准文件做小范围写入；`AGENTS.md` block 已存在时原位更新，不追加重复 section。
2. 重新读取全部目标文件，核对 tracker 类型、路径/remote、label mapping、domain layout 和互相引用。Local Markdown 还必须逐项核对 spec/ticket 的 `Source session` 与 `Reference Inputs` 契约、`spec-ready → shipped` 归档规则、`.x-matt/work/shipped/<feature-slug>/` 唯一路径、默认不可见/点名只读规则、map 路径、decision ticket 路径、完整 metadata 模板与 `Claimed by: None`；发现 metadata 行 `Claim:`、decision ticket 位于 `issues/` 或其他非 canonical 路径时核验失败并停止。
3. Local Markdown 不预先创建 `.x-matt/work/<feature-slug>/`；GitHub/GitLab 只执行只读 CLI/auth/repo/label 核验。
4. 缺少 CLI、认证、remote、必要 label、可执行 Other workflow 或任一目标文件核验失败时，明确列为未完成；不得告诉下游 tracker 已配置。
5. 成功时报告修改文件，并说明 `matt-to-spec` 与 `matt-to-tickets` 现在会读取这些契约。日后切换 tracker 或布局时重新运行本 skill；普通文字调整可直接编辑 `.x-matt/agents/*.md`。
