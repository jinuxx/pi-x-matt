# Triage Labels

以下表格把 skills 使用的 canonical role 映射到 Local Markdown 的 `Status:` 值。

| Canonical role | Local status | Meaning |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | 等待维护者评估 |
| `needs-info` | `needs-info` | 等待补充信息 |
| `ready-for-agent` | `ready-for-agent` | 单个 ticket 规格完整，可以进入 agent 实现 |
| `ready-for-human` | `ready-for-human` | 需要人工实现或决定 |
| `wontfix` | `wontfix` | 不会继续处理 |

当 skill 要求 label 或 triage role 时，在 Local Markdown 文件顶部写对应的 `Status:` 值。当前配置只定义映射，不代表 `triage` skill 已移植。

## Local lifecycle statuses

以下状态不是 triage roles：

- `spec-ready`：parent spec 已确认，只能进入 `to-tickets`，不能直接进入 `implement`。
- `shipped`：parent spec 的显式归档终态；只能由用户单独触发 `matt-archive`，不能作为 ticket、frontier、implementation 或 code-review Spec 轴入口。parent spec 只允许 `spec-ready` / `shipped` 两个状态。
- `resolved`：单个 implementation ticket 已通过 TDD、验证和双轴 review，并与实现一起提交；其他 ticket 可以据此解除 `Blocked by`。
- `out-of-scope`：implementation ticket 被明确排除，不表示已实现；只作为 parent spec 归档资格的 terminal 状态。
- Wayfinder map 使用 `active` / `cleared`；decision ticket 使用 `open` / `claimed` / `resolved` / `out-of-scope`。这些状态只属于 decision map，不授权 `implement`；只有 `Type: ticket` 且 `Status: ready-for-agent` 才是实现入口。
