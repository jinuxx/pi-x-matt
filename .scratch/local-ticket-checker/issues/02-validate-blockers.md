# 02: 解析并验证 blocker lifecycle

Type: ticket
Parent: .scratch/local-ticket-checker/spec.md
Status: ready-for-agent
Blocked by: .scratch/local-ticket-checker/issues/01-validate-ready-ticket.md

## What to build

扩展 Local ticket checker，使其解析逗号分隔的仓库相对 blocker 路径并读取每个 blocker。只有全部 blocker 都是 `Type: ticket` 且 `Status: resolved` 时，目标 ticket 才可进入实现。

## Acceptance criteria

- [ ] 所有 blocker 均为 `Type: ticket` 且 `Status: resolved` 时 exit 0，JSON `ok` 为 true。
- [ ] blocker 缺失、未 resolved、不是 ticket 或路径无效时 exit 1，并在 `errors` 中说明对应引用。
- [ ] 支持逗号分隔的多个 blocker 路径，输出 `blockers` 列出核验结果。
- [ ] 不接受裸编号、标题、绝对路径或仓库外路径作为 blocker reference。
- [ ] 测试继续通过 spawn CLI 的公开 seam 验证行为。

## Comments
