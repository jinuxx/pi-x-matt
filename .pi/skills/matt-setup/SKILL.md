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
  pi-upstream-sha: a496f5513d4a4cf889bc48e189e579f4b0bdf6aa
---

# Setup Matt Pocock Skills

本 skill 是 Pi-only 的一次性仓库配置流程，必须留在当前父会话中执行。先完整读取并应用[业务项目隐私契约](privacy.md)，区分业务项目与真实 package root 的源码维护例外。它建立其他 skills 读取的本地 Markdown 契约与私有入口，配置本机 Git exclude，不启动 subagent、不修改 skill 文件，也不创建远端 issue、label 或其他外部资源。

## 探索

写入前读取真实仓库状态：

1. `git remote -v` 与 `.git/config`，识别 GitHub、GitLab 或无 remote；不要仅凭目录名推断。
2. 根目录 `AGENTS.md` 作为共享工程规范只读；检查 `.pi/APPEND_SYSTEM.md` 与全局同名文件是否影响本地入口加载，不创建其他 harness 指令文件。
3. `.x-matt/agents/`、`.x-matt/work/`、`.x-matt/context/`、`.x-matt/adr/`、`.x-matt/research/` 与 `.x-matt/prototypes/`。
4. 使用 Pi 为已加载 `matt-setup` 提供的绝对 skill `location`，从该 `SKILL.md` 所在目录逐级向上，定位第一个同时包含 `package.json` 与 `config/skill-registry.json` 的目录作为 package root；不得从目标项目 cwd 或目标项目的 `.pi/` 猜测 package 内容。以该 package 的 `config/skill-registry.json` 为 skill 存在性和 `scope` / `class` / `dispatch` metadata 的权威来源；`package.json#pi.skills` 只交叉核验对应 skill 路径已作为 package resource 暴露，不能用它推导 metadata。本版本 invariant 是 `triage` 未登记，`matt-wayfinder` 与 `matt-archive` 都已登记为 `parent` / `interaction` / `dispatch: none`；同一 package 的实际文件与该 invariant 不一致时停止并报告 package drift。即使尚未移植 triage，`matt-to-spec` 与 `matt-to-tickets` 仍需要 `ready-for-agent` 映射；wayfinder 已登记时 tracker 契约还必须包含可执行的 Wayfinding operations，archive 已登记时必须包含 shipped 契约。
5. `pnpm-workspace.yaml`、`package.json#workspaces` 和真实的多包目录，只在证据充分时判断为 multi-context。

先总结已存在、缺失和可能复用的配置。已有 `.x-matt/agents/*.md` 时按更新处理，保留用户自定义内容，不从头覆盖。

## 分段决策

每节只问一个问题，使用 `ask_user_question`，并把有仓库证据的推荐项放在第一位。

### A. Issue tracker

业务项目固定使用仅本地的 Local Markdown，写入 `.x-matt/work/<feature-slug>/`，不因 GitHub/GitLab remote 自动推荐远端 tracker。已有 remote tracker 契约时先展示本地迁移 draft，不在确认前发布或改动远端数据。

只有隐私契约确认的插件源码维护例外，才允许由用户选择既有 tracker：

- GitHub remote：推荐 GitHub，使用 `gh`。
- GitLab remote：推荐 GitLab，使用 `glab`。
- 无可识别 remote：推荐 Local Markdown，写入 `.x-matt/work/<feature-slug>/`。
- Other：要求用户提供一段可执行说明，至少包含 create、read、label/status、blocking relationship 和结果核验方式。

选择 GitHub/GitLab 时先只读核验 CLI、认证和 remote 解析。remote 必须可达：在仓库内运行 `gh repo view` / `glab repo view` 能打印该项目才算通过；没有指向该 host 的 remote 时向用户索取仓库 URL，并说明需要 `git remote add origin <url>`，配好并复验前不得继续。核验失败时保持未配置，不写一个看似可用的契约。不得以 setup 名义创建远端 issue、label、project 或 repository。

### B. Label vocabulary

