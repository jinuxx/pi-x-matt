---
name: matt-code-review
description: 沿 Standards 与 Spec 两个相互独立的轴评审固定范围内的代码变化。用于评审分支、PR、工作区变更、计划实现结果或指定文件。
metadata:
  pi-scope: parent
  pi-class: orchestration
  pi-upstream-path: skills/engineering/code-review/SKILL.md
  pi-upstream-sha: 6654f6b60cd9d5be8b54c6fafe44346dabeb3b76
---

# Code Review

父会话负责固定评审范围、识别标准与规格来源，并保持两个评审轴相互独立。

## 调度前

1. 明确评审对象：优先使用用户给出的 fixed point、diff、文件或计划。没有明确范围时必须先收敛范围。
2. 明确 `reviewKind`：有未提交或未跟踪变化时为 `worktree`；只评审已提交的 fixed-point 到 `HEAD` 时为 `committed`；非 Git 的计划或指定文件评审为 `files`。Git 评审先确认 ref/工作区状态可核验并取得具体 changed-file 路径列表；把 `reviewKind`、fixed point、逐文件证据方式和初始证据 allowlist 写入 task。不要只给目录或笼统的“相关代码”。
3. 为 `worktree` 明确：先 `worktree-files`；tracked 修改使用逐文件 `worktree-diff`，`??` untracked 文件直接读取，deleted 文件只读 diff，rename 同时核验 old/new 路径；禁止用 `ref...HEAD` 作为工作区唯一证据。为 `committed` 明确使用 `diff-files ref` 后逐文件 `diff ref path`。为 `files` 列出精确文件路径且不调用 Git diff。
4. 列出仓库标准文件的具体路径，例如 `AGENTS.md`、`CONTRIBUTING.md` 或项目约定文件。
5. 列出当前 ticket、其明确引用的 parent spec 和其他规格来源的具体路径，或明确写 `无可用 spec`。默认不把 sibling/future tickets、ADR、context 或 roadmap 交给 Spec reviewer；不要伪造需求。
6. 为 Standards reviewer 写明允许的一层依赖扩展规则，为 Spec reviewer 写明 module/package 搜索边界。初始证据不足且无法在该边界内核验时，reviewer 应返回 `NO_EVIDENCE`，父会话不得期待它扫描项目补齐材料。

## 调度

调用 `pi_matt_dispatch`：

- `workflow`: `matt-code-review`
- `task`: 包含目标、`reviewKind=worktree|committed|files`、具体 changed-file/目标文件路径、对应的逐文件证据方法、fixed point（若适用）、初始证据 allowlist、标准文件路径、当前 ticket/parent spec 路径、允许的一层依赖扩展、module/package 搜索边界、已知约束和停止条件

Dispatcher 会并行启动两个 fresh-context reviewer：

- `standards`：仓库标准、正确性、测试与代码异味
- `spec`：需求遗漏、范围膨胀和错误实现

## 汇总

1. 收到 completion result 后，只读取 `standards` 与 `spec` lane 的 `structuredOutput`；不要把普通 `output`、`outputReference` 或文件扩展名当作结构化结果。
2. 任一 lane 失败、缺失或 `structuredOutput` 不符合对应 workflow schema 时，整个评审工作流失败；不得用自然语言输出替代该轴。
3. 两个对象均有效时，保持结果分离呈现，不把一个轴的结论改写成另一个轴的优先级。父会话只过滤无证据或超出范围的 finding，并分别报告每轴 verdict、finding 数和最严重问题。
