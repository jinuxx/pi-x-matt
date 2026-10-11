# Workflow Result Reading

所有执行型 parent 共用此契约。调度后交还控制权或处理独立工作，等待 runtime 的 completion；不得轮询等待。

1. completion 与 targeted status 的 Preview 是有界预览，可能带截断标记（如 `[preview truncated]`、`…`），不是完整 JSON；不得据此汇总。
2. 按通知给出的 retention-managed async dir 读取 `status.json`，从完整 `workflow.value` 按 lane key 取该项的 `structuredOutput`。这是本项目所有 dispatcher workflow 的完整结果来源。
3. 不得从 `output`、`outputReference`、`outputArtifactPath`、文件扩展名、自然语言或 workflow receipt 重建结构化结果。
4. 来源缺失、不可读或 JSON 无效时 fail closed，报告准确的 workflow run ID、lane key 与路径；不得自动重派发、改变执行模式或回退到预览。