询问是否保留 canonical labels，推荐是：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。用户拒绝时收集现有 tracker 中的实际映射。该文件只定义语义映射，不创建远端 labels。GitHub/GitLab 缺少 canonical label 时，列出用户需要执行的精确命令（`gh label create <name>` / `glab label create <name>`），说明在 `matt-to-spec`、`matt-to-tickets` 首次发布前必须创建；setup 不代用户执行远端写操作，未创建时配置保持未完成并报告下游发布仍会 fail closed。

即使 `triage` 尚未登记，也要写 `.x-matt/agents/triage-labels.md`，因为 `matt-to-spec`、`matt-to-tickets` 和 Local Markdown lifecycle 需要区分 `spec-ready`、`shipped`、`ready-for-agent`、`resolved` 与 `out-of-scope`。`spec-ready` / `shipped` 是 parent spec lifecycle，`resolved` / `out-of-scope` 是 ticket terminal 状态；`ready-for-agent` 是 canonical triage role，也是可实现 ticket 的入口状态。

Local Markdown 的 tracker 与 triage-labels 的 `resolved` 定义必须一致：通过 TDD、验证和双轴 review，代码提交成功后才仅在本地写回，Comments 记录完整 `Implementation commit`；ticket 不暂存、不提交，其他 ticket 还须核验该实现提交属于当前 `HEAD` ancestry 才能解除 `Blocked by`，不能仅凭状态解锁。写后核验须覆盖这一定义，不能只核对状态名称。

### C. Domain docs

没有真实 monorepo signals 时直接采用 single-context：glossary 按需创建在 `.x-matt/context/GLOSSARY.md`，ADR 位于 `.x-matt/adr/`；setup 本身不创建空 glossary 或 ADR。只有发现真实多 context 时才询问是否采用 `.x-matt/context/GLOSSARY-MAP.md`，并把各 context 的 glossary 放在 `.x-matt/context/<context>/GLOSSARY.md`、ADR 放在 `.x-matt/adr/<context>/`。所有 Matt 管理的领域文档必须留在 `.x-matt/` 内。

发现 legacy `.x-matt/context/CONTEXT.md` 或 `CONTEXT-MAP.md` 时，列出精确路径并取得一次迁移批准，然后用普通 `mv` 改成 `GLOSSARY.md` / `GLOSSARY-MAP.md`（这些文件不被 Git 跟踪，不使用 `git mv`），并同步改写各自引用；未迁移时报告配置未完成，不写入指向新名称的契约，也不静默同时读取两套名称。

### D. 本地 Pi 入口

业务项目只在 `.pi/APPEND_SYSTEM.md` 原位维护唯一的 `## Agent skills` block，保留已有正文；不创建或修改共享根 `AGENTS.md`/README，不用 `AGENTS.override.md` 遮蔽团队指令，不编辑用户级 AGENTS。若 project 文件不存在而全局 APPEND_SYSTEM.md 存在，创建 project 文件会遮蔽全局内容，必须停止并按隐私契约先取得明确合并决定，不能静默覆盖。原来写进团队 AGENTS 的个人 block 只在用户批准精确迁移范围后移出，团队其他内容不动。源码维护例外允许保留仓库自己的 AGENTS 入口，不自动改为私有或取消跟踪。

## 写入前确认

展示完整 draft 并取得一次明确批准，至少包括：

- `.pi/APPEND_SYSTEM.md` 中将新增或替换的 `## Agent skills` block（源码维护例外可保留已有 AGENTS）；
- `.x-matt/agents/issue-tracker.md`；
- `.x-matt/agents/triage-labels.md`；
- `.x-matt/agents/domain.md`；
- 整个 `.x-matt/`、个人 `.pi/` 的本机 Git exclude 规则及已有 tracked 个人 AI 资料的精确迁移范围（如有）。

用户要求修改时更新 draft 并再次确认；批准前不得写文件。

本地入口 block 使用（只在本地文件中包含工具说明，不复制到团队文档）：

