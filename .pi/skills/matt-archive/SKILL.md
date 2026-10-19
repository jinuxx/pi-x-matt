---
name: matt-archive
description: 在用户显式指定 Local Markdown feature slug 后，核验实现提交与完成条件，把 parent spec 标记为 shipped 并仅在本地移入归档目录，不创建 Git 提交。
disable-model-invocation: true
metadata:
  pi-scope: parent
  pi-class: interaction
  pi-dispatch: none
  pi-depends-on: ""
  pi-upstream-path: docs/engineering/to-spec.md
  pi-upstream-sha: 3cca18b368ae95cdbdebbff572ccafa662551015
---

# Archive

本 skill 是 Local Markdown parent spec 的唯一归档入口。它只能由用户在独立步骤中显式调用，只接受一个准确的 `<feature-slug>`；不得从标题、相似目录、当前 frontier 或最近处理的 ticket 猜测目标。它不进入 `matt-implement`、`matt-tdd` 或任何 workflow lane，不启动 subagent，也不改变 implementation ticket 的 `resolved` 语义。

先应用[业务项目隐私契约](../matt-setup/privacy.md)：业务项目保护整个 `.x-matt/` 与个人 `.pi/`，包括归档、领域知识和入口；源码维护例外只保留必要的发布资源，不取消已有的本地 tracker 边界。

普通会话必须把 `.x-matt/work/shipped/` 视为不存在。只有用户在同一会话明确点名某个归档 spec 的标题或路径时，才可只读对应归档目录；该授权只覆盖被点名对象、只在当前会话有效，不能据此枚举其他归档、重新开启 ticket、改写状态、创建新 ticket、作为 frontier/implementation 入口，或作为 `matt-to-tickets`、`matt-implement`、`matt-wayfinder`、`matt-code-review` Spec 轴的候选或近似回退规格。

## 输入与初始 gate

1. 要求用户提供一个不含 `/`、不是 `shipped` 的准确 feature slug。源目录固定为 `.x-matt/work/<feature-slug>/`，目标固定为 `.x-matt/work/shipped/<feature-slug>/`。
2. 读取 `.x-matt/agents/issue-tracker.md`，确认 tracker 是 Local Markdown 且包含 shipped 契约；remote tracker 或契约缺失时停止。
3. 读取当前 branch、`git status --short` 与完整 `HEAD`，保存 index 基线。归档必须从 Git 工作区干净（不含本地 ignored tracker）的基线开始；存在 staged、unstaged 或 untracked 变化时拒绝，不处理用户其他工作。
4. 确认源目录真实存在、位于仓库内且不是 symlink；目标目录不存在。不得扫描 `.x-matt/work/` 寻找近似 slug，也不得覆盖已有归档。
5. 完整列出源目录内文件。必须存在 `spec.md`；implementation tickets 只能从该目录的 `issues/*.md` 精确取得。其他文件会随目录原样移动，但不能被当成 ticket 或归档条件的替代证据。
6. 按 tracker 契约核验源目录没有被 Git 跟踪，源与目标路径均受本地 exclude 保护；目标不存在时使用 `git check-ignore --no-index` 验证计划路径。保护未生效或源仍被跟踪时拒绝，先修复配置；不得为归档执行 `git add -f` 或取消跟踪。直接读取已知路径，不因 Git-aware 搜索跳过 ignored 文件就判为不存在。

## 归档资格

移动前完整读取一次 `spec.md` 与全部 `issues/*.md`，并同时满足以下条件；任一条件不满足都停止，只报告缺失项，不做部分写入：

