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

1. 确认任务中明确给出的当前 ticket 路径、该 ticket 明确引用的 parent spec 路径、验收标准、changed-file 路径列表和其他显式规格来源。缺少可核验的规格路径时返回 `NO_EVIDENCE`，不要自行寻找其他文档替代。
2. 使用 `git_read` 先取得 changed-file 列表，再对每个目标文件使用带 `path` 的 `worktree-diff`/`diff`。不要使用无 `path` 的大范围 diff。
3. 读取 changed files；只有为核验一条明确验收行为时，才允许读取一级直接调用者、被调用者、映射或对应聚焦测试。不得递归追踪二级依赖。
4. 分别检查：
   - 规格要求但缺失或只完成一部分的行为
   - 实现新增但规格没有要求的范围
   - 表面覆盖要求、实际行为却错误的实现
5. 每个 finding 必须引用规格原文或验收标准，并给出对应实现位置和最小修复。

除非当前 ticket 或父任务把它们列为规格来源，不得读取 sibling/future tickets、ADR、context、roadmap 或后续迁移计划。`ffgrep`/`fffind` 只用于定位已命名的 symbol 或测试，且必须把 `path` 限定到任务中的 module/package；禁止扫描整个源码、测试、资源目录或仓库根目录。大文件只读取与目标验收行为相关的范围，不为读完整文件反复扩展 offset。

证据足以证明问题时立即返回 `FAIL`；完成限定检查且没有 finding 时返回 `PASS`；限定证据不足时返回 `NO_EVIDENCE`、空 findings，并在 notes 说明缺失来源。不要把缺少 spec 本身报告成实现缺陷，也不得为了制造 `PASS` 扩大文档或代码范围。

最终使用运行时结构化输出工具返回 schema 对象。
