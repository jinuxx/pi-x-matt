---
name: matt-code-review
description: 沿 Standards 与 Spec 两个相互独立的轴评审固定范围内的代码变化。用于评审分支、PR、工作区变更、计划实现结果或指定文件。
metadata:
  pi-scope: parent
  pi-class: orchestration
  pi-upstream-path: skills/engineering/code-review/SKILL.md
  pi-upstream-sha: a496f5513d4a4cf889bc48e189e579f4b0bdf6aa
---

# Code Review

父会话负责固定评审范围、识别标准与规格来源，并保持两个评审轴相互独立。

先应用[业务项目隐私契约](../matt-setup/privacy.md)。将本次私有路径、禁止外泄边界与已核验的源码维护例外交给 Standards lane；Spec lane 只接收本次明确验收条款，不借隐私检查扩张业务需求。不要把原始评审/会话记录写进团队文档。

## 调度前

1. 明确评审对象：优先使用用户给出的 fixed point、diff、文件或计划。没有明确范围时必须先收敛范围。
2. 明确 `reviewKind`：未提交或未跟踪变化为 `worktree`；只评审 fixed-point 到 `HEAD` 的已提交变化为 `committed`；非 Git 计划/指定文件为 `files`。`committed` 不在父会话预先取证：调用时传顶层 `reviewScope: { kind: "committed", fixedPoint: "<ref>" }`，由宿主解析 F、固定 H 并执行一次固定 collector。`worktree`/`files` 仍优先准备 [Review Evidence Pack](../matt-tdd/context-packs.md)：fixed point/current HEAD、状态、完整 manifest、完整 diff、新文件全文/hash、测试证据来源。不要只给目录或笼统的“相关代码”，不采用 writer 自述替代原始证据。
3. 手动路径必须取得所有 tracked 文件完整 diff；允许一次完整、未截断的 combined diff，不强制逐文件调用。`worktree` 使用 `worktree-files` 与 `worktree-diff`，untracked 获得全文，deleted 只读 diff，rename 核验 old/new，禁止以 `ref...HEAD` 代替工作区证据；`files` 精确列出文件且不调用 Git。`committed` 不再在父会话运行 `diff-files`/`diff` 或手写 Pack，只使用宿主固定 F/H 后写出的只读 committed Pack；本地 diff/attribute/submodule ignore 配置不影响该对象范围。已有完整 Pack 不要求 reviewer 再执行以上步骤；截断或需深入时才补读。
4. 搜索仓库中所有描述代码应如何编写的文档；存在 `CODING_STANDARDS.md` 或 `CONTRIBUTING.md` 时必须列入 Standards 清单。给 Standards 提供本次适用工程规范摘录及来源路径/章节/hash、安全与正确性边界，不要求完整 parent spec。
5. 按 `.x-matt/agents/issue-tracker.md` 的 tracker 契约取回 commit message 中的 issue 引用；契约缺失或不可执行时提示用户运行 `matt-setup`，不自行猜测 `gh`、`glab` 或本地路径。给 Spec 提供当前 ticket 内容或准确摘要、acceptance matrix、该 ticket 明确声明的 active parent spec 相关 acceptance/decision/out-of-scope 及来源，或明确 `无可用 spec`；查找顺序到此为止。默认跳过 `.x-matt/work/shipped/`，不得枚举、搜索或把 archived spec 当作候选/近似回退；即使用户同一会话点名后允许历史只读，它也不能成为当前 Spec 轴规格。找不到 active ticket/parent 时继续返回 `无可用 spec`。不要求无关工程规范，也不把 sibling/future tickets、ADR、context 或 roadmap 作为规格，不伪造需求。
6. 默认只读 manifest。仅在截断、symbol 不明、直接依赖待核验、hash 不符或安全/数据完整性风险时，先说明具体缺失证据，再在给定 module/package 定向补读最多一层，不递归、不扫描整个 module。限定证据不足返回 `NO_EVIDENCE`，而不是扩大范围制造 PASS。

## 调度

`matt-implement-spec` 的末尾整份 spec 评审是明确的聚合范围：允许使用该 parent 已核验的 active parent spec 和它声明的全部 tickets 的聚合 acceptance matrix，而非伪造“当前单 ticket”。只在全部 tickets 达到经核验的终态后使用，固定原始 fixed point 到 HEAD 的完整 committed diff；未声明的 sibling/future tickets 与 shipped 仍不进入 Spec 轴。该范围不改变普通单 ticket 或无 spec 评审的查找规则。

