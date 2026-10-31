---
name: matt-tdd
description: 在用户确认测试 seam 后，以唯一 worker 执行逐片 red→green，并由 fresh Standards/Spec reviewer 复核结果。用于测试驱动实现功能或修复缺陷。
disable-model-invocation: true
metadata:
  pi-scope: parent
  pi-class: orchestration
  pi-upstream-path: skills/engineering/tdd/SKILL.md
  pi-upstream-sha: a496f5513d4a4cf889bc48e189e579f4b0bdf6aa
---

# Test-Driven Development

本 skill 是 `matt-implement` 使用的内部执行 parent，不是从 grilling 或普通功能请求自动进入的用户流程。没有 `matt-implement` 已核验的单 ticket/direct-slice handoff、固定基线和允许范围时，standalone 调用必须停止并提示先使用 `/skill:matt-implement`；不得自行补做 spec/ticket 或把“用户想开始实现”当作调度授权。

父会话拥有需求收敛、seam 确认、调度和最终判断。`matt-worker` 是唯一写者；后续 reviewer 只读。

## 调度前

1. 复用 `matt-implement` 已核验的上下文，按 [Context Pack 契约](context-packs.md) 生成 Implementation Context Pack。必须获得 ticket、相关 spec 验收/decision/out-of-scope 与适用项目说明；已取得内容不重复读取。ticket、parent、blocker 或 manifest 规格来源只要位于 `.x-matt/work/shipped/` 就立即 fail closed，不读取、不调度任何 lane；归档内容即使被用户点名也只能作为历史依据，不能进入 TDD。相关源码、词汇与测试按精确 manifest 分级；架构全文、全部 ADR 和整个模块调用者仅按需读取。
2. 写出建议测试的公开 **seam**、每个 seam 的 **interface** 与待验证行为，并给每个候选 seam 附一行说明它能抓到什么、漏掉什么，供用户取舍。测试只能穿过公开 interface，不测试实现细节。
3. 对每个候选测试执行测试价值 gate：显式验收行为、缺陷回归、业务规则、分支/状态转换、权限/数据完整性或公开 contract 必须保留；仅重复现有覆盖、无分支且无业务语义并可由编译/typecheck/现有 contract test 直接保障的低风险简单变更、验证框架本身、不可达或规格明确排除的假设性边缘情况可以省略独立测试。代码行数少本身不是省略理由；多个紧密相关的简单断言可以合并进一个行为级测试。参数化案例按独立行为、字段映射和共享校验等价类选取：同一等价类保留一个代表输入，不默认生成字段×状态×错误值的全排列；只有该组合产生不同的可观察行为、状态转换或安全/数据完整性风险时才拆成独立案例。不设任意案例数上限，也不为降低统计数合并独立行为。记录保留项的代表输入、预计展开次数、昂贵准备成本以及省略项和理由，避免 worker 机械地为每个字段或边缘情况创建测试方法。
4. 若用户尚未明确批准这些 seams 与测试价值判断，使用 `ask_user_question` 请求一次聚焦确认。确认前不得调用 TDD workflow。
5. 记录固定基线（优先当前 `HEAD`）和调度前工作区状态，避免把既有改动错误归因给 worker。
6. 在 Pack 中给出 acceptance matrix、parent/blocker 核验结果、known code map、expected change points、fixed point/文件 hash、精确文件 manifest（关系、必须/按需读取）、允许修改范围、一次定向搜索的一层边界与停止条件。分别准备 Standards 的适用规范摘录和 Spec 的相关验收条款。TDD 固定 `reviewKind=worktree`：实现后由 workflow 独立生成 Review Evidence Pack，包含完整 combined diff、untracked 全文/hash 和 deleted/rename old/new；reviewer 不重复取证。把命令分成每轮 RED/GREEN、相关回归和 parent-only final validation；后者只由父会话保留与执行。没有明确 spec/验收行为、已核验 ticket/direct-slice handoff 或精确 manifest 时停止，不依赖 reviewer 补齐。缺少 artifact 时不得使用 `write`/`edit` 创建 spec 或 ticket 解阻。

## 调度

调用 `pi_matt_dispatch`：

