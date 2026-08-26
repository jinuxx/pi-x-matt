# 01: 验证无 blocker ticket 的实现入口

Type: ticket
Parent: .scratch/local-ticket-checker/spec.md
Status: resolved
Blocked by: None

## What to build

提供 `node scripts/check-local-ticket.mjs <repo-relative-ticket-path>`，验证仓库内 `.scratch/` ticket 的入口 metadata，并通过退出码和 JSON 返回结果。本 slice 只处理 `Blocked by: None`。

## Acceptance criteria

- [x] 输入 `Type: ticket`、`Status: ready-for-agent`、`Blocked by: None` 的有效文件时 exit 0，JSON `ok` 为 true。
- [x] 输入 spec、错误状态、缺失必需字段、绝对路径、仓库外路径或 `.scratch/` 外路径时 exit 1。
- [x] stdout 始终是 JSON，并包含 `ok`、`ticket`、`blockers`、`errors`。
- [x] 实现仅使用 Node.js 标准库且不修改 ticket 文件。
- [x] 测试通过 spawn CLI 的公开 seam 验证行为，不直接测试内部 helper。

## Comments

- 完成 Ticket 01：以公开 CLI seam 执行逐轮 RED→GREEN，覆盖顶部 metadata、必需 Parent、路径与 symlink 边界；`npm run check` 33/33 tests 通过，registry freshness 与 upstream drift 通过，fresh Standards/Spec review 均为 PASS。
