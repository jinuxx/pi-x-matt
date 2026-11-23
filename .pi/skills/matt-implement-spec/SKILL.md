---
name: matt-implement-spec
description: 在当前分支串行实现已拆票的 Local Markdown spec，逐票验证后提交，整批只做一次独立集成评审。
disable-model-invocation: true
metadata:
  pi-scope: parent
  pi-class: interaction
  pi-dispatch: none
  pi-depends-on: matt-implement
  pi-upstream-path: skills/engineering/implement-spec/SKILL.md
  pi-upstream-sha: abeeaf95660ba9e8b7c753eb38f441ca707a8823
---

# Implement Spec（串行轻量版）

**逐票验证，最后做集成评审。** 普通票以实测验收为门禁；高风险或关键验收无法充分自动验证的票，仍在提交前独立复核。风险分类和检查命令随整批计划一次确认。只有[显式风险接受](../matt-tdd/dispatch-contract.md#显式风险接受与收尾)允许用户针对普通 Standards P2 单独接受风险；整批评审不继承单票风险收据。

这是用户显式调用的批量编排入口，留在同一父会话中逐张应用 [matt-implement](../matt-implement/SKILL.md)，不把整个 spec 作为一次 TDD implementation。它只支持已配置的 Local Markdown tracker 和已经发布的 spec/tickets；其他 tracker 停止并报告首版不支持，不自动切换或迁移。

沿批量入口的当前分支工作，不另行请求分支确认；只有用户指定的分支与实际分支冲突时才停下澄清。不创建 worktree、integration branch 或 merger，不 push、不创建 PR。任意时刻最多一个 `matt-worker`，每张 ticket 都使用独立的 fresh TDD workflow。轻量版不提供跨 ticket 的 fresh 父会话；只向 worker 下发当前 ticket 的 Context Pack，不灌入整批历史。

调用示例：

```text
/skill:matt-implement-spec .x-matt/work/<feature-slug>/spec.md
/skill:matt-implement-spec .x-matt/work/<feature-slug>/spec.md <原始 fixed-point SHA>
```

开始前完整读取 `matt-implement`、[matt-tdd](../matt-tdd/SKILL.md)、[matt-code-review](../matt-code-review/SKILL.md)，并应用[隐私契约](../matt-setup/privacy.md)。本 skill 不通过 `pi_matt_dispatch` 调度自身；执行型 workflow 仍只走 registry。

## 预检与图

1. 读取 `.x-matt/agents/issue-tracker.md`、`triage-labels.md` 和 `domain.md`，确认 Local Markdown lifecycle 可执行。本机 exclude 必须保护整个 `.x-matt/` 与个人 `.pi/`，资料未被 Git 跟踪；源码维护例外按真实 package root 核验。直接读取精确路径的 ignored 文件，不以 Git-aware 搜索判断缺失。
2. 用户必须给出准确 active spec 路径。核对 `Type: spec`、`Status: spec-ready`，默认跳过整个 `.x-matt/work/shipped/`；spec、ticket 或 blocker 指向 shipped 时停止，用户点名的历史只读也不构成实现入口。
3. 只枚举该 feature 的 `issues/`，读取全部 ticket 的 `Type: ticket`、`Parent`、status、`Blocked by` 和验收正文。每张 ticket 的 Parent 必须精确指向此 spec；不把 decision ticket、`Parent: None` 或其他 feature 混入图。没有 tickets 时提示先运行 `matt-to-tickets`，不创建缺失 artifact。
4. 验证所有 blocker 都是本图中的真实 ticket，拒绝缺失引用、自依赖和循环依赖。未完成项只接受 `ready-for-agent`；已完成项只接受 `resolved` 或有明确用户批准排除理由的 `out-of-scope`。对每个 `resolved` 读取完整 `Implementation commit`，用 `git merge-base --is-ancestor <SHA> HEAD` 核验；失败时停止，不按残留状态跳过或重做实现。`out-of-scope` 不能解锁依赖它的 ticket，也不能冒充已实现的 spec 验收项。
5. 固定当前 branch、HEAD 和整批评审 fixed point。新批次没有已完成 ticket 时默认以开始的实际 HEAD SHA 为 fixed point；用户提供基线时核验它存在且是 HEAD 的祖先。续跑有已完成 ticket 时必须恢复原始 fixed point，缺失则停止并请求准确基线，不能把当前 HEAD 当作基线隐藏之前的实现。每个已完成实现提交还必须位于 fixed point 之后；基线范围夹带无关提交时停止并澄清，不把无关代码归入本 spec。
6. `git status` 必须干净（不含 ignored 本地资料）；有既有改动则列出阻塞，不 stash、reset 或提交用户改动。展示 spec、基线、终态票、依赖与串行顺序，以及每票的 `delivery` 和命令。新普通票用 `verified` 并声明覆盖验收的 `preReviewCommands`；高风险或缺充分自动证据用 `reviewed`。有 `spec.md.dispatch.json` 时，原生命令读取计划，由宿主展示精确信封并确认一次；agent 不改既有计划。未声明 `delivery` 的存量计划按原双轴门禁执行；若要升级，须由用户重新确认新计划，不能改变已派发票的策略。无本地计划时用顶层 `batch` 取得同等确认。授权不按时间过期，但不是全局写入权限；可用 `/matt-revoke` 撤销。

## 串行 frontier

frontier 仅包含 `ready-for-agent` 且全部 blockers 已 `resolved`、实现提交已在当前 HEAD ancestry 的 tickets。已有本地计划时按锁定顺序处理；否则按编号升序、同编号按仓库相对路径排序。每轮只取第一张，不一次排队多个 workflow。没有 frontier 但仍有未完成 ticket 时停止并报告具体 blockers；不能跳过失败项、删除 blocking edges 或擅自把 ticket 排除。

对当前 ticket：

1. 重新读取 spec、ticket 与 blockers，核验分支、基线 ancestry、图成员、原有验收与 edges 未漂移。ticket 集合或需求发生变化时停止并重新确认范围；既有完成说明与状态回写不算需求扩张。
2. 完整应用 `matt-implement` 的单 ticket 流程：陈述标题，按已批准的验收确定测试切入点，记录各切入点能覆盖和不能覆盖的行为及测试取舍，再生成当前 ticket 的 Implementation Context Pack。批量确认已涵盖这些范围内的决定，不逐票询问测试方案或是否继续。不要把整个 spec 的未实现部分交给该票 Spec reviewer。
3. 每张 ticket 提供与已确认条目完全一致的 `implementation.ticket`、`scope`、精确 `allowedFiles`、`delivery` 和获批命令，以 `pi_matt_dispatch` 的 `matt-tdd` 执行。`verified` 只给 `laneTasks.implement`，`reviewed`（或旧计划）另给 `standards` / `spec`。已锁定本地计划时省略 `batch`；否则首票用 `batch` 取得真实确认，后续可省略。`finalValidationCommands` 由宿主读取，不进入工具信封。宿主签发 HEAD-bound grant，不重复询问；undeclared ticket、额外文件/命令、语义扩张和 tracker 图漂移都不静默执行。同票修复保留 batch binding，新增范围或命令变更仍须显式确认。
4. 同票连续修复与 reviewer recovery 沿用原 dispatch lineage；不跨 ticket 复用 `dispatchId`、scope 或旧 Evidence Pack。`DIAGNOSIS_REQUIRED` 按既有受限诊断契约处理，未解除不得追加 writer。任何 BLOCKED、未恢复的失败或接受状态不明都暂停整批，不切到下一张来绕过。首次 writer 有合格环境阻塞快照时，环境修复后按 [blockedRecovery 契约](../matt-tdd/dispatch-contract.md#初次批次实现的环境阻塞恢复) 显式续跑；符合[超时续跑契约](../matt-tdd/dispatch-contract.md#初次实现的-writer-超时续跑)时宿主自动续跑一次，仍超时才请求用户确认第二次续跑。
5. 适用的交付门禁通过后，父会话核对 diff 与验收，补做该票尚未覆盖的必要验证。不逐票重复完整套件；项目硬要求或该票风险要求的验证不省略。声明了 `finalValidationCommands` 时须等宿主 `required final validation PASS` 或同时通过这些检查的风险收据。宿主记录隔离 index/object store 算出的 candidate tree；真实提交的单一 parent 必须是采集时 HEAD，tree 必须一致。提交成功、原始 fixed point ancestry、工作区干净和本地 tracker `Status: resolved` / `Implementation commit` 写回核验后才进入下一张；写回失败不重新提交。
6. 保存该票标题、commit、dispatchId、验证结果和原始 fixed point；重读并计算下一轮 frontier。已提交实现属于当前 HEAD ancestry 才解锁后续工作，不依赖内存中的“done”标记。每张票执行完成后仅编排 parent 可以继续下一张，`matt-implement` 自身不批量循环。

当前票通过实现门禁后若另有本票的最终验证回归，不提交、不推进，也不编造 reviewer finding。保持候选原样，按[最终验证续修](../matt-tdd/dispatch-contract.md#双-pass-后的最终验证续修)提交失败命令。宿主证实后续跑同一 writer；对修复结果显式 `review`，`verified` 省略 `laneTasks`，只结算宿主复验；`reviewed`（或旧计划）在实测通过后做增量复核。最后再按原门禁提交。

## 整份 spec 评审与结束

全部 tickets 均已达到核验过的终态，才进入整份 spec 集成评审。parent spec 保持 `spec-ready`，已批准排除项带原始依据，不能静默减少验收。

1. 确认 branch、干净工作区、实现提交、ticket 终态、spec 及原始 fixed point。先跑一次尚未覆盖的完整测试套件和必要集成检查；失败不启动评审，不自动回滚、改票或报告整批完成。
2. 调用一次 `pi_matt_dispatch` 的 `matt-code-review`，用 `reviewScope: { kind: "committed", fixedPoint: <原始 fixed point SHA> }`（`reviewKind=committed`）。宿主采集完整提交证据，不手写 Pack。Spec lane 提供完整 parent spec、声明 tickets 的聚合 acceptance matrix、已通过测试及排除依据，重点看跨票验收、遗漏与冲突。Standards lane 提供工程规范和关键风险，重点看集成回归、权限和数据完整性；不重新扫已经验证的命名、风格或等价测试。两项 laneTasks 独立，不把规格全文送 Standards。
3. 读取完整结构化结果并核验双轴。committed 采集失败、范围无效、HEAD 漂移、FAIL、NO_EVIDENCE、执行失败或缺失结果都先停止整批并保留报告；供应商/网络失败解决后可用 `recovery: {dispatchId, lanes}` 做一次失败轴恢复，只提供该轴 task，省略 reviewScope，复用原 Pack 与另一轴结果。轻量版不自动创建修复 tickets、不重新打开已 resolved 的票，不反复启动广域 review/fix 循环。需要后续修复时交还用户明确范围；仅符合上述风险接受边界时可请求独立确认。
4. 只有集成检查通过、两轴 PASS（或有合格的独立风险收据）、证据仍对应当前 HEAD，才报告整批交付。报告验证命令、每票 commit、排除项、最终 review 和剩余风险；暂停也报告基线和已完成提交，不回滚。

不自动写 `shipped`，不调用 `matt-archive`，不改 parent spec，不归档、不暂存或提交 tracker。不 push、不开 PR、不改历史。归档必须由用户之后另行显式调用 `matt-archive`。