```markdown
## Agent skills

### Issue tracker

Issues 与 specs 仅在本机 `.x-matt/work/` 维护；整个 `.x-matt/` 与个人 `.pi/` 不进 Git。见 `.x-matt/agents/issue-tracker.md`。
已完成的 parent spec 只能由用户显式运行 `matt-archive` 归档；默认把 `.x-matt/work/shipped/` 视为不存在，只有用户在同一会话点名具体归档标题或路径时才可只读该对象。

### Triage labels

<canonical role 到实际 label/status 的一行摘要>。见 `.x-matt/agents/triage-labels.md`。

### Domain docs

<single-context 或 multi-context 的一行摘要>。见 `.x-matt/agents/domain.md`。
```

## 配置内容

本 package 已将 setup 所需的 tracker、label、domain 和 Wayfinding 行为契约内置在本 skill 中。安装后不要从用户项目寻找 `vendor/`；`vendor/` 只用于本仓库维护者的上游 provenance 与 drift 检查。

只保留当前已移植能力需要且可执行的约定；`triage` 尚未移植，可以标注为未来约定，但不得声称当前可调用。`matt-wayfinder` 与 `matt-archive` 已移植：配置不得省略 wayfinder 需要的 map、child decision ticket、blocking、frontier、claim、release、resolve、out-of-scope、fog graduation 和结果核验，也不得省略 archive 需要的 `shipped` 状态、唯一目录、资格 gate、路径改写、前后完整重读、本地移动不提交和默认不可见规则。

Local Markdown 至少定义：active spec 路径、每 implementation ticket 文件路径、唯一 archived 路径 `.x-matt/work/shipped/<feature-slug>/`、`Type`、`Parent`、`Status`、`Source session: pi:<PI_SESSION_ID>`、`Blocked by`、comments 和发布后读取核验；parent spec 只能使用 `spec-ready` / `shipped`，可实现 ticket 使用 `ready-for-agent`，完成或明确排除的 ticket 使用 `resolved` / `out-of-scope`。明确由 implement 父会话在代码提交成功后才在本地写回 `resolved`，Comments 记录 `Implementation commit: <完整 commit SHA>` 与验证/review 摘要；提交失败不写完成状态，本地写回失败则报告“代码已提交、tracker 待修复”，不重复提交。implement 不得修改 parent spec；只有用户显式调用 `matt-archive` 才能核验全部 ticket、当前分支实现提交和持久知识后写 `shipped` 并仅本地移动目录，不暂存、不创建归档提交。`resolved` 必须凭 Comments 的实现 SHA 核验 ancestry，不能依赖 ticket 的 Git 历史；`out-of-scope` 记录排除理由，不伪造实现 commit。spec 还必须在 `Reference Inputs` 中保留经脱敏、后续工作依赖且不能安全压缩的用户事实、说明、样例和约束，包括但不限于业务规则、现状描述、操作步骤及技术 contract，不能只保存 agent 的行为摘要。

业务项目的整个 `.x-matt/`（包括 agents/context/ADR/work/research/prototypes）和个人 `.pi/` 统一只在本机维护，不增加共享/私有模式开关，不被 Git 跟踪、不暂存、不提交，禁止 `git add -f`。用 `git rev-parse --git-path info/exclude` 定位本机 exclude（支持 `.git` 为文件的 worktree），用 `git rev-parse --show-prefix` 得到前缀，保留原文并按需追加 `/<前缀>.x-matt/` 与 `/<前缀>.pi/`；根项目为 `/.x-matt/` 与 `/.pi/`。用 `git check-ignore --no-index` 验证真实与计划文件、用 `git ls-files` 验证个人资料未被跟踪，不枚举已有 shipped 内容。规则冲突或团队已跟踪的配置不能自动处理，须先报告。已有个人 tracked 文件只有展示准确路径并取得迁移授权后，才可 `git rm --cached -- <准确路径>` 仅取消跟踪、保留磁盘文件；不删除文件、不重写历史、不自动提交迁移。

