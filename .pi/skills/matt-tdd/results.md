# Workflow Result Reading

所有通过 `pi_matt_dispatch` 调度的执行型 workflow 共用本读取规则。派发后等待原生异步完成通知，不轮询。

## 等待最终完成通知（勿在增量通知时提前介入）

- 只以 `Background task completed: **workflow**` 最终通知作为结算起点。
- 若中途收到 `Workflow child failed: ...` 或 `Workflow child completed: ...` 且包含 `Status: workflow still running`（例如 `implement` 超时后工作流正在自动运行 `implement-settlement` 或 `verify`），**即使通知末尾附带 `Parent action`，也只回复一句简短提示（如“等待工作流收尾”）并立即结束本回合**，不调用工具、不读文件、不新建超时待办、不下结论；等最终 `Background task completed: **workflow**` 通知到达后再读取结果。

## 读取完整结果

- **禁止把 `*_output.md`（普通原始输出文本）当作已校验的 `structuredOutput`**（它不经过 schema 校验，也不包含 `hostVerification`）。
- **禁止整文件 `read` `status.json`**（大项目下常超过 10k tokens 被截断，容易误判“缺少结构化报告”）。
- 统一用简短命令只从 `status.json` 抽取权威摘要字段（`state`、`workflow.value` 或失败时最后一条 `pi-x-matt.stage-results`）：

```bash
node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const r=s.workflow?.value??s.workflow?.emits?.findLast(e=>e.type==="pi-x-matt.stage-results")?.results??[];console.log(JSON.stringify({state:s.state,lanes:r.map(({key,ok,structuredOutput,hostVerification,error})=>({key,ok,structuredOutput,hostVerification,error}))},null,2))' "<status.json路径>"
```

1. `state === "complete"`：消费各 lane 的 `structuredOutput`（以及 `matt-tdd` 可选的 `hostVerification`）。
2. `state === "failed"`（例如执行异常、超时或某轴遇到 429/网络失败）：消费上述 `lanes` 摘要，保留已成功 lane 的结果并定位失败原因。

## 结果语义

- **`matt-tdd`**：返回 `COMPLETE` 或 `BLOCKED` 均正常结算。核对 `hostVerification`（若声明了 `verifyCommands`）与真实 `git diff`；失败时可直接用 `resumeRunId` 续跑、开 fresh writer 或在父会话修复。
- **`matt-code-review`**：两轴均为**建议型（Advisory）**，`PASS`、`ISSUES`、`NO_EVIDENCE` 均正常返回结果而不抛错阻断。若某轴因网络/配额失败，可直接传 `lanes: ["standards"]`（或 `["spec"]`）单独重跑该轴。
- 若遇到异常卡住的运行记录，用户可运行 `/matt-reset` 立即清理活跃状态。