1. **Spec lifecycle**：spec 是 `Type: spec` 且 `Status: spec-ready`。parent spec 只允许 `spec-ready → shipped`，不存在其他合法状态转换。
2. **Ticket terminal state**：每个 issue 都是 `Type: ticket`，`Parent` 精确等于当前 `.x-matt/work/<feature-slug>/spec.md`，`Status` 只能是 `resolved` 或 `out-of-scope`。存在 `ready-for-agent`、缺失状态或其他状态时拒绝。每个 `Blocked by` 必须是 `None`，或逗号分隔且全部位于当前 `.x-matt/work/<feature-slug>/issues/` 的仓库相对 ticket 路径；每个引用都必须真实存在。存在跨 feature blocker 时拒绝，因为归档后所有 Parent 与 Blocked by 都必须解析到本 feature 的 shipped 目录。
3. **Commits landed**：对每个 `resolved` ticket，直接读取本地 `## Comments` 中的 `Implementation commit: <完整 commit SHA>`，核验 commit 存在且 `git merge-base --is-ancestor <SHA> HEAD` 成功，并检查该提交与 ticket 实现相符。`out-of-scope` 必须有明确排除理由，不要求不存在的实现提交；其说明如显式引用相关 commit，也须属于当前 `HEAD`。缺少记录、SHA 无效或提交不在当前 branch 时拒绝，不从 ticket 的 Git 历史推断，不补造完成记录。
4. **Durable knowledge settled**：读取 `.x-matt/context/CONTEXT.md`（若存在）和 `.x-matt/adr/` 下相关记录，并对照 spec、ticket 完成说明与相关提交。实现中形成的新 canonical term、跨会话事实或通过 ADR gate 的难逆转决定必须已经写入这些持久文档；明确没有新增持久知识是合法结果。若证据显示仍有待沉淀知识，或无法判断一个明显的长期决定是否应落盘，列为缺失项并拒绝归档，不在本 skill 中顺手补写领域文档。

拒绝结果按以上四类列出准确文件与缺失事实，不把“大体完成”解释为 shipped。

## 原子移动与改写

所有资格检查通过后，先保存移动前 spec 与全部 tickets 的完整内容和 hash，随后在同一工作区事务中：

1. 创建唯一容器 `.x-matt/work/shipped/`（若尚不存在），用普通文件系统移动把整个 `.x-matt/work/<feature-slug>/` 移到 `.x-matt/work/shipped/<feature-slug>/`；不用 `git mv`，保持 `spec.md`、`issues/` 和其他文件的相对结构、文件名与字节内容，不删除 ticket。
2. 只把移动后 `spec.md` 顶部 metadata 的 `Status: spec-ready` 改为 `Status: shipped`。
3. 对每张移动后的 ticket，只做路径迁移所需的 metadata 替换：
   - `Parent: .x-matt/work/<feature-slug>/spec.md` 改为 `Parent: .x-matt/work/shipped/<feature-slug>/spec.md`；
   - `Blocked by` 中每个 `.x-matt/work/<feature-slug>/issues/` 引用都改为 `.x-matt/work/shipped/<feature-slug>/issues/`。
4. 不重排 metadata，不改标题、正文、acceptance criteria、comments、Source session 或 ticket Status，不格式化整份文件。

## 写后核验与本地完成

1. 移动和改写后再次完整读取 spec 与全部 tickets。对每个文件计算期望内容：移动前原文只允许发生上述 Status/Parent/Blocked by 精确替换；任何额外字节变化都视为正文损坏并停止。
2. 核对旧目录不存在、目标目录真实存在、spec 为 `Type: spec` / `Status: shipped`，每个 ticket 的 Parent 与内部 Blocked by 都能解析到 shipped 目录下的真实文件；确认没有残留旧 feature 路径。
3. 用移动前原文/hash 与精确内容比较核验本地变更，不以 Git diff 代替 ignored 文件的内容证据。变更范围只能是该 feature 的目录移动、spec status 和 ticket path metadata；不得包含实现代码、测试、context、ADR、其他 feature 或用户既有变化。
4. 归档不暂存、不创建提交、不 push、不创建 PR。核对 `HEAD`、index 与 Git status 均和初始基线一致，目标仍被忽略且未被跟踪。移动、改写或核验失败时用保存的原文和路径恢复本次本地改动，不留下 `shipped` 状态或半完成目录，不用 Git reset/checkout 丢弃其他工作。
5. 报告本地归档路径、feature slug、ticket 数量、相关实现 commit 与核验结果；明确归档没有创建提交。

## Fail-closed

以下情况必须拒绝：用户未显式调用或未给准确 slug；目标已在 shipped；Git 工作区不干净；本地忽略保护失效或 tracker 被跟踪；spec/ticket metadata 不合法；存在非 terminal ticket；内部 blocker 不可解析；实现 commit 缺失、无效或不在当前 branch；持久知识未沉淀；前后完整读取或精确内容比较失败；Git 基线发生变化。不得通过修改 ticket 状态、补造完成 comment、忽略 blocker、扫描其他归档或把 tracker 加入实现提交来绕过。
