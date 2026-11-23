---
name: matt-tdd
description: 内部 TDD 工作流，以唯一 worker 逐片 RED→GREEN，先跑宿主检查，高风险再独立评审。
disable-model-invocation: true
metadata:
  pi-scope: parent
  pi-class: orchestration
  pi-upstream-path: skills/engineering/tdd/SKILL.md
  pi-upstream-sha: abeeaf95660ba9e8b7c753eb38f441ca707a8823
---

# Test-Driven Development

这是 `matt-implement` 使用的内部执行 parent。缺少已核验的单票/单 slice、明确验收、固定基线或精确范围时停止，提示用户运行 `/skill:matt-implement`；不得使用 `write`/`edit` 创建 spec 或 ticket 解阻。规格来源位于 `.x-matt/work/shipped/` 就立即 fail closed，不读取、不调度。

## 准备

- 复用已核验的 ticket、验收与项目规则，按 [Context Pack](context-packs.md) 提供基线、精确文件、变更点和停止条件；不重复发现上下文。
- “测试切入点”是可从公开入口观察的行为。说明从哪个入口测、能验证什么、验证不到什么。测试价值 gate：覆盖明确验收、可达回归、独立状态变化以及权限/数据不变量；共享等价类只取代表例，不做全排列。简记省略测试的候选项及理由，不为增加数量测内部实现。
- 选可在基线上通过、短时、确定、无工作区写入的聚焦测试或 typecheck 作为 `preReviewCommands`，不能用无关命令代替验收。纯环境失败不算 RED。完整测试套件与全量构建由父会话执行，worker 不得运行。

## 调度与结算

用 `pi_matt_dispatch` 调用 `matt-tdd`。宿主把真实用户确认绑定到 ticket 内容 hash、分支、HEAD 和范围，只从宿主可信记录恢复 reload；无有效授权且无 UI 时拒绝调度。`task` 只放公共事实，`laneTasks` 只提供实际运行的角色任务。详见 [宿主契约](dispatch-contract.md)。

1. `implement` 是唯一写者。对每个行为先取得真实 RED，再最小实现至 GREEN，返回结构化 `COMPLETE`、测试切入点、cycles、文件和命令。不要顺手扩大重构。worker 报告不是宿主实测。
2. 宿主运行获批确定性检查；若 writer 能修正，只给同一个 writer 一次纠正并重测。TDD 固定 `reviewKind=worktree`，独立采集完整 Git Review Evidence Pack（combined diff、新文件全文/hash、deleted/rename old/new）；核对检查针对该工作树和 index。检查或证据失败就停止。
3. **`verified`**（普通票）必须有获批 `preReviewCommands`，只提供 `laneTasks.implement`。宿主检查通过后不启动独立 reviewer；待修复标记、失败或过期证据不能交付。
4. **`reviewed`**（高风险或关键验收缺乏充分自动证据）提供 `implement`、`standards`、`spec`。检查通过后两条只读轴并行复核一次，限定到该票验收和关键风险；`NO_EVIDENCE` 不是 PASS。旧信封未声明 `delivery` 时仍用原三项 lane 和原门禁。

评审有阻断时按共同根因一次合并 `repair`，只续跑原 writer，核对全部 finding 和聚焦回归后，使用最新 `dispatchId` 显式 `review`，只核对原问题、修复直接影响的行为和有证据的新安全/完整性风险。`reviewed` 每票初审后最多修复一次（含最终验证续修）；仍失败就保留候选、等待用户决定。低价值建议放 `notes`，不派发 writer。真实 FAIL 不能用 prose、重做或改交付策略消掉。

特殊状态才查 [宿主契约](dispatch-contract.md)：`recovery`（失败轴或报告纠错）、`reconsider`（具体异议）、`recollect`（只重采合格的越界候选）、`blockedRecovery` / `writerRecovery`（符合条件的原 writer）、`timeoutRecovery`（单票或批次首次实现自动续跑仍超时后，用户确认第二次续跑）、`finalValidationRepair`（批次实测回归）、`acceptRisk`（用户对普通 Standards P2 的精确候选确认，不称 PASS）。不重复 initial、不切换写者、不跑无关评审。

按 [Workflow Result Reading](results.md) 检查终态与 `structuredOutput`，并核对候选 Pack 和实时工作区。初次 `verified` 的合格结果只包含 implement 和宿主检查，不应补造缺失的轴；`reviewed` 还需两轴的有效结论。`repair` 的 `COMPLETE`、`reviewPending`、`reconsider` 的执行完成都不是交付通过。提交、tracker 和最终验证由父会话负责，TDD 不提交、不 push、不归档。
