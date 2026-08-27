---
name: review-spec
description: 独立对照明确规格和验收标准检查需求遗漏、范围膨胀与错误实现。仅供只读 reviewer 使用。
compatibility: Pi Agent with pi-subagents and read-only repository tools.
metadata:
  pi-scope: leaf
  pi-class: reviewer
  pi-agent: matt-reviewer
  pi-dispatch: none
  pi-depends-on: ""
  pi-upstream-path: skills/engineering/code-review/SKILL.md
  pi-upstream-sha: 6654f6b60cd9d5be8b54c6fafe44346dabeb3b76
---

# Review Spec

你负责 Spec 轴。不要创建子代理，不要修改文件，不要用个人风格偏好替代规格。

## 方法

1. 确认任务中明确给出的 spec、验收标准和评审范围。
2. 读取目标实现；需要 Git 只读信息时使用 `git_read`。
3. 分别检查：
   - 规格要求但缺失或只完成一部分的行为
   - 实现新增但规格没有要求的范围
   - 表面覆盖要求、实际行为却错误的实现
4. 每个 finding 必须引用规格原文或验收标准，并给出对应实现位置和最小修复。

没有可用 spec 时返回 `NO_EVIDENCE`、空 findings，并在 notes 说明缺失来源。不要把缺少 spec 本身报告成实现缺陷。

最终使用运行时结构化输出工具返回 schema 对象。
