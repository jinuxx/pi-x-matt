# Issue Tracker: Local Markdown

Issues 与 specs 位于仓库内的 `.scratch/<feature-slug>/`。当前 tracker 不执行远端 API 或 CLI 操作。

## 路径

- Parent spec：`.scratch/<feature-slug>/spec.md`
- Implementation tickets：`.scratch/<feature-slug>/issues/<NN>-<slug>.md`
- `<NN>` 从 `01` 开始，并按 blockers-first 创建
- 一个 ticket 一个文件，不创建合并的 tickets 文档

`.scratch/<feature-slug>/` 按需创建；setup 不预先创建空 feature 目录。

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
Blocked by: <ticket 路径/编号，或 None>

## What to build

<端到端可观察行为>

## Acceptance criteria

- [ ] <可观察且可失败的标准>

## Comments
```

`Blocked by` 是当前 tracker 的可核验 blocking relationship。无 blocker 时写 `None`；有 blocker 时逐个读取引用文件，只有每个 blocker 都是 `Type: ticket` 且 `Status: resolved` 时，当前 ticket 才可开始。路径缺失、状态缺失或其他状态都按未完成处理。

## 发布与读取

- “Publish spec”：创建或更新该 feature 的 `spec.md`。
- “Publish ticket”：按 blockers-first 创建单个 ticket 文件。
- “Fetch spec/ticket”：读取用户给出的仓库相对路径；不得凭编号猜测其他 feature。
- Comments 追加到 `## Comments`，不覆盖原正文。
- `implement` 完成 TDD、完整验证和双轴 review 后，由父会话把当前 Local Markdown ticket 改为 `Status: resolved`，追加完成说明，并把该 ticket 文件包含在同一个最终提交中。提交失败时撤销本次状态/comment 写入，保持 ticket 未完成。
- 每次写入后重新读取目标文件，核对 Type、Parent、Status、Blocked by、正文和验收标准；核验失败时停止后续批量写入。

## 当前能力边界

`to-spec` 与 `to-tickets` 已支持本契约。`triage` 与 `wayfinder` 尚未移植；本文件不代表它们当前可调用，也不应触发相应自动化。