调用 `pi_matt_dispatch`：

- `workflow`: `matt-code-review`
- 已提交范围使用顶层 `reviewScope: { kind: "committed", fixedPoint: "<ref>" }`：宿主自行解析 F 为完整 commit、核验它是当前 HEAD 的祖先、在入队时固定 H，并在两个 reviewer 启动前执行一次固定 collector，只读取 Git 对象 `F..H` 的 manifest、完整 combined diff、变化文本/hash/type/mode 与 rename old/new。调用方不提供 hash、HEAD、路径或命令；`fixedPoint` 等于 HEAD 时允许空范围，不用 merge-base 替换范围。工作区 staged/unstaged/untracked、项目外路径和 Git symlink 目标都不进入 committed Pack；binary/不可读内容/子模块沿用既有 fail closed。采集失败、无效范围或 HEAD 漂移必须在 reviewer 前停止，不手动重试或回退工作区采集。省略 `reviewScope` 时保持既有手动 `worktree`/`files` Pack 行为。
- `task`: 只放两条 lane 共用的目标、`reviewKind`、Review Evidence Pack 路径或内联原始证据、fixed point、完整 manifest、条件式一层扩展边界和停止条件。
- `laneTasks`: 为 `standards` 和 `spec` 分别提供完整替换，复制各自需要的共同证据，并只附该轴适用的标准或验收条款。Spec 的 inline source 是 lane task 内的文本声明，附实际规格原文来源；它不是新的共享 API，也不复制给 Standards。已内联且来源可核验的内容无需重复 `read`。

整份 spec 汇总评审须把完整 active parent spec 与聚合 acceptance matrix 放入 `laneTasks.spec`，或明确提供可读取的原始来源；committed Git Pack 不包含 ignored tracker 规格，不能仅用 ticket 摘要替代完整 parent spec。缺证据仍返回 `NO_EVIDENCE`，notes 给出具体缺失来源和补到 `laneTasks.spec` 的动作；不把规格全文复制给 Standards，也不靠关键字检测猜测规格已完整。

两个轴在一次 dispatch 中一同发出并前台等待，聚合各自返回的报告；不要串行跑轴，也不要让一个轴的上下文污染另一个轴。Dispatcher 会并行启动两个 fresh-context reviewer：

- `standards`：仓库标准、正确性、测试与代码异味
- `spec`：需求遗漏、范围膨胀和错误实现

## 汇总

committed 模式的执行失败/NO_EVIDENCE 可用 `recovery: {dispatchId, lanes}` 做一次局部恢复：只提供所选轴的 `laneTasks`，省略 `reviewScope`，复用宿主原 F/H、JSON/Markdown Pack 与另一轴原结果；不重采、不重跑 writer 或有效 verdict。先处理供应商额度/网络问题，不自动盲重试。HEAD、Pack、项目或最新 dispatch 漂移时停止。手动 worktree/files 没有该恢复保证。

只有全部剩余 finding 都是普通 Standards P2 且 Spec PASS 时，才可按 [显式风险接受](../matt-tdd/dispatch-contract.md#显式风险接受与收尾) 请求 `acceptRisk`；真实用户再次确认后得到 `accepted-risk` 收据，不是 PASS，不继承单票或 batch 的风险接受。其余失败继续阻断。

1. 收到 completion result 后，先按 [Workflow Result Reading](../matt-tdd/results.md) 核对终态并读取完整 JSON，再只读取 `standards` 与 `spec` lane 的 `structuredOutput`；不要把普通 `output`、`outputReference` 或文件扩展名当作结构化结果。
2. 任一 lane 失败、缺失或 `structuredOutput` 不符合对应 workflow schema 时，整个评审工作流失败；不得用自然语言输出替代该轴。
3. 两个对象均有效时，保持结果分离呈现，不把一个轴的结论改写成另一个轴的优先级。父会话核验每项 basis、复现/代码路径、expected/actual、稳定 ID 与 original/regression/independent 分类；修复复核还核对 [增量边界](../matt-tdd/dispatch-contract.md)。只合并共同根因，不合并 verdict；无证据/越轴/无影响的旧内容报告属于评审契约问题，不擅自把 FAIL 改为 PASS，应只纠正该轴报告，不派发 writer。分别报告每轴 verdict、有效 finding 数和最严重问题。
