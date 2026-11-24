---
name: matt-tdd
description: 单写者 TDD 执行工作流，逐片 RED→GREEN 实现目标并运行可选的宿主确定性验证命令。
disable-model-invocation: true
metadata:
  pi-scope: parent
  pi-class: orchestration
  pi-upstream-path: skills/engineering/tdd/SKILL.md
  pi-upstream-sha: abeeaf95660ba9e8b7c753eb38f441ca707a8823
---

# Test-Driven Development

这是由 `matt-implement` 调用的纯实现 workflow（单 `matt-worker` lane，不自动发起 code review）。

## 调度前准备

- 明确目标与验收行为，确定公开**测试切入点**（从哪个入口测、能验证什么、验证不到什么）。
- 按 [Context Pack](context-packs.md) 在 `task` 中提供简洁上下文：验收要求、相关文件指针、聚焦测试命令与隐私边界。
- 准备可在项目根执行的聚焦验证命令列表（如单测、typecheck）传入 `verifyCommands`。
- 若规格来源位于 `.x-matt/work/shipped/`，拒绝实现。

## 调度与迭代

通过 `pi_matt_dispatch` 调用 `workflow: "matt-tdd"`：

```json
{
  "workflow": "matt-tdd",
  "task": "目标、验收、测试切入点、相关文件与隐私边界",
  "verifyCommands": ["npm test -- parser.test.ts"]
}
```

- 在受信任项目内直接派发，不重复弹出写者确认框。
- `matt-worker` 完成 RED→GREEN 后返回 `COMPLETE` 或 `BLOCKED`；宿主随后运行 `verifyCommands` 并把真实结果附在 `hostVerification`。
- 若测试未通过、返回 `BLOCKED` 或需要后续修复：可传 `resumeRunId` 续跑原 writer，也可省略 `resumeRunId` 直接启动新的 fresh writer，或由父会话直接修复，绝不卡死。
- 按 [Workflow Result Reading](results.md) 核验结果与实际 `git diff`；需要独立评审时再显式调用 `matt-code-review`。