源码维护例外只排除整个 `.x-matt/`，`.pi/` 作为 package 源码保持跟踪；业务项目则同时排除 `/.x-matt/` 与 `/.pi/` 两个整目录。本仓库忽略 `.x-matt/` 后仍跟踪的既有契约不受影响，新增需要分发的契约文件须显式 `git add -f` 并核对结果。业务项目的 tracker、label、domain 契约都必须声明全目录隐私边界；ignored 文件按准确路径直读，不以 Git-aware 搜索或 diff 缺失判为不存在。

implementation blocker 除 `Type: ticket` / `Status: resolved` 外，还必须读取其本地 Comments 的 `Implementation commit` 并核验 commit 属于当前 `HEAD` ancestry；本地状态不会随 branch 切换回滚，不得用其他 branch 上留下的 resolved 解锁。metadata checker 不替代该核验。Wayfinder 的 decision blocking 继续使用其独立的回答/claim 协议，不要求实现 commit。

旧项目迁移时，既有 `resolved` implementation ticket 若缺少 `Implementation commit`，只能核验真实实现提交与该 ticket 对应且属于当前 `HEAD` ancestry 后，在本地 Comments 追加完整 SHA 与核验依据，保留原有完成摘要；仅修改 ticket 状态的提交不算实现证据，不按状态或时间猜测。无法核验时保留现有状态，parent spec（如有）保持 `spec-ready`，报告待补证；对应 blocker 不得解锁，feature 不得归档。不伪造完成记录，不自动重做实现。

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

1. 先验证 exclude 保护，再对批准的本地文件做小范围写入；`.pi/APPEND_SYSTEM.md` 的入口 block 已存在时原位更新，不追加重复 section，不向团队文档写入工具元信息。
2. 重新读取全部目标文件，核对 tracker 类型、路径/remote、label mapping、domain layout 和互相引用；legacy `CONTEXT.md` / `CONTEXT-MAP.md` 必须已迁移或明确报告未迁移。Local Markdown 还必须逐项核对 spec/ticket 的 `Source session` 与 `Reference Inputs` 契约、tracker/triage-labels 的 `resolved` 定义一致性（代码提交成功后仅本地写回、Comments 记录完整 `Implementation commit`、blocker 的 `HEAD` ancestry gate）、`spec-ready → shipped` 归档规则、`.x-matt/work/shipped/<feature-slug>/` 唯一路径、默认不可见/点名只读规则、map 路径、decision ticket 路径、完整 metadata 模板与 `Claimed by: None`；发现 metadata 行 `Claim:`、decision ticket 位于 `issues/` 或其他非 canonical 路径时核验失败并停止。
3. 核验业务项目整个 `.x-matt/` 与个人 `.pi/`（含入口）未被跟踪且未暂存，保护规则确实生效；默认没有共享条目；若用户批准了某项共享 `.pi` 条目，才额外验证该条目 `git check-ignore` 不匹配且可按其状态被跟踪（新条目用 `git add --dry-run`，已跟踪条目用 `git ls-files --error-unmatch`），否则报告未配置完成。不预先创建 `.x-matt/work/<feature-slug>/`。源码维护例外按源码规则核验，不取消跟踪发布资源。需要迁移的个人资料未获批准或未处理完时报告未配置完成，不隐瞒；源码维护选择 GitHub/GitLab 时只执行只读 CLI/auth/repo/label 核验。
4. Local Markdown 缺少 PI_SESSION_ID、本机 exclude、入口或任一目标文件核验失败时，明确列为未完成；仅源码维护例外选择 GitHub/GitLab/Other 时才要求 CLI、认证、remote、必要 label 或可执行 workflow。任何未完成状态都不得告诉下游 tracker 已配置。
5. 成功时报告本地文件和仍存在的历史/第三方限制，提示 `/reload` 后核验本地入口已加载，再说明 `matt-to-spec` 与 `matt-to-tickets` 会读取这些契约。日后切换布局时重新运行本 skill；普通文字调整可直接编辑本地 `.x-matt/agents/*.md`。
