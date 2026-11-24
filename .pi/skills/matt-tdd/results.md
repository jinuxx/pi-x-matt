# Workflow Result Reading

所有通过 `pi_matt_dispatch` 调度的执行型 workflow 共用本读取规则。派发后等待原生异步完成通知，不轮询。

## 读取完整结果

通知中的 preview 可能截断；按通知指向的 `status.json` 读取完整 JSON：

1. `state === "complete"`：直接从 `workflow.value` 按 lane `key` 读取每条 lane 的 `structuredOutput`（以及 `matt-tdd` 可选的 `hostVerification`）。
2. `state === "failed"`（例如执行异常、超时或某轴遇到 429/网络失败）：从 `workflow.emits` 取最后一个 `type === "pi-x-matt.stage-results"` 的 `results` 数组，保留已成功 lane 的结果并定位失败原因。

## 结果语义

- **`matt-tdd`**：返回 `COMPLETE` 或 `BLOCKED` 均正常结算。核对 `hostVerification`（若声明了 `verifyCommands`）与真实 `git diff`；失败时可直接用 `resumeRunId` 续跑、开 fresh writer 或在父会话修复。
- **`matt-code-review`**：两轴均为**建议型（Advisory）**，`PASS`、`ISSUES`、`NO_EVIDENCE` 均正常返回结果而不抛错阻断。若某轴因网络/配额失败，可直接传 `lanes: ["standards"]`（或 `["spec"]`）单独重跑该轴。
- 若遇到异常卡住的运行记录，用户可运行 `/matt-reset` 立即清理活跃状态。
