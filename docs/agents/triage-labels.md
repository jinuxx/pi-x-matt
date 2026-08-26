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
- `resolved`：单个 implementation ticket 已通过 TDD、验证和双轴 review，并与实现一起提交；其他 ticket 可以据此解除 `Blocked by`。
