---
name: tdd
description: 在用户确认测试 seam 后，以唯一 worker 执行逐片 red→green，并由 fresh Standards/Spec reviewer 复核结果。用于测试驱动实现功能或修复缺陷。
metadata:
  pi-scope: parent
  pi-class: orchestration
  pi-upstream-path: skills/engineering/tdd/SKILL.md
  pi-upstream-sha: 6654f6b60cd9d5be8b54c6fafe44346dabeb3b76
---

# Test-Driven Development

父会话拥有需求收敛、seam 确认、调度和最终判断。`worker` 是唯一写者；后续 reviewer 只读。

## 调度前

1. 读取相关代码、`CONTEXT.md`、ADR、项目说明和现有测试约定，明确用户可观察行为。
2. 写出建议测试的公开 **seam**、每个 seam 的 **interface** 与待验证行为。测试只能穿过公开 interface，不测试实现细节。
3. 若用户尚未明确批准这些 seams，使用 `ask_user_question` 请求一次聚焦确认。确认前不得调用 TDD workflow。
4. 记录固定基线（优先当前 `HEAD`）和调度前工作区状态，避免把既有改动错误归因给 worker。
5. 明确规格来源、允许修改的范围、测试命令、仓库标准与停止条件。

## 调度

调用 `pi_matt_dispatch`：

- `workflow`: `tdd`
- `task`: 必须包含需求/缺陷、已确认 seams 与行为、固定基线、既有工作区改动、允许文件范围、测试命令、标准/spec 来源和停止条件

工作流按代码强制的阶段执行：

1. `implement`：唯一 `worker` 加载 `codebase-design` 与 `tdd-executor`，一次只做一个 vertical slice；每轮先取得真实 RED，再写最小实现取得 GREEN。
2. 只有 `implement.structuredOutput.status === "COMPLETE"` 且已提供非空 seams、cycles、changed files 与 commands 时才进入复核；其结构化结果会追加给后续 lanes，作为 RED/GREEN 过程证据。
3. `standards` 与 `spec`：两个 fresh-context、只读 reviewer 并行检查最终工作区变化。
4. 两个 reviewer 都必须返回 `PASS`；任一 `FAIL`/`NO_EVIDENCE` 会触发 lane gate，使整个 workflow fail closed。

上游方法把 refactor 放在 review 阶段，而不是 red→green 循环内。不要让 worker 在测试刚变绿后顺手扩大重构范围；需要重构时，根据 review finding 由父会话取得授权后再启动下一次受限实现。

## 汇总

1. 收到 completion result 后，只消费 `implement`、`standards`、`spec` 三个 lane 的 `structuredOutput`。
2. 任一 lane 失败、缺失或 schema 不合法时，整个工作流失败；不得回退到普通 prose。
3. 核验 worker 报告包含每个 slice 的 RED 与 GREEN 证据、实际变更文件和验证命令。
4. 分离呈现 Standards 与 Spec 结果。任一 reviewer 返回 `FAIL` 时，不宣称任务完成；先报告 finding 并等待用户决定是否进入修复循环。
5. 即使 reviewer 均通过，也由父会话检查最终 diff 和工作区，确认没有越过批准 seams、范围或既有改动。
