# Issue Tracker: Local Markdown

Issues 与 specs 位于仓库内的 `.x-matt/work/<feature-slug>/`。当前 tracker 不执行远端 API 或 CLI 操作。

## 路径

- Parent spec：`.x-matt/work/<feature-slug>/spec.md`
- Implementation tickets：`.x-matt/work/<feature-slug>/issues/<NN>-<slug>.md`
- `<NN>` 从 `01` 开始，并按 blockers-first 创建
- 一个 ticket 一个文件，不创建合并的 tickets 文档

`.x-matt/work/<feature-slug>/` 按需创建；setup 不预先创建空 feature 目录。

## Spec 格式

spec 文件保存 `to-spec` 已确认的完整 Markdown，并在顶部包含：

```markdown
Type: spec
Status: spec-ready
```

`spec-ready` 只表示 parent spec 可以进入 `to-tickets`，不授权 `implement` 直接实现整份 spec。只有 `Type: ticket` 且 `Status: ready-for-agent` 的单个 ticket 才是实现入口。发布后重新读取文件，核对路径、标题、正文、seams、Out of Scope、Type 和 Status。

## Ticket 格式

每个 ticket 至少包含：

```markdown
# <NN>: <Ticket title>

Type: ticket
Parent: <相对 spec 路径，或 None>
Status: ready-for-agent
Blocked by: <仓库相对 ticket 路径，或 None>

## What to build

<端到端可观察行为>

## Acceptance criteria

- [ ] <可观察且可失败的标准>

## Comments
```

`Parent` metadata 必须存在且非空。没有 parent spec 的当前会话单 slice 可以写 `None`；否则只接受 ticket 中声明的仓库相对 spec 路径，并逐个读取核对 `Type: spec` 与 `Status: spec-ready`，不得凭编号、标题或 feature 名猜测。`scripts/check-local-ticket.mjs` 只负责 Parent 字段的存在性 preflight，不解析或读取 parent；`implement` 父会话仍必须按本段验证真实 relationship。

`Blocked by` 是当前 tracker 的可核验 blocking relationship。无 blocker 时写 `None`；有 blocker 时只接受逗号分隔的仓库相对 ticket 路径，不接受裸编号、标题或绝对路径。逐个读取引用文件，只有每个 blocker 都是 `Type: ticket` 且 `Status: resolved` 时，当前 ticket 才可开始；路径缺失、状态缺失或其他状态都按未完成处理。

## 发布与读取

- “Publish spec”：创建或更新该 feature 的 `spec.md`。
- “Publish ticket”：按 blockers-first 创建单个 ticket 文件。
- “Fetch spec/ticket”：读取用户给出的仓库相对路径；不得凭编号猜测其他 feature。
- Comments 追加到 `## Comments`，不覆盖原正文。
- `implement` 完成 TDD、完整验证和双轴 review 后，由父会话把当前 Local Markdown ticket 改为 `Status: resolved`，追加完成说明，并把该 ticket 文件包含在同一个最终提交中。提交失败时撤销本次状态/comment 写入，保持 ticket 未完成。
- 每次写入后重新读取目标文件，核对 Type、Parent、Status、Blocked by、正文和验收标准；核验失败时停止后续批量写入。

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
- **Frontier**：扫描该 map 的 `decisions/`，选择 `Status: open`、全部 blockers resolved、`Claimed by: None` 的 tickets，按 `<NN>` 升序排列。
- **Claim**：稳定 identity 固定写为 `pi:<PI_SESSION_ID>`，其中 `PI_SESSION_ID` 来自当前 Pi 进程环境且必须非空；例如 `pi:01abc...`。不得改用模型名、时间戳、工作区路径或 agent 自拟字符串；环境变量缺失时 fail closed。写入前重新读取；将 `Status: claimed` 和该 `Claimed by` 一起保存，再重新读取核验。状态、claim 或 blockers 在写入期间变化时停止，不覆盖并发 session。
- **Release**：session 无法 resolve 时，先重读并确认 claim 仍为自己的 `pi:<PI_SESSION_ID>`，再同时恢复 `Status: open` 与 `Claimed by: None` 并重读核验；不得释放其他 session 的 claim。
- **Resolve**：确认 claim 仍属于当前 session；把完整答案追加到 `## Answer`，设 `Status: resolved`，再只把标题链接与一行 gist 追加到 map 的 `Decisions so far`。完整答案不复制到 map。
- **Out of scope**：设 `Status: out-of-scope`，在 map 的 `Out of scope` 追加标题链接、gist 和原因，不写入 `Decisions so far`。
- **Fog graduation**：先创建新 decision tickets，再写 blocking；核验成功后从 `Not yet specified` 删除已毕业的同一 patch，禁止两处重复。
- **结果核验**：每次写入后重读 map、变更 tickets 和引用 blockers，核对 Type、Parent、Status、Claimed by、Blocked by、Answer、title link 与当前 frontier。

Wayfinder decision tickets 不是 implementation tickets，不能进入 `implement`；cleared map 必须先进入 `to-spec`，再由 `to-tickets` 生成 `issues/` 下的 `Type: ticket` 文件。

## 当前能力边界

`to-spec`、`to-tickets` 与 `wayfinder` 已支持本契约。`triage` 尚未移植；本文件不代表 triage 当前可调用，也不应触发相应自动化。
