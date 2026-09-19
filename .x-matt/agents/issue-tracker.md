# Issue Tracker: Local Markdown

Active issues 与 specs 位于仓库内的 `.x-matt/work/<feature-slug>/`。已归档 feature 只位于唯一子目录 `.x-matt/work/shipped/<feature-slug>/`。当前 tracker 不执行远端 API 或 CLI 操作。

## 路径

- Parent spec：`.x-matt/work/<feature-slug>/spec.md`
- Implementation tickets：`.x-matt/work/<feature-slug>/issues/<NN>-<slug>.md`
- Archived feature：`.x-matt/work/shipped/<feature-slug>/`，保持 `spec.md` 与 `issues/` 相对结构不变
- `<NN>` 从 `01` 开始，并按 blockers-first 创建
- 一个 ticket 一个文件，不创建合并的 tickets 文档

`.x-matt/work/<feature-slug>/` 按需创建；setup 不预先创建空 feature 目录。

## Spec 格式

spec 文件保存 `to-spec` 已确认的完整 Markdown，并在顶部包含：

```markdown
Type: spec
Status: spec-ready
Source session: pi:<PI_SESSION_ID>
```

parent spec 的 `Status` 只有 `spec-ready` 与 `shipped`。`spec-ready` 只表示 parent spec 可以进入 `to-tickets`，不授权 `implement` 直接实现整份 spec；`shipped` 是显式归档终态，不能回到 active lifecycle。只有 `Type: ticket` 且 `Status: ready-for-agent` 的单个 ticket 才是实现入口。用户提供且后续工作依赖、不能安全压缩的事实、说明、样例或约束，经过 secrets 脱敏后写入 `## Reference Inputs`；内容可以是业务规则、现状描述、操作步骤、边界解释、样例或技术 contract，不以特定项目或材料类型为限，也不得只保存 agent 的行为摘要。发布后重新读取文件，核对路径、标题、正文、seams、Out of Scope、Reference Inputs、Type、Status 和 Source session。

## Ticket 格式

每个 ticket 至少包含：

```markdown
# <NN>: <Ticket title>

Type: ticket
Parent: <相对 spec 路径，或 None>
Status: ready-for-agent
Source session: pi:<PI_SESSION_ID>
Blocked by: <仓库相对 ticket 路径，或 None>

## What to build

<端到端可观察行为>

## Acceptance criteria

- [ ] <可观察且可失败的标准>

## Comments
```

新发布的 spec/ticket 必须从当前 Pi 进程读取非空 `PI_SESSION_ID`，并写为 `Source session: pi:<PI_SESSION_ID>`；不得用模型名、时间戳或工作区路径代替。`Parent` metadata 必须存在且非空。没有 parent spec 的当前会话单 slice 可以写 `None`；否则只接受 ticket 中声明的仓库相对 spec 路径，并逐个读取核对 `Type: spec` 与 `Status: spec-ready`，不得凭编号、标题或 feature 名猜测。`scripts/check-local-ticket.mjs` 只负责 Parent 字段的存在性 preflight，不解析或读取 parent；`implement` 父会话仍必须按本段验证真实 relationship。

`Blocked by` 是当前 tracker 的可核验 blocking relationship。无 blocker 时写 `None`；有 blocker 时只接受逗号分隔的仓库相对 ticket 路径，不接受裸编号、标题或绝对路径。逐个读取引用文件，只有每个 blocker 都是 `Type: ticket` 且 `Status: resolved` 时，当前 ticket 才可开始；路径缺失、状态缺失或其他状态都按未完成处理。

## 发布与读取

- “Publish spec”：创建或更新该 feature 的 `spec.md`。
- “Publish ticket”：按 blockers-first 创建单个 ticket 文件。
- “Fetch spec/ticket”：读取用户给出的仓库相对路径；不得凭编号猜测其他 feature。
- Comments 追加到 `## Comments`，不覆盖原正文。
- `implement` 完成 TDD、完整验证和双轴 review 后，由父会话把当前 Local Markdown ticket 改为 `Status: resolved`，追加完成说明，并把该 ticket 文件包含在同一个最终提交中。提交失败时撤销本次状态/comment 写入，保持 ticket 未完成。
- 每次写入后重新读取目标文件，核对 Type、Parent、Status、Source session、Blocked by、Reference Inputs（spec）、正文和验收标准；核验失败时停止后续批量写入。

## Parent spec 归档

归档只能由用户在独立步骤中显式调用 `matt-archive` 并给出准确 feature slug；不得进入 `matt-implement`、`matt-tdd` 或任何 workflow lane。`matt-implement` 仍只能把当前 implementation ticket 写为 `resolved`，不得修改 parent spec 状态。

只有同时满足以下条件，parent spec 才能从 `spec-ready` 改为 `shipped`：

