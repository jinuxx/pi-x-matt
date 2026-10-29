# Workflow Result Reading

所有执行型 parent 共用此契约。调度后交还控制权或处理独立工作，等待 runtime 的 completion；不得轮询等待。

1. completion 与 targeted status 的 Preview 是有界预览，可能带截断标记（如 `[preview truncated]`、`…`），不是完整 JSON；不得据此汇总。
2. 按通知给出的 retention-managed async dir 读取完整 `status.json`，先核对 workflow run ID 与终态：
   - `state === "complete"`：保持成功契约，从 `workflow.value` 的结果数组按 lane key 取 `structuredOutput`；缺少 `workflow.value` 仍须停止，不回退到阶段快照。
   - `state === "failed"`：脚本抛错时没有 `workflow.value` 是正常语义。从 `workflow.emits` 中选择**最后一个** `type === "pi-x-matt.stage-results"` 的对象，核对 `version === 1`、`workflow` 与本次调度名称一致、`stage` 属于本次 workflow，再从其 `results` 数组按 lane key 读取。不拼接多条 emit，不选取更早的通过快照，不把无此标识的 emit（例如 `reviewEvidencePath`）当作结果。
   - `running`、`paused`、`stopped` 等均不是成功；不得据阶段快照越过终态 gate。
3. Dispatcher 在每阶段 `runs.all()` 及既有 settlement 结束后、任何结果校验或 gate 抛错前，通过 runtime 的 `emit(...)` 发布以下累积快照。runtime 将其完整保存在 `status.json → workflow.emits`，不依赖通知预览；成功仍正常 `return results`，失败仍抛错。

   ```json
   {
     "type": "pi-x-matt.stage-results",
     "version": 1,
     "workflow": "matt-tdd",
     "stage": 2,
     "results": ["完整 implement、standards、spec lane result 对象（含 structuredOutput、ok、error 等原字段）"]
   }
   ```

4. 快照只证明已结算阶段的结果可读取，不代表通过。先核对阶段对应的预期 lane 数量、唯一 key、每个 `ok === true` 及各自 `outputSchema`；**检查所有 lane**，不得在第一个 gate 错误处停止读取或遗漏另一个 reviewer 的 findings：
   - reviewer 执行成功且 schema 合法，但 `verdict === "FAIL"` 或 `"NO_EVIDENCE"`：属于**复核结论不通过**；分别完整报告 Standards 与 Spec 的 verdict/findings/notes，workflow 仍失败，禁止提交，不自动重跑实现。
   - lane 执行失败、结果缺失、schema 无效，或 workflow 在发布该阶段前因 host/runtime 错误退出：属于**执行或结果契约失败**，不能当成 reviewer 的有效复核结论。保留并报告其他有效 lane 的全部结果，同时报告失败 lane 与准确错误；不得用残留 PASS/FAIL 掩盖执行失败。
   - `implement` 返回合法 `BLOCKED`：属于**实现受阻**；stage 1 快照不应含 reviewer，未启动的后续阶段不是复核不通过。实现执行失败、结果缺失或无效时同样禁止启动后续证据采集与复核。
5. 不得从 `output`、`outputReference`、`outputArtifactPath`、文件扩展名、自然语言或 workflow receipt 重建结构化结果，也不从 `workflow-children.jsonl`、旧 transcript 或通知拼装结果。上述 `status.json` 字段是本项目所有 dispatcher workflow 的完整结果来源。
6. 来源缺失、不可读或 JSON 无效，失败快照缺失/标识不符，或阶段结果不完整时 fail closed，报告准确的 workflow run ID、lane key 与路径；不得自动重派发、改变执行模式或回退到预览。已有的阶段结果可作诊断，但不授权继续执行或提交。

`matt-tdd` 的 **repair-only** 是明确的阶段边界：工具 receipt 的 `reviewPending=true`，成功结果只含 implement，且 emits 含 `pi-x-matt.review-pending`。这是“修复完成、尚未评审”，不是完整 TDD 成功，也不是 reviewer 丢失；禁止提交或复用修复前 PASS。核对本次 writer 证据与实际改动后，父会话选择继续同范围 repair 或显式 `review`。review 结果复用最近 implement，并包含本次 fresh Standards/Spec；只有当前候选的两轴 PASS 才能进入最终验证。缺少 pending 标记或预期结果时仍 fail closed，不凭单 lane `COMPLETE` 猜测模式。

超时 settlement 前后均保留 gate 前快照。恢复后的 lane 使用 `recoveryHistory` 保留原始失败；settlement 再失败时同时报告原 timeout 与恢复错误，不只报告最后的 fetch failed。`pi-x-matt.recovery` emit 记录恢复边界，不是成功结果来源。只有授权/快照仍有效且符合 [局部恢复契约](dispatch-contract.md) 时，显式恢复失败 reviewer；不重新启动 implement，也不以有效 FAIL 为执行故障重跑。
