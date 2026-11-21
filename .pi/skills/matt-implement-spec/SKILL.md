---
name: matt-implement-spec
description: 在当前分支串行实现已有 Local Markdown spec 的 tickets，逐票复用 TDD、验证和提交，全部完成后做一次整份 spec 双轴评审。用于显式请求批量实现已拆票的 spec。
disable-model-invocation: true
metadata:
  pi-scope: parent
  pi-class: interaction
  pi-dispatch: none
  pi-depends-on: matt-implement
  pi-upstream-path: skills/engineering/implement-spec/SKILL.md
  pi-upstream-sha: a496f5513d4a4cf889bc48e189e579f4b0bdf6aa
---

# Implement Spec（串行轻量版）

**交付策略例外**：双 PASS 仍为默认要求。若仅剩普通 Standards P2 且 Spec PASS，可按 [显式风险接受](../matt-tdd/dispatch-contract.md#显式风险接受与收尾) 对该精确候选取得用户新的真实确认。原 FAIL 不变，报告与本地 tracker 明确“带已知风险交付”和 `Risk acceptance: <宿主返回的 dispatchId>`；宿主仍核验 candidate tree、parent、commit 与 tracker 收据，batch 授权不接受风险。最终整份 spec committed 评审不继承单票风险接受，需要对该范围独立确认。验收、安全、完整性及 P0/P1 不豁免，不能自动降级或自行提交。

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
6. `git status` 必须干净（不含 ignored 本地资料）；存在已有 tracked/untracked 改动时停止并列出阻塞，不 stash、reset 或提交用户改动。展示 spec 标题、固定基线、已完成/排除项、依赖图和串行顺序。有 `spec.md.dispatch.json` 时，原生命令读取计划，由宿主展示精确信封并确认一次；本次 agent 不改写该计划。没有计划时将 spec、原始 fixed point 和各票信封通过顶层 `batch` 提交，走相同的一次确认。批次确认后不按时间过期，但不是全局写入权限；模型输入和 `batch` 参数不能自授权。用户可用 `/matt-revoke` 撤销。基线或计划漂移、范围扩张、恢复耗尽等需用户决定时，汇总阻塞、已完成票和建议的下一步，不重复询问。

## 串行 frontier

frontier 仅包含 `ready-for-agent` 且全部 blockers 已 `resolved`、实现提交已在当前 HEAD ancestry 的 tickets。已有本地计划时按锁定顺序处理；否则按编号升序、同编号按仓库相对路径排序。每轮只取第一张，不一次排队多个 workflow。没有 frontier 但仍有未完成 ticket 时停止并报告具体 blockers；不能跳过失败项、删除 blocking edges 或擅自把 ticket 排除。

对当前 ticket：

1. 重新读取 spec、ticket 与 blockers，核验分支、基线 ancestry、图成员、原有验收与 edges 未漂移。ticket 集合或需求发生变化时停止并重新确认范围；既有完成说明与状态回写不算需求扩张。
2. 完整应用 `matt-implement` 的单 ticket 流程：陈述标题，按已批准的验收确定测试切入点，记录各切入点能覆盖和不能覆盖的行为及测试取舍，再生成当前 ticket 的 Implementation Context Pack。批量确认已涵盖这些范围内的决定，不逐票询问测试方案或是否继续。不要把整个 spec 的未实现部分交给该票 Spec reviewer。
3. 每张 ticket 提供与已确认 batch 条目完全一致的 `implementation.ticket`、`scope`、精确 `allowedFiles`、诊断清单、`preReviewCommands`（若声明）和完整 `implement` / `standards` / `spec` laneTasks，以 `pi_matt_dispatch` 的 `workflow: matt-tdd` 执行。原生命令已锁定本地计划时省略 `batch`；否则首票提交 `batch` 作确认，后续声明票可省略。`finalValidationCommands` 只由宿主读取，不进入工具信封。宿主按当前 session branch 的可信 batch 记录和声明的串行 frontier 签发新的 HEAD-bound 单票 grant，不重复询问。当前信封必须等于批准条目；undeclared ticket、额外文件/命令、语义扩张、Parent/type/status/active path 不合法或 `Blocked by` 图漂移时拒绝并要求新的显式 batch 确认。同票修复/送审即使省略 `batch` 也保留宿主 batch binding；只增文件或替换诊断清单属于新的单票信封，须显式重新确认一次，batch 计划本身不扩张。
4. 同票连续修复与 reviewer recovery 沿用原 dispatch lineage；不跨 ticket 复用 `dispatchId`、scope 或旧 Evidence Pack。`DIAGNOSIS_REQUIRED` 按既有受限诊断契约处理，未解除不得追加 writer。任何 BLOCKED、未恢复的失败或接受状态不明都暂停整批，不切到下一张来绕过。只有宿主保存了合格环境阻塞快照的首次 writer 可在环境修复后按 [blockedRecovery 契约](../matt-tdd/dispatch-contract.md#初次批次实现的环境阻塞恢复) 显式续跑。
5. 等 TDD 和双轴 review 均成功，由父会话完成剩余验证并提交。如果本地计划声明了 `finalValidationCommands`，须等当前 dispatch 的宿主通知 `required final validation PASS`（或已通过这些验证的 `accepted-risk` 回执），不能把双轴 `PASS` 当成完整验证通过。`preReviewCommands` 仍失败时也不提交。batch 运行中宿主记录隔离 index/object store 算出的 candidate tree；提交必须只有一个 parent 等于采集时的 HEAD，且 tree 与证据一致，不能夹带无关文件、额外提交、amend、merge 或 history switch。只有提交成功、真实 commit 属于原始 fixed point ancestry、当前工作区干净，且本地 tracker `Status: resolved` 与 `Implementation commit` 写回均核验通过并匹配该 commit，才进入下一张；“代码已提交、tracker 待修复”必须暂停，不重新提交。
6. 保存该票标题、commit、dispatchId、验证结果和原始 fixed point；重读并计算下一轮 frontier。已提交实现属于当前 HEAD ancestry 才解锁后续工作，不依赖内存中的“done”标记。每张票执行完成后仅编排 parent 可以继续下一张，`matt-implement` 自身不批量循环。

当前票双 PASS 后若父会话完整验证发现本票引入的回归，不提交、不推进，也不编造 reviewer finding。保持已审候选原样，按 [最终验证续修](../matt-tdd/dispatch-contract.md#双-pass-后的最终验证续修) 提交实际失败命令；使用本地计划为该票预批的 `finalValidationCommands`，无需再次确认，未预批的命令仍须确认。宿主证实回归后续跑同一 writer。对修复结果显式 `review`，等宿主复验和 fresh 双轴 PASS，再完成其余父会话验证、提交和 tracker 核验。

## 整份 spec 评审与结束

全部 tickets 均已达到核验过的终态，才进入整份 spec 评审；中途只做当前票的 TDD 双轴复核。parent spec 始终保持 `spec-ready`，已批准排除项须带原始依据，不能静默减少 spec 需求。

1. 确认当前 branch 未变、工作区干净，重新核验所有实现提交、ticket 终态、spec 内容和原始 fixed point。
2. 调用一次 `pi_matt_dispatch` 的 `workflow: matt-code-review`，顶层传 `reviewScope: { kind: "committed", fixedPoint: <原始 fixed point SHA> }`（`reviewKind=committed`）。宿主解析并固定原始 fixed point 到当前 HEAD 的完整范围，只在两个 reviewer 前从 Git 对象采集一次 committed Pack，覆盖本 spec 的所有实现提交而不只最后一票；父会话不手写额外 committed Pack，也不传 caller hash/HEAD/path/command。Spec lane 明确接收完整 parent spec、全部声明 tickets 的聚合 acceptance matrix 与排除依据（文本声明，不是共享 API，也不复制给 Standards）；Standards lane 只接收适用工程规范与安全/正确性边界。两项完整 laneTasks 分开提供。
3. 读取完整结构化结果并核验双轴。committed 采集失败、范围无效、HEAD 漂移、FAIL、NO_EVIDENCE、执行失败或缺失结果都先停止整批并保留报告；供应商/网络失败解决后可用 `recovery: {dispatchId, lanes}` 做一次失败轴恢复，只提供该轴 task，省略 reviewScope，复用原 Pack 与另一轴结果。轻量版不自动创建修复 tickets、不重新打开已 resolved 的票，不反复启动广域 review/fix 循环。需要后续修复时交还用户明确范围；仅符合上述风险接受边界时可请求独立确认。
4. 只有最终两轴 PASS、证据仍对应当前 HEAD 且所有逐票验证通过，才报告整批实现完成。报告分支、原始 fixed point、每票 commit、排除项、最终 review 和剩余风险；暂停也输出基线、已完成提交、阻塞票和续跑入口，不回滚已成功提交。

不自动写 `shipped`，不调用 `matt-archive`，不改 parent spec，不归档、不暂存或提交 tracker。不 push、不开 PR、不改历史。归档必须由用户之后另行显式调用 `matt-archive`。