1. 该 feature 的全部 implementation tickets 都是 `resolved` 或 `out-of-scope`，不存在 `ready-for-agent` 或其他状态；每个 Blocked by 都是 `None` 或只引用该 feature 内的真实 ticket，存在跨 feature blocker 时不得归档；
2. 各 terminal ticket 的完成状态和相关实现提交已落在当前 branch；
3. 实现中产生的 canonical term、跨会话事实和 ADR 级决定已写入 `.x-matt/context/CONTEXT.md` 或 `.x-matt/adr/`，或经核验明确没有新增持久知识。

归档从干净工作区开始，把 `.x-matt/work/<feature-slug>/` 整体移动到 `.x-matt/work/shipped/<feature-slug>/`，不重命名文件、不删除 ticket。移动时只允许把 spec 的 `Status: spec-ready` 改为 `Status: shipped`，并改写全部 tickets 的 Parent 路径与内部 Blocked by 路径到 shipped 新位置。处理前后都必须完整读取 spec 与全部 tickets，并按原文只允许上述 metadata 变化的方式核对正文无损坏；移动、状态和路径改写必须独占一个提交，摘要使用 `chore: 归档 <feature-slug> 规格`。

`.x-matt/work/shipped/` 默认对模型不可见：读取 `.x-matt/work/`、枚举 feature、计算 frontier 或寻找 ticket/spec 时必须跳过该子目录，不得输出其中路径或标题，也不得把归档内容作为 `matt-to-tickets`、`matt-implement`、`matt-wayfinder` 或 `matt-code-review` Spec 轴的候选、入口或近似回退来源。用户询问未点名的历史 spec 时，只说明内容已归档并要求用户给出准确标题或路径，不得自行搜索。

只有用户在同一会话明确点名某个已归档 spec 的标题或路径时，才允许读取对应 archived feature，授权只覆盖该对象且只读、只在当前会话有效。读取结果只能作为历史依据；不得重新开启 ticket、改写状态、创建新 ticket、放回 frontier 或触发实现。即使获得该只读授权，shipped spec 也不能成为当前 `matt-code-review` Spec 轴规格。`scripts/check-local-ticket.mjs` 必须把 shipped ticket、指向 shipped parent 的 ticket 和需要读取 shipped blocker 的 ticket 判为非入口。

## Wayfinding operations

Wayfinder artifacts 与后续 implementation tickets 分目录保存，避免 decision ticket 编号和 `to-tickets` 的 `issues/` 冲突：

- Map：`.x-matt/work/<effort>/map.md`
- Child decision ticket：`.x-matt/work/<effort>/decisions/<NN>-<slug>.md`
- `<NN>` 从 `01` 开始；frontier 稳定顺序按编号升序

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

清空 gate 全部满足后才把 map 改为 `Status: cleared`。Child decision ticket 至少使用：

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

- **Blocking**：逐个读取 `Blocked by` 引用；只有所有引用 ticket 都是同一 map 的 child 且 `Status: resolved` 才算 unblocked。路径缺失、跨 map、`out-of-scope` 或其他状态均保持 blocked。
- **Frontier**：只扫描 active map 自己的 `decisions/`，默认跳过整个 `.x-matt/work/shipped/`；选择 `Status: open`、全部 blockers resolved、`Claimed by: None` 的 tickets，按 `<NN>` 升序排列。
- **Claim**：稳定 identity 固定写为 `pi:<PI_SESSION_ID>`，其中 `PI_SESSION_ID` 来自当前 Pi 进程环境且必须非空；例如 `pi:01abc...`。不得改用模型名、时间戳、工作区路径或 agent 自拟字符串；环境变量缺失时 fail closed。写入前重新读取；将 `Status: claimed` 和该 `Claimed by` 一起保存，再重新读取核验。状态、claim 或 blockers 在写入期间变化时停止，不覆盖并发 session。
- **Release**：session 无法 resolve 时，先重读并确认 claim 仍为自己的 `pi:<PI_SESSION_ID>`，再同时恢复 `Status: open` 与 `Claimed by: None` 并重读核验；不得释放其他 session 的 claim。
- **Resolve**：确认 claim 仍属于当前 session；把完整答案追加到 `## Answer`，设 `Status: resolved`，再只把标题链接与一行 gist 追加到 map 的 `Decisions so far`。完整答案不复制到 map。
- **Out of scope**：设 `Status: out-of-scope`，在 map 的 `Out of scope` 追加标题链接、gist 和原因，不写入 `Decisions so far`。
- **Fog graduation**：先创建新 decision tickets，再写 blocking；核验成功后从 `Not yet specified` 删除已毕业的同一 patch，禁止两处重复。
- **结果核验**：每次写入后重读 map、变更 tickets 和引用 blockers，核对 Type、Parent、Status、Claimed by、Blocked by、Answer、title link 与当前 frontier。

Wayfinder decision tickets 不是 implementation tickets，不能进入 `implement`；cleared map 必须先进入 `to-spec`，再由 `to-tickets` 生成 `issues/` 下的 `Type: ticket` 文件。

## 当前能力边界

`to-spec`、`to-tickets` 与 `wayfinder` 已支持本契约。`triage` 尚未移植；本文件不代表 triage 当前可调用，也不应触发相应自动化。