- `workflow`: `matt-tdd`
- `implementation`、连续修复的 `repair`、独立送审的 `review`、挑战有效 FAIL 的 `reconsider` 或失败 reviewer/report correction 的 `recovery`：完整遵循 [Dispatch Lifecycle](dispatch-contract.md)。保存宿主 dispatchId；不得以重复初始实现代替修复/送审/复核/恢复。
- `task`: 只放三条 lane 都可安全读取的共享事实：需求/缺陷、已确认 seams 与测试价值判断、省略测试的候选项及理由、固定基线、既有工作区改动、允许文件范围、`reviewKind=worktree`、标准文件、当前 ticket/parent spec、module/package 搜索边界和停止条件。不得把仅适用于 implement 的 report-only、旧 transcript、禁止 diff、`status COMPLETE` 等指令放入共享 task。
- `laneTasks`: 必须同时提供 `implement`、`standards`、`spec` 三项完整替换，不自动继承 `task`。`implement` 包含 Implementation Context Pack、RED/GREEN 与相关回归命令，明确完整测试套件/全量 build/最终验证由父会话执行、worker 不得运行。`standards` 只需共同证据边界、适用工程规范与安全/正确性边界；`spec` 只需共同边界、ticket acceptance matrix 与 parent spec 相关条款。两者先消费 workflow 生成的 Review Evidence Pack，额外读取仅限已说明的缺口、一层直接依赖；不得要求 `status COMPLETE` 或用旧 transcript 代替 diff。report-only、resume 或失败恢复也必须提供三项，不退回共享 task。

Dispatcher 将真实用户 invocation/运行时确认绑定到 ticket 内容 hash、项目/branch/HEAD 与明确范围，从宿主可信记录恢复 reload。相同范围的连续修复复用授权，不重复询问入口或已经批准的 seams/范围；同 ticket 仅增加 `allowedFiles` 或替换诊断清单时需重新确认一次，并以最新 `implementation` 信封和显式旧 `dispatchId` 延续同一修复谱系，ticket/行为/ticket hash/branch/HEAD 与旧 `allowedFiles` 不可变。已有未取消派发后不得再发 initial，重新授权或重新 invocation 也不能重置基线、计数或 findings。新 ticket、范围扩张、架构/破坏性决定仍须确认。无可靠授权且无 UI、取消、未响应或过期时拒绝调度；模型文字不能授权，也不得绕过 `pi_matt_dispatch`。

`matt-implement-spec` 的 batch 入口也必须先取得一次显式 TUI/RPC 确认，才形成可信 batch 能力；随后宿主按声明的 spec/ticket/`Blocked by` 图与精确信封为每张串行 ticket 签发新的 HEAD-bound 单票 grant，声明票之间不重复询问，也不接受模型提供的 digests、tree、commit 或授权文字。同票修复/送审省略 `batch` 元数据时仍保留宿主 binding；undeclared ticket、额外文件/命令/语义、内容或边漂移、未通过双轴 PASS 的候选、parent/tree/模式不符的提交、伪造 tracker 写回、额外提交、非原始 fixed-point ancestry、取消/过期/new session/fork 全部 fail closed。batch 不改变本 workflow 的唯一 writer、三项 laneTasks、双轴 PASS gate 或父会话最终验证；提交、push、PR、归档仍不属于 TDD。

初次实现按代码强制的阶段执行：

1. `implement`：唯一 `matt-worker` 加载 `codebase-design` 与 `tdd-executor`，一次只做一个 vertical slice；每轮先取得真实 RED，再写最小实现取得 GREEN。
2. 只有 `implement.ok === true`、`implement.structuredOutput.status === "COMPLETE"` 且已提供非空 seams、cycles、changed files 与 commands 时，workflow 才通过受信任的 host step 独立采集完整 Git Review Evidence Pack；采集失败或 HEAD/工作区漂移则停止，不启动 reviewer。结构化命令记录附带 phase、exitCode、testCount/outcome，明确是 worker-reported 过程证据，不是独立验证。
3. `standards` 与 `spec`：两个 fresh-context、只读 reviewer 并行消费同一个 Pack 与各自适用条款，独立判断最终变化，不重新发现上下文。
4. 每个阶段在校验与 gate 前将全部已结算结果发布到 `status.json → workflow.emits` 的带标识快照。两个 reviewer 都必须返回 `PASS`；任一 `FAIL`/`NO_EVIDENCE` 仍触发 lane gate，使整个 workflow fail closed，快照不改变失败终态。

