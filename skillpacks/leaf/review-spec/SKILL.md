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

1. 首先使用 `read` 读取任务明确给出的当前 ticket。缺少路径、文件不可读或 ticket 没有可核验验收标准时返回 `NO_EVIDENCE`，不要自行寻找其他文档替代。
2. 接着读取该 ticket 明确引用的 parent spec，以及任务列出的其他显式规格来源，并提取只属于当前 ticket 的验收行为。若声明了 parent spec 但无法读取，返回 `NO_EVIDENCE`。
3. 全部声明的规格读取完成前，禁止调用 `git_read`、`ffgrep`、`fffind` 或读取实现文件。完成规格读取并明确记录验收行为后，才根据任务声明的 `reviewKind` 获取目标材料。Git 评审缺少 `reviewKind=worktree|committed` 或逐文件 diff 方式时返回 `NO_EVIDENCE`；非 Git 指定文件评审使用 `reviewKind=files`。
4. 按 `reviewKind` 读取实现证据：
   - `worktree`：先用 `git_read worktree-files` 取得状态。tracked 修改逐文件使用 `worktree-diff path=<file>`；`??` untracked 文件直接 `read`；deleted 文件只读 diff；`R old -> new` 对 old 与 new 两个路径分别读取 worktree diff，并作为同一次 rename 判断。禁止用 `diff ref...HEAD` 作为工作区唯一证据。
   - `committed`：先用 `diff-files ref=<fixed-point>` 取得文件列表，再逐文件使用 `diff ref=<fixed-point> path=<file>`；rename 同时核验 old 与 new 路径。
   - `files`：只读取任务列出的具体实现文件，不调用 Git diff。
5. 只有为核验一条已提取的验收行为时，才允许读取一级直接调用者、被调用者、映射或对应聚焦测试。不得递归追踪二级依赖。
6. 分别检查：
   - 规格要求但缺失或只完成一部分的行为
   - 实现新增但规格没有要求的范围
   - 表面覆盖要求、实际行为却错误的实现
7. 每个 finding 必须引用规格原文或验收标准，并给出对应实现位置和最小修复。

除非当前 ticket 或父任务把它们列为规格来源，不得读取 sibling/future tickets、ADR、context、roadmap 或后续迁移计划。`ffgrep`/`fffind` 只用于定位已命名的 symbol 或测试，且必须把 `path` 限定到任务中的 module/package；禁止扫描整个源码、测试、资源目录或仓库根目录。大文件只读取与目标验收行为相关的范围，不为读完整文件反复扩展 offset。

证据足以证明问题时立即返回 `FAIL`；完成限定检查且没有 finding 时返回 `PASS`；限定证据不足时返回 `NO_EVIDENCE`、空 findings，并在 notes 说明缺失来源。不要把缺少 spec 本身报告成实现缺陷，也不得为了制造 `PASS` 扩大文档或代码范围。

最终使用运行时结构化输出工具返回 schema 对象。
