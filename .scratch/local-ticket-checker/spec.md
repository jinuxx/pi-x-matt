Type: spec
Status: spec-ready

# Local Ticket Checker

## Problem Statement

Local Markdown 生命周期目前只有文字契约，父会话无法通过稳定的公开命令验证 ticket 是否可进入 implement。

## Solution

提供只读 CLI：

```bash
node scripts/check-local-ticket.mjs <repo-relative-ticket-path>
```

## User Stories

1. 父会话可以验证目标是 `Type: ticket` 且 `Status: ready-for-agent`。
2. 父会话可以确认所有 blocker 都是 `Type: ticket` 且 `Status: resolved`。
3. 调用者通过退出码与 JSON 获得可机器读取的结果。

## Implementation Decisions

- 仅使用 Node.js 标准库。
- 输入必须是仓库内 `.scratch/` 下的相对路径。
- `Parent` 在本 CLI 中只做非空存在性 preflight；允许 `None` 或非空 reference，但不读取、解析或验证 parent 文件。真实 parent relationship 由 `implement` 父会话按 tracker 契约核验。
- `Blocked by` 仅接受 `None` 或逗号分隔的仓库相对 ticket 路径，不接受裸编号或标题。
- stdout JSON 包含 `ok`、`ticket`、`blockers`、`errors`。
- 合法且未阻塞时 exit 0；其他情况 exit 1。
- CLI 只读，不修改 ticket。

## Testing Decisions

- 最高公开 seam：spawn CLI，观察 exit code 与 stdout JSON。
- 使用临时仓库 fixture 验证 ready、spec、错误状态、缺失 blocker、未 resolved blocker 和 resolved blocker。
- 不直接测试内部 parser helper。

## Out of Scope

- 修改 ticket 状态
- Remote tracker
- Parent 文件解析与 relationship 校验
- Project writer lock
- triage/wayfinder

## Further Notes

分两个 vertical slices：先验证无 blocker ticket，再扩展 blocker resolution。
