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
   - 若测试失败、返回 `BLOCKED` 或存在明显问题：可传 `resumeRunId` 续跑原 writer，也可省略 `resumeRunId` 启动新的 fresh writer，或由父会话直接做小范围修正。
   - 如本次改动涉及高风险领域（鉴权、数据完整性、不可逆迁移等）或用户显式要求，可调用一次 `matt-code-review`（`reviewScope: { kind: "worktree" }`）获取**建议型**双轴报告，与用户一起决定修哪些、忽略哪些。

## 验证与提交

1. 运行项目要求的完整测试套件与 typecheck/build（批次模式下按 `matt-implement-spec` 去重，避免每票重复慢速全量测试）。
2. 检查 `git status`、完整 staged manifest、完整 staged diff 与最终提交信息：只暂存本次实现与测试文件（禁止 `git add .` / `git add -A` 误带私有资料），禁止 `git add -f`（唯一例外是源码维护例外下、本次计划内且需分发的 `.x-matt/` 契约文件，须逐路径核对 force-add 集合恰好就是这些路径且完整 staged manifest 只含本次计划内文件）；确认业务项目中不包含 `.x-matt/`、个人 `.pi/`、会话 ID、AI attribution 或工具生成的 `Co-authored-by`，不伪造作者或移除团队签名。
3. 使用 `<type>: <中文现在时摘要>` 提交到当前 branch；不自动 push、不创建 PR、不自动归档。提交后若 hook 追加未授权工具归因，停止、不 push 并报告真实提交。
4. 提交成功后，若为 Local Markdown ticket，仅在本地将 `Status` 改为 `resolved`，并在 `## Comments` 追加 `Implementation commit: <完整 commit SHA>` 与验证摘要（不暂存、不提交 tracker；不修改 parent spec）。

完成后报告 commit SHA、改动文件、验证命令结果及残余风险。
