---
name: matt-implement
description: 根据已确认的 ticket 或当前会话单 slice 计划实现一个工作切片，以确定性验证为核心，按需评审后提交当前分支。
disable-model-invocation: true
metadata:
  pi-scope: parent
  pi-class: interaction
  pi-dispatch: none
  pi-depends-on: matt-domain-modeling
  pi-upstream-path: skills/engineering/implement/SKILL.md
  pi-upstream-sha: abeeaf95660ba9e8b7c753eb38f441ca707a8823
---

# Implement

本 skill 将一个已确认的 ticket 或当前会话单 slice 计划实现并提交到当前分支。默认以**确定性测试验证**作为交付核心，**不自动发起每票 code review**；高风险改动或用户要求时再按需调用建议型 `matt-code-review`。

先应用[业务项目隐私契约](../matt-setup/privacy.md)：业务项目整个 `.x-matt/` 与个人 `.pi/` 仅保存在本机，不暂存、不提交、不写入 AI attribution 或工具元信息。

## 开始前

1. 核对当前 branch 与 `git status`，不改写或归因用户的既有无关改动。
2. 明确目标范围：
   - 传入 ticket reference 时，按 `.x-matt/agents/issue-tracker.md` 读取完整 ticket 与相关 parent spec 条款，陈述标题；歧义时先询问。
   - Local Markdown 只接受 active `Type: ticket` 且 `Status: ready-for-agent` 的入口；路径或 blocker 位于 `.x-matt/work/shipped/` 时拒绝。逐个核对 `Blocked by` 已为 `resolved` 且 Comments 中的 `Implementation commit` 属于当前 `HEAD` ancestry。
   - 无 ticket 时，接受当前会话已确认的单 slice 计划（多流程/跨会话大改动建议先走 `matt-to-spec` → `matt-to-tickets`）。
3. 确定**测试切入点**（从哪个公开入口测、覆盖哪些验收/业务规则/状态转换、哪些纯机械映射可省略）与聚焦验证命令，读取相关源码与一层调用者。
4. 遵循 [matt-domain-modeling](../matt-domain-modeling/SKILL.md)：实现中如发现值得沉淀的新术语或 ADR 级决定，由父会话在确认后写入本地 `.x-matt/context/` 或 `.x-matt/adr/`。

## 执行实现

1. 按 [matt-tdd](../matt-tdd/SKILL.md) 通过 `pi_matt_dispatch` 派发 `workflow: "matt-tdd"`，传入简洁的 [Context Pack](../matt-tdd/context-packs.md) 与聚焦 `verifyCommands`（如相关单测、typecheck）。
2. 等待完成并按 [Workflow Result Reading](../matt-tdd/results.md) 读取 `structuredOutput` 与 `hostVerification`。
3. 核对实际 `git diff --stat` 与关键改动：
   - **父会话直修 vs 派 `matt-worker` 边界**：
     - **同时满足 4 条时由父会话直接修改并自跑聚焦测试**（不开 `matt-worker`）：① 非新票首轮（属于超时收尾或评审定向小修）；② 范围明确且合计 **≤ 3 个文件**（生产+测试），不新增表/SQL、新实体/Mapper 或新接口契约；③ 方案确定（如删无用导入、补校验/注解/锁、修单个断言或映射、补 1~3 个回归用例）；④ 相关代码上下文已在当前会话手头。**逃生阀**：父会话直修最多试跑 **1~2 次聚焦测试**，未过或牵涉扩大时立刻停手转交 `matt-worker`。
     - **其余情况**（新票首次实现、涉及 > 3 个文件、新增表/接口/跨层重构、或多项 P0/P1 合并修复）交给 `matt-tdd`（可传 `resumeRunId` 续跑原 writer 或开 fresh writer）。
   - **按需评审与防套娃**：仅在改动涉及鉴权、资金、不可逆迁移等高风险领域或用户显式要求时，调用**最多 1 次** `matt-code-review`（`reviewScope: { kind: "worktree" }`）；禁止单票“修完再复审”。确认需要修的 P0/P1 **合并为 1 轮修完**（不拆成多轮串行派发），P2 与偏门理论边界直接记入残余风险，不擅自返工。
   - 若 `pi_matt_dispatch` 返回无人值守轮次软刹车提示，**不改票据状态**，直接用大白话汇总当前成果与剩余项（触发条件、最坏后果、预估改动量），请用户决定直接提交还是继续修。

## 验证与提交

1. 运行项目要求的完整测试套件与 typecheck/build（批次模式下按 `matt-implement-spec` 去重，避免每票重复慢速全量测试）。
2. 检查 `git status`、完整 staged manifest、完整 staged diff 与最终提交信息：只暂存本次实现与测试文件（禁止 `git add .` / `git add -A` 误带私有资料），禁止 `git add -f`（唯一例外是源码维护例外下、本次计划内且需分发的 `.x-matt/` 契约文件，须逐路径核对 force-add 集合恰好就是这些路径且完整 staged manifest 只含本次计划内文件）；确认业务项目中不包含 `.x-matt/`、个人 `.pi/`、会话 ID、AI attribution 或工具生成的 `Co-authored-by`，不伪造作者或移除团队签名。
3. 使用 `<type>: <中文现在时摘要>` 提交到当前 branch；不自动 push、不创建 PR、不自动归档。提交后若 hook 追加未授权工具归因，停止、不 push 并报告真实提交。
4. 提交成功后，若为 Local Markdown ticket，仅在本地将 `Status` 改为 `resolved`，并在 `## Comments` 追加 `Implementation commit: <完整 commit SHA>` 与验证摘要（不暂存、不提交 tracker；不修改 parent spec）。

完成后报告 commit SHA、改动文件、验证命令结果及残余风险。若当前处于 `matt-implement-spec` 批次且本票完成后已无剩余未解决票，不要直接收工，必须先按 `matt-implement-spec` 执行整批全量回归与集成评审。
