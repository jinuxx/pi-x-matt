---
name: matt-code-review
description: 沿 Standards 与 Spec 两个独立轴对代码变更做建议型只读评审，并行运行并分别呈现结果。
metadata:
  pi-scope: parent
  pi-class: orchestration
  pi-upstream-path: skills/engineering/code-review/SKILL.md
  pi-upstream-sha: abeeaf95660ba9e8b7c753eb38f441ca707a8823
---

# Code Review

父会话负责确定评审范围、提供工程规范与规格来源，并行调度 Standards 与 Spec 两条独立只读轴。评审输出为**建议型（Advisory）**，不会因 `ISSUES` 或 `P2` 阻断流程，由用户与父会话共同决定采纳哪些建议。

先应用[业务项目隐私契约](../matt-setup/privacy.md)，将本次隐私防外泄边界告知 Standards 轴。

## 调度前准备

1. **确定评审范围**：
   - **未提交工作区改动**：传 `reviewScope: { kind: "worktree" }`，由宿主统一采集一份共享 Evidence Pack。
   - **已提交历史范围**：传 `reviewScope: { kind: "committed", fixedPoint: "<ref>" }`，由宿主固定 `F..HEAD` 从 Git 对象库采集共享 Evidence Pack。
   - **指定文件（非 Git）**：省略 `reviewScope`，在 `task` 中明确列出目标文件路径。
2. **准备 Standards 轴材料**：搜索仓库中规范文档（如有 `CODING_STANDARDS.md`、`CONTRIBUTING.md`、`AGENTS.md` 必须列入），把适用条款与隐私/安全关注点放入 `laneTasks.standards`。
3. **准备 Spec 轴材料**：按 `.x-matt/agents/issue-tracker.md` 读取对应 active ticket 或 parent spec 验收条款（默认跳过 `.x-matt/work/shipped/`），放入 `laneTasks.spec`；若本次改动无对应规格，注明“无可用 spec”。

## 调度

调用 `pi_matt_dispatch`：

```json
{
  "workflow": "matt-code-review",
  "task": "评审目标与背景说明",
  "reviewScope": { "kind": "worktree" },
  "laneTasks": {
    "standards": "适用工程规范、隐私与安全关注点",
    "spec": "ticket/spec 验收条款（或明确无可用 spec）"
  }
}
```

若其中一轴因网络或配额失败，保留另一轴结果，直接传 `lanes: ["standards"]`（或 `["spec"]`）重跑失败轴即可。

## 汇总呈现

按 [Workflow Result Reading](../matt-tdd/results.md) 读取两轴完整 `structuredOutput`，分别在 `## Standards` 与 `## Spec` 下呈现：

- 保持两轴独立，不合并改写彼此结论；
- 区分高优先级问题（P0/P1）与一般建议（P2/notes），每条用大白话呈现触发条件（`trigger`）与最坏后果（`impact`）；
- 给出处理建议，交由用户拍板决定修复哪些项、忽略哪些项。
