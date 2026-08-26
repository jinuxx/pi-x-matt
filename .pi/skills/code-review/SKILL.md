---
name: code-review
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
2. 若评审 Git 变化，父会话先确认 ref 可解析且 diff 非空；把 fixed point、diff 命令和 commit 范围写入 task。
3. 列出仓库标准来源，例如 `AGENTS.md`、`CONTRIBUTING.md` 或项目约定文件。
4. 列出规格来源或明确写 `无可用 spec`。不要伪造需求。

## 调度

调用 `pi_matt_dispatch`：

- `workflow`: `code-review`
- `task`: 包含目标、评审边界、fixed point/diff、标准来源、spec 来源、已知约束和停止条件

Dispatcher 会并行启动两个 fresh-context reviewer：

- `standards`：仓库标准、正确性、测试与代码异味
- `spec`：需求遗漏、范围膨胀和错误实现

## 汇总

1. 收到 completion result 后，只读取 `standards` 与 `spec` lane 的 `structuredOutput`；不要把普通 `output`、`outputReference` 或文件扩展名当作结构化结果。
2. 任一 lane 失败、缺失或 `structuredOutput` 不符合对应 workflow schema 时，整个评审工作流失败；不得用自然语言输出替代该轴。
3. 两个对象均有效时，保持结果分离呈现，不把一个轴的结论改写成另一个轴的优先级。父会话只过滤无证据或超出范围的 finding，并分别报告每轴 verdict、finding 数和最严重问题。
