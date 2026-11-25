# Workflow Result Reading

所有通过 `pi_matt_dispatch` 调度的执行型 workflow 共用本读取规则。派发后等待原生异步完成通知，不轮询。

## 等待最终完成通知（勿在增量通知时提前介入）

- 只以 `Background task completed: **workflow**` 最终通知作为结算起点。
- 若中途收到 `Workflow child failed: **implement**` 或 `Workflow child completed: ...` 且包含 `Status: workflow still running`（例如 `implement` 超时后工作流正在自动运行 `implement-settlement` 或 `verify`），**不要提前检查代码、调用工具、新建超时待办或向用户下结论**；静等最终 `workflow` 完成通知到达后再读取收尾结果。

## 读取完整结果

1. **优先读取子任务输出文件**：直接读取最终通知中各子任务指向的 `*_output.md`（体积小，含完整结构化 JSON）。
2. **不要整文件 `read` `status.json`**：大项目下的 `status.json` 常超过 10k tokens，直接全文读取会被截断而导致误判“缺少结构化报告”。需要核对 `hostVerification`、终态 `state` 或失败 `emits` 时，用简短脚本（如 `node -e` / `jq`）只抽取所需摘要字段：
   - `state === "complete"`：抽取 `workflow.value` 中各 lane 的 `key`、`ok`、`structuredOutput`（以及 `matt-tdd` 可选的 `hostVerification`）。
   - `state === "failed"`（例如执行异常、超时或某轴遇到 429/网络失败）：抽取 `workflow.emits` 中最后一个 `type === "pi-x-matt.stage-results"` 的 `results` 摘要，保留已成功 lane 的结果并定位失败原因。

## 结果语义

- **`matt-tdd`**：返回 `COMPLETE` 或 `BLOCKED` 均正常结算。核对 `hostVerification`（若声明了 `verifyCommands`）与真实 `git diff`；失败时可直接用 `resumeRunId` 续跑、开 fresh writer 或在父会话修复。
- **`matt-code-review`**：两轴均为**建议型（Advisory）**，`PASS`、`ISSUES`、`NO_EVIDENCE` 均正常返回结果而不抛错阻断。若某轴因网络/配额失败，可直接传 `lanes: ["standards"]`（或 `["spec"]`）单独重跑该轴。
- 若遇到异常卡住的运行记录，用户可运行 `/matt-reset` 立即清理活跃状态。
