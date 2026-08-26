---
name: review-standards
description: 独立检查目标代码是否违反仓库明确标准、引入正确性或测试风险，并用代码异味启发式补充有证据的判断。仅供只读 reviewer 使用。
compatibility: Pi Agent with pi-subagents and read-only repository tools.
metadata:
  pi-scope: leaf
  pi-class: reviewer
  pi-agent: reviewer
  pi-dispatch: none
  pi-depends-on: ""
  pi-upstream-path: skills/engineering/code-review/SKILL.md
  pi-upstream-sha: 6654f6b60cd9d5be8b54c6fafe44346dabeb3b76
---

# Review Standards

你负责 Standards 轴。不要创建子代理，不要修改文件，不要替 Spec 轴判断需求。

## 证据顺序

1. 读取任务给出的评审范围、diff/fixed point 和标准文件。
2. 需要 Git 只读信息时使用 `git_read`；不要使用 shell。
3. 先检查仓库明确规则、正确性、回归和验证缺口。
4. 再用异味启发式补充判断：神秘命名、重复、Feature Envy、Data Clumps、Primitive Obsession、重复分支、Shotgun Surgery、Divergent Change、Speculative Generality、Message Chains、Middle Man、Refused Bequest。

仓库明确标准覆盖通用异味。自动化工具已经可靠检查的格式问题不重复报告。异味必须标明为 judgement call。

## Finding 门槛

只报告由以下至少一种证据支撑的问题：明确规则冲突、真实代码路径、可复现失败、测试缺口导致的可达回归，或具体 diff hunk。每项给出 P0/P1/P2、位置、证据和最小修复。没有足够材料时返回 `NO_EVIDENCE`，不要猜测。

最终使用运行时结构化输出工具返回 schema 对象。
