---
name: matt-tdd
description: 在用户确认测试 seam 后，以唯一 worker 执行逐片 red→green，并由 fresh Standards/Spec reviewer 复核结果。用于测试驱动实现功能或修复缺陷。
metadata:
  pi-scope: parent
  pi-class: orchestration
  pi-upstream-path: skills/engineering/tdd/SKILL.md
  pi-upstream-sha: 6654f6b60cd9d5be8b54c6fafe44346dabeb3b76
---

# Test-Driven Development

父会话拥有需求收敛、seam 确认、调度和最终判断。`matt-worker` 是唯一写者；后续 reviewer 只读。

## 调度前

1. 读取相关代码、`.x-matt/context/`、`.x-matt/adr/`、项目说明和现有测试约定，明确用户可观察行为。
2. 写出建议测试的公开 **seam**、每个 seam 的 **interface** 与待验证行为。测试只能穿过公开 interface，不测试实现细节。
3. 对每个候选测试执行测试价值 gate：显式验收行为、缺陷回归、业务规则、分支/状态转换、权限/数据完整性或公开 contract 必须保留；仅重复现有覆盖、无分支且无业务语义并可由编译/typecheck/现有 contract test 直接保障的低风险简单变更、验证框架本身、不可达或规格明确排除的假设性边缘情况可以省略独立测试。代码行数少本身不是省略理由；多个紧密相关的简单断言可以合并进一个行为级测试。记录省略项和理由，避免 worker 机械地为每个字段或边缘情况创建测试方法。
4. 若用户尚未明确批准这些 seams 与测试价值判断，使用 `ask_user_question` 请求一次聚焦确认。确认前不得调用 TDD workflow。
5. 记录固定基线（优先当前 `HEAD`）和调度前工作区状态，避免把既有改动错误归因给 worker。
6. 明确可供 reviewer 核验的标准文件、当前 ticket、parent spec 和其他规格来源的具体路径，以及允许修改的范围、module/package 搜索边界与停止条件。TDD reviewer 固定使用 `reviewKind=worktree`：先核对 `implement.structuredOutput.changedFiles` 与 `worktree-files`，tracked 文件逐文件使用 `worktree-diff`，untracked 文件直接读取，deleted 文件只读 diff，rename 同时核验 old/new 路径。把命令分成每轮 RED/GREEN 的最小命令、全部 slices 后的相关回归命令和父会话最终验证命令；后者不得下发给 worker。没有明确 spec/验收行为或无法提供 reviewer 初始证据边界时停止，不进入 TDD；不要依赖 reviewer 的 `NO_EVIDENCE` 代替调度前检查。

## 调度

调用 `pi_matt_dispatch`：

- `workflow`: `matt-tdd`
- `task`: 必须包含需求/缺陷、已确认 seams 与测试价值判断、省略测试的候选项及理由、固定基线、既有工作区改动、允许文件范围、RED/GREEN 最小命令、worker 相关回归命令、`reviewKind=worktree`、标准文件具体路径、当前 ticket/parent spec 具体路径、reviewer 初始证据边界、module/package 搜索边界和停止条件。明确声明完整测试套件、全量 build 与最终验证由父会话在 workflow 完成后执行，worker 不得运行

工作流按代码强制的阶段执行：

1. `matt-implement`：唯一 `matt-worker` 加载 `codebase-design` 与 `tdd-executor`，一次只做一个 vertical slice；每轮先取得真实 RED，再写最小实现取得 GREEN。
2. 只有 `implement.structuredOutput.status === "COMPLETE"` 且已提供非空 seams、cycles、changed files 与 commands 时才进入复核；其结构化结果会追加给后续 lanes，作为 RED/GREEN 过程证据。
3. `standards` 与 `spec`：两个 fresh-context、只读 reviewer 并行检查最终工作区变化。
4. 两个 reviewer 都必须返回 `PASS`；任一 `FAIL`/`NO_EVIDENCE` 会触发 lane gate，使整个 workflow fail closed。

上游方法把 refactor 放在 review 阶段，而不是 red→green 循环内。不要让 worker 在测试刚变绿后顺手扩大重构范围；需要重构时，根据 review finding 由父会话取得授权后再启动下一次受限实现。

## 汇总

1. 收到 completion result 后，只消费 `matt-implement`、`standards`、`spec` 三个 lane 的 `structuredOutput`。
2. 任一 lane 失败、缺失或 schema 不合法时，整个工作流失败；不得回退到普通 prose。
3. 核验 worker 报告包含每个 slice 的 RED 与 GREEN 证据、实际变更文件和验证命令。
4. 分离呈现 Standards 与 Spec 结果。任一 reviewer 返回 `FAIL` 时，不宣称任务完成；先报告 finding 并等待用户决定是否进入修复循环。
5. 即使 reviewer 均通过，也由父会话检查最终 diff 和工作区，确认没有越过批准 seams、范围或既有改动。
