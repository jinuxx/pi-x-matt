---
name: matt-code-review
description: 沿 Standards 与 Spec 两个相互独立的轴评审固定范围内的代码变化。用于评审分支、PR、工作区变更、计划实现结果或指定文件。
metadata:
  pi-scope: parent
  pi-class: orchestration
  pi-upstream-path: skills/engineering/code-review/SKILL.md
  pi-upstream-sha: 3cca18b368ae95cdbdebbff572ccafa662551015
---

# Code Review

父会话负责固定评审范围、识别标准与规格来源，并保持两个评审轴相互独立。

## 调度前

1. 明确评审对象：优先使用用户给出的 fixed point、diff、文件或计划。没有明确范围时必须先收敛范围。
2. 明确 `reviewKind`：未提交或未跟踪变化为 `worktree`；只评审 fixed-point 到 `HEAD` 的已提交变化为 `committed`；非 Git 计划/指定文件为 `files`。优先准备 [Review Evidence Pack](../matt-tdd/context-packs.md)：fixed point/current HEAD、状态、完整 manifest、完整 diff、新文件全文/hash、测试证据来源。不要只给目录或笼统的“相关代码”，不采用 writer 自述替代原始证据。
3. 必须取得所有 tracked 文件完整 diff；允许一次完整、未截断的 combined diff，不强制逐文件调用。`worktree` 使用 `worktree-files` 与 `worktree-diff`，untracked 获得全文，deleted 只读 diff，rename 核验 old/new，禁止以 `ref...HEAD` 代替工作区证据。`committed` 使用 `diff-files ref` 与 `diff ref`；`files` 精确列出文件且不调用 Git。已有完整 Pack 不要求 reviewer 再执行以上步骤；截断或需深入时才补读。
4. 给 Standards 提供本次适用工程规范摘录及来源路径/章节/hash、安全与正确性边界，不要求完整 parent spec。
5. 给 Spec 提供当前 ticket 内容或准确摘要、acceptance matrix、该 ticket 明确声明的 active parent spec 相关 acceptance/decision/out-of-scope 及来源，或明确 `无可用 spec`；查找顺序到此为止。默认跳过 `.x-matt/work/shipped/`，不得枚举、搜索或把 archived spec 当作候选/近似回退；即使用户同一会话点名后允许历史只读，它也不能成为当前 Spec 轴规格。找不到 active ticket/parent 时继续返回 `无可用 spec`。不要求无关工程规范，也不把 sibling/future tickets、ADR、context 或 roadmap 作为规格，不伪造需求。
6. 默认只读 manifest。仅在截断、symbol 不明、直接依赖待核验、hash 不符或安全/数据完整性风险时，先说明具体缺失证据，再在给定 module/package 定向补读最多一层，不递归、不扫描整个 module。限定证据不足返回 `NO_EVIDENCE`，而不是扩大范围制造 PASS。

## 调度

调用 `pi_matt_dispatch`：

- `workflow`: `matt-code-review`
- `task`: 只放两条 lane 共用的目标、`reviewKind`、Review Evidence Pack 路径或内联原始证据、fixed point、完整 manifest、条件式一层扩展边界和停止条件。
- `laneTasks`: 为 `standards` 和 `spec` 分别提供完整替换，复制各自需要的共同证据，并只附该轴适用的标准或验收条款。已内联且来源可核验的内容无需重复 `read`。

Dispatcher 会并行启动两个 fresh-context reviewer：

- `standards`：仓库标准、正确性、测试与代码异味
- `spec`：需求遗漏、范围膨胀和错误实现

## 汇总

1. 收到 completion result 后，只读取 `standards` 与 `spec` lane 的 `structuredOutput`；不要把普通 `output`、`outputReference` 或文件扩展名当作结构化结果。
2. 任一 lane 失败、缺失或 `structuredOutput` 不符合对应 workflow schema 时，整个评审工作流失败；不得用自然语言输出替代该轴。
3. 两个对象均有效时，保持结果分离呈现，不把一个轴的结论改写成另一个轴的优先级。父会话只过滤无证据或超出范围的 finding，并分别报告每轴 verdict、finding 数和最严重问题。
