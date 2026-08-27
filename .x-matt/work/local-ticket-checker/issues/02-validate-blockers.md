# 02: 解析并验证 blocker lifecycle

Type: ticket
Parent: .x-matt/work/local-ticket-checker/spec.md
Status: resolved
Blocked by: .x-matt/work/local-ticket-checker/issues/01-validate-ready-ticket.md

## What to build

扩展 Local ticket checker，使其解析逗号分隔的仓库相对 blocker 路径并读取每个 blocker。只有全部 blocker 都是 `Type: ticket` 且 `Status: resolved` 时，目标 ticket 才可进入实现。

## Acceptance criteria

- [x] 所有 blocker 均为 `Type: ticket` 且 `Status: resolved` 时 exit 0，JSON `ok` 为 true。
- [x] blocker 缺失、未 resolved、不是 ticket 或路径无效时 exit 1，并在 `errors` 中说明对应引用。
- [x] 支持逗号分隔的多个 blocker 路径，输出 `blockers` 列出核验结果。
- [x] 不接受裸编号、标题、绝对路径或仓库外路径作为 blocker reference。
- [x] 测试继续通过 spawn CLI 的公开 seam 验证行为。

## Comments

- 完成 Ticket 02：通过两轮公开 CLI seam RED→GREEN，覆盖 resolved/missing/unresolved/non-ticket blocker、多引用 trim 保序、非法引用与 symlink 边界；`npm run check` 37/37 tests 通过，registry freshness 与 upstream drift 通过，fresh Standards/Spec review 均为 PASS。