修复与正式评审分开调度：`repair` resume 最近的 writer，完成后只采集累计修复证据并返回 implement lane 与 `pi-x-matt.review-pending` 标记，不运行 stage 2。父会话先逐项核对 findings、真实 diff 与聚焦验证；需要继续同范围修复时再次 `repair`，准备好后才用 `review: {dispatchId: "<最新 repair>"}`。送审复用该 implement 结果与候选快照，仅运行 fresh 双轴，范围是最近正式评审以来的全部修复而非最后一轮补丁。三项 laneTasks、授权、快照/范围、根因诊断与最终双轴 PASS gate 不变；writer 不可恢复或候选过期时停止，不自动重新实现。父会话不能用 prose 撤回有效 FAIL：有争议的 finding 必须逐项带 reason/evidence 走 `reconsider`，只运行受影响轴，由 fresh reviewer 独立 `uphold`/`withdraw`；未 challenge finding 与另一轴原样保留，任一保留/upheld blocker 仍为有效 FAIL。每个候选快照每轴最多一次 reconsider。reviewer 报告契约错误走独立有界的 report correction（每轴每候选最多两次），不得与一次 execution recovery 互相消耗，也不得自动变成 PASS。

reviewer 完成限定范围检查后一次报告全部有证据的阻断项，不在发现首个 finding 时提前返回 FAIL。保持证据边界；缺证据仍返回 NO_EVIDENCE，不能靠扩大扫描来追求穷尽。

合法 reconsider 的 `state=complete` 只说明决定已应用；检查 `pi-x-matt.reconsideration-complete` 的 `reviewPassed`、`remainingFindingIds` 及 effective 双轴，任何剩余 FAIL 都禁止提交或推进 batch。升级后旧宿主误判的完整 `review-evidence` 报告可经原 recovery 入口原地重校验，不运行模型、不消耗或重置预算；仍无效的报告或 schema/执行失败不能豁免。跨轴关联仅限宿主提供的 causal predecessor IDs 与有变化影响证据的 regression，各轴 basis/裁决继续独立。

上游方法把 refactor 放在 review 阶段，而不是 red→green 循环内。不要让 worker 在测试刚变绿后顺手扩大重构范围；需要重构时，根据 review finding 由父会话取得授权后再启动下一次受限实现。

## 汇总

1. 收到 completion result 后，先按 [Workflow Result Reading](results.md) 核对终态并读取完整 JSON。初次实现/正式送审消费 `implement`、`standards`、`spec` 三个 lane 的 `structuredOutput`；repair 只返回 implement，reconsider 返回合并后的 effective 双轴并带 `reconsiderationHistory`。repair 成功仍是待审候选，不能宣称 TDD 全流程完成或提交。
2. 区分复核结论不通过、实现 `BLOCKED` 与执行失败/结果缺失/schema 无效；失败 workflow 按契约读取最新阶段快照，不要求异常分支存在 `workflow.value`。检查所有已返回 lane，保留两个轴的完整结果；不得回退到普通 prose。
3. 核验 worker 报告包含每个 slice 的 RED 与 GREEN 证据、实际变更文件和验证命令；若 RED 靠临时改代码或 fixture 强制得到，要求提供对 pristine 副本的 `diff` 证明 mutation 确实落地，不采信未证明的 red。
4. 分离呈现 Standards 与 Spec 结果。任一 reviewer 返回 `FAIL`/`NO_EVIDENCE` 时，不宣称任务完成或允许提交；先完整报告两轴 finding/证据缺口。已有连续修复授权覆盖的真实 findings 按结构化根因契约聚焦修复，不再重复询问；新增决定/范围才询问。仅 disputed valid finding 走 `reconsider`，报告契约错误走独立 correction，`NO_EVIDENCE` 或执行失败走一次 execution recovery；都不重复 writer。reconsider 后必须以 effective remaining findings 修复，不能回到 reconsider 前 source。同根因两轮未解或相关回归触发受限诊断，不机械开启下一轮补丁。
5. 即使 reviewer 均通过，也由父会话核对 Review Evidence Pack 与当前 HEAD、status、文件 hash，检查最终 diff，确认没有越过批准 seams、范围或既有改动。Pack 过期不得沿用 PASS。
