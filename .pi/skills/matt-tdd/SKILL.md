---
name: matt-tdd
description: 在用户确认测试 seam 后，以唯一 worker 执行逐片 red→green，并由 fresh Standards/Spec reviewer 复核结果。用于测试驱动实现功能或修复缺陷。
disable-model-invocation: true
metadata:
  pi-scope: parent
  pi-class: orchestration
  pi-upstream-path: skills/engineering/tdd/SKILL.md
  pi-upstream-sha: 3cca18b368ae95cdbdebbff572ccafa662551015
---

# Test-Driven Development

本 skill 是 `matt-implement` 使用的内部执行 parent，不是从 grilling 或普通功能请求自动进入的用户流程。没有 `matt-implement` 已核验的单 ticket/direct-slice handoff、固定基线和允许范围时，standalone 调用必须停止并提示先使用 `/skill:matt-implement`；不得自行补做 spec/ticket 或把“用户想开始实现”当作调度授权。

父会话拥有需求收敛、seam 确认、调度和最终判断。`matt-worker` 是唯一写者；后续 reviewer 只读。

## 调度前

1. 复用 `matt-implement` 已核验的上下文，按 [Context Pack 契约](context-packs.md) 生成 Implementation Context Pack。必须获得 ticket、相关 spec 验收/decision/out-of-scope 与适用项目说明；已取得内容不重复读取。ticket、parent、blocker 或 manifest 规格来源只要位于 `.x-matt/work/shipped/` 就立即 fail closed，不读取、不调度任何 lane；归档内容即使被用户点名也只能作为历史依据，不能进入 TDD。相关源码、词汇与测试按精确 manifest 分级；架构全文、全部 ADR 和整个模块调用者仅按需读取。
2. 写出建议测试的公开 **seam**、每个 seam 的 **interface** 与待验证行为。测试只能穿过公开 interface，不测试实现细节。
3. 对每个候选测试执行测试价值 gate：显式验收行为、缺陷回归、业务规则、分支/状态转换、权限/数据完整性或公开 contract 必须保留；仅重复现有覆盖、无分支且无业务语义并可由编译/typecheck/现有 contract test 直接保障的低风险简单变更、验证框架本身、不可达或规格明确排除的假设性边缘情况可以省略独立测试。代码行数少本身不是省略理由；多个紧密相关的简单断言可以合并进一个行为级测试。记录省略项和理由，避免 worker 机械地为每个字段或边缘情况创建测试方法。
4. 若用户尚未明确批准这些 seams 与测试价值判断，使用 `ask_user_question` 请求一次聚焦确认。确认前不得调用 TDD workflow。
5. 记录固定基线（优先当前 `HEAD`）和调度前工作区状态，避免把既有改动错误归因给 worker。
6. 在 Pack 中给出 acceptance matrix、parent/blocker 核验结果、known code map、expected change points、fixed point/文件 hash、精确文件 manifest（关系、必须/按需读取）、允许修改范围、一次定向搜索的一层边界与停止条件。分别准备 Standards 的适用规范摘录和 Spec 的相关验收条款。TDD 固定 `reviewKind=worktree`：实现后由 workflow 独立生成 Review Evidence Pack，包含完整 combined diff、untracked 全文/hash 和 deleted/rename old/new；reviewer 不重复取证。把命令分成每轮 RED/GREEN、相关回归和 parent-only final validation；后者只由父会话保留与执行。没有明确 spec/验收行为、已核验 ticket/direct-slice handoff 或精确 manifest 时停止，不依赖 reviewer 补齐。缺少 artifact 时不得使用 `write`/`edit` 创建 spec 或 ticket 解阻。

## 调度

调用 `pi_matt_dispatch`：

- `workflow`: `matt-tdd`
- `task`: 只放三条 lane 都可安全读取的共享事实：需求/缺陷、已确认 seams 与测试价值判断、省略测试的候选项及理由、固定基线、既有工作区改动、允许文件范围、`reviewKind=worktree`、标准文件、当前 ticket/parent spec、module/package 搜索边界和停止条件。不得把仅适用于 implement 的 report-only、旧 transcript、禁止 diff、`status COMPLETE` 等指令放入共享 task。
- `laneTasks`: 必须同时提供 `implement`、`standards`、`spec` 三项完整替换，不自动继承 `task`。`implement` 包含 Implementation Context Pack、RED/GREEN 与相关回归命令，明确完整测试套件/全量 build/最终验证由父会话执行、worker 不得运行。`standards` 只需共同证据边界、适用工程规范与安全/正确性边界；`spec` 只需共同边界、ticket acceptance matrix 与 parent spec 相关条款。两者先消费 workflow 生成的 Review Evidence Pack，额外读取仅限已说明的缺口、一层直接依赖；不得要求 `status COMPLETE` 或用旧 transcript 代替 diff。report-only、resume 或失败恢复也必须提供三项，不退回共享 task。

Dispatcher 只在无法确认用户显式发起实现时才拦截：本 session 由用户执行 `/skill:matt-implement` 启动时直接放行；模型自行走到 TDD 时会要求用户确认当前调用来自已核验的 ticket/direct-slice handoff。用户取消或当前 mode 没有可响应的 UI 时必须拒绝调度；不得把失败解释为已经授权，也不得绕过 `pi_matt_dispatch`。

工作流按代码强制的阶段执行：

1. `matt-implement`：唯一 `matt-worker` 加载 `codebase-design` 与 `tdd-executor`，一次只做一个 vertical slice；每轮先取得真实 RED，再写最小实现取得 GREEN。
2. 只有 `implement.structuredOutput.status === "COMPLETE"` 且已提供非空 seams、cycles、changed files 与 commands 时，workflow 才通过受信任的 host step 独立采集完整 Git Review Evidence Pack；采集失败或 HEAD/工作区漂移则停止，不启动 reviewer。结构化命令记录附带 phase、exitCode、testCount/outcome，明确是 worker-reported 过程证据，不是独立验证。
3. `standards` 与 `spec`：两个 fresh-context、只读 reviewer 并行消费同一个 Pack 与各自适用条款，独立判断最终变化，不重新发现上下文。
4. 两个 reviewer 都必须返回 `PASS`；任一 `FAIL`/`NO_EVIDENCE` 会触发 lane gate，使整个 workflow fail closed。

上游方法把 refactor 放在 review 阶段，而不是 red→green 循环内。不要让 worker 在测试刚变绿后顺手扩大重构范围；需要重构时，根据 review finding 由父会话取得授权后再启动下一次受限实现。

## 汇总

1. 收到 completion result 后，只消费 `matt-implement`、`standards`、`spec` 三个 lane 的 `structuredOutput`。
2. 任一 lane 失败、缺失或 schema 不合法时，整个工作流失败；不得回退到普通 prose。
3. 核验 worker 报告包含每个 slice 的 RED 与 GREEN 证据、实际变更文件和验证命令。
4. 分离呈现 Standards 与 Spec 结果。任一 reviewer 返回 `FAIL` 时，不宣称任务完成；先报告 finding 并等待用户决定是否进入修复循环。
5. 即使 reviewer 均通过，也由父会话核对 Review Evidence Pack 与当前 HEAD、status、文件 hash，检查最终 diff，确认没有越过批准 seams、范围或既有改动。Pack 过期不得沿用 PASS。
