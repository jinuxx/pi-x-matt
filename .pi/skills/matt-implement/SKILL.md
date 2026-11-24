---
name: matt-implement
description: 根据已确认的 ticket 或单 slice 计划实现一个工作切片，先做确定性验收，高风险改动独立复核，再提交当前分支。
disable-model-invocation: true
metadata:
  pi-scope: parent
  pi-class: interaction
  pi-dispatch: none
  pi-depends-on: matt-domain-modeling
  pi-upstream-path: skills/engineering/implement/SKILL.md
  pi-upstream-sha: abeeaf95660ba9e8b7c753eb38f441ca707a8823
---

由 `matt-implement-spec` 串行调度时，本单票步骤不变；宿主已确认的 batch 能力只按声明的 spec/ticket/envelope 为该票签发 HEAD-bound grant，声明票之间不重复 TUI 确认。同票修复/送审即使省略顶层 `batch` 元数据也保留宿主 batch binding；增加文件或替换诊断清单仍须显式单票重新确认，batch 计划本身不扩张。提交前宿主已有 trusted collector 的 candidate tree 证明时，父会话必须让真实 commit 的 parent 和 tree 精确匹配，并在 tracker 写回后由宿主核验下一票前置；batch 不授予 push、PR、merge、committer 或归档权限。

# Implement

**交付策略**：先确定验收怎么验证，再决定是否需要独立 reviewer。默认普通票以宿主实测为门禁；权限、项目/租户隔离、数据完整性、不可逆迁移等高风险改动，或关键验收不能充分自动验证时，提交前还要做独立复核。风险分类随精确信封向用户确认，不能在失败后切换策略。

本 skill 把已经决定的一个工作切片变成当前分支上的提交。它不重新 grill，不改变计划/ticket 的目标，不批量处理多个 tickets，也不平行写共享工作区。每次 invocation 只处理一个 ticket；没有已发布 ticket 时，只接受用户在先前 transition handoff 中明确选择“直接实现”、可在一个 session 完成且尚未发布为 `Type: spec`/`Status: spec-ready` 的单 slice 计划。缺少 ticket 本身不构成 direct-slice 授权。`spec-ready` parent spec 必须先进入 `matt-to-tickets`，不能直接实现。

先应用[业务项目隐私契约](../matt-setup/privacy.md)：业务项目整个 `.x-matt/` 与个人 `.pi/` 都是私有资料，不只是 tracker；不向团队 AGENTS/README、代码注释或提交信息写入工具使用标记。真实插件源码仓库按契约保留分发资源例外，不把源码整体忽略。将本次私有路径和已核验例外交给 worker/reviewer。

## 开始前

1. 确认当前 branch 是用户希望写入的 branch；读取 `git status`、`git log` 和当前 fixed point。不要改写或归因用户既有工作区改动。
2. 用户以编号、URL 或路径传入 ticket reference 时，先按 `.x-matt/agents/issue-tracker.md` 的 tracker 契约取回并陈述其标题；同一 reference 对应多个候选、无匹配或与用户描述不符时，用 `ask_user_question` 澄清后再继续。必须获得完整 ticket/当前已确认计划和 parent spec 中相关 acceptance、decision、out-of-scope；内容已在会话中且来源/基线可核验时不重复读取。提取本次适用的 AGENTS/README 条款与领域词汇；相关源码、测试和一层直接调用者列入精确 manifest。架构全文、全部 ADR 和整个模块调用者仅按需读取，不把所有材料全文下发。
3. 对 ticket 核对 title、type、parent、status、blocked-by、acceptance criteria 和 scope。Local Markdown 只接受 `Type: ticket` 且 `Status: ready-for-agent` 的入口；ticket 路径、Parent 或任何待读取 blocker 一旦位于 `.x-matt/work/shipped/`，立即 fail closed，提示该 ticket 已随 spec 归档，不能实现、重新开启或借 archived blocker 解锁 active ticket。默认不得枚举 shipped 内容；用户同一会话点名授权也仅允许历史只读，不构成实现授权。`Parent: None` 只表示没有 parent spec 的当前会话单 slice，其他 Parent 值必须作为 ticket 中声明的仓库相对路径读取，并核对目标是 active `Type: spec`、`Status: spec-ready`。如果目标项目提供 `scripts/check-local-ticket.mjs`，它只做 Parent 字段存在性与 shipped 非入口 preflight，不能替代该 relationship 核验；没有该脚本时直接执行本段的人工读取核验。逐个读取 `Blocked by` 引用，只有 blocker 同时为 `Type: ticket` 且 `Status: resolved` 才算完成。只实现一个 ticket；parent/blocker 未完成、ticket reference 无法核验或输入互相矛盾时停止。没有 ticket 时，必须在当前会话中找到 grilling/diagnosis 等上游流程留下的明确 direct-slice handoff 和用户授权；greenfield、多业务流程、多个独立测试切入点、部署或迁移工作，以及依赖用户提供且不能安全压缩的事实、说明、样例或约束的工作，不得作为无 ticket 单 slice 开始。材料类型不限于技术 contract。
   Local Markdown tracker 只在本机维护：按 `.x-matt/agents/issue-tracker.md` 核验当前 feature 受本地 Git exclude 保护且未被跟踪，否则停止并提示先修复配置。按精确路径直接读取 ignored ticket/parent/blocker，不依赖 Git-aware 搜索或 `git show`；在 Context Pack 中提供内容与 hash，不能因它们不在 Git diff 中就判为缺失。对每个 resolved blocker 还须读取 Comments 的完整 `Implementation commit`，核验 commit 存在且 `git merge-base --is-ancestor <SHA> HEAD` 成功；记录缺失或仅在其他 branch 上存在时停止，不能用本地残留状态解锁。metadata checker 不能替代此核验。
4. 从 ticket 或当前会话单 slice 计划中提取候选测试切入点，并先做测试价值判断。显式 acceptance criterion、缺陷回归、业务规则、分支/状态转换、权限/数据完整性和公开 contract 必须有测试；不要仅因代码行数少而跳过。纯机械且已被现有行为测试覆盖的映射、无分支且无业务语义并可由编译/typecheck/现有 contract test 直接保障的低风险简单变更、框架自身行为、不可达或规格明确排除的假设性边缘情况，不必新增独立测试方法；多个紧密相关的简单字段优先由一个行为级测试覆盖，而不是一字段一测试。参数化案例按独立行为、字段映射和共享校验等价类选取：同一等价类保留一个代表输入即可，不默认生成字段×状态×错误值的全排列；只有当某个组合本身产生不同的可观察行为、状态转换或安全/数据完整性风险时才单独保留。不为压缩数量而合并独立行为，也不规定测试案例数上限。把保留的测试行为、代表输入、预计展开次数和省略项的理由都写入 TDD task。若没有可执行的公开测试切入点、行为或聚焦测试命令，停止并报告缺口；不要在 implement 中重新设计。
5. 先只读核实实际源码、直接调用者和测试模块，再按 [Context Pack 契约](../matt-tdd/context-packs.md) 生成 Implementation Context Pack。**读过的精确 manifest 与用户批准的写入范围是两份不同的清单。** 新单票普通改动提议经核实的窄目录及目录外少量精确路径，不必猜目录内的新文件名；`reviewed` 只提议精确路径。目录不存在时，核实其真实父模块及新建理由再授权。用 RED/GREEN、worker 相关回归、parent-only final validation 区分命令；完整测试套件与全量 typecheck/build 仅由父会话保留和执行，不得把父会话最终验证命令作为 worker 执行项下发。
6. 完整读取并应用 [domain-modeling](../matt-domain-modeling/SKILL.md) 的写入边界。worker 若在实现中发现值得持久化的新术语或 ADR 级决定，必须通过 `contact_supervisor` 报告而不是写领域文档；当前 TDD run 随即停止为 `BLOCKED`。run 退出后由父会话按 domain-modeling gate 取得用户决定并仅写本地资料，再以新基线重新调度，确保父会话与 worker 不并行写同一工作区；源码维护例外遵循已声明边界。

## 执行顺序

### 1. 实现并验证候选

按 [TDD](../matt-tdd/SKILL.md) 调用 `pi_matt_dispatch`（`workflow`: `matt-tdd`），保存宿主 `dispatchId`。`/skill:matt-implement` 只启动编排，不替代授权；宿主尚无有效授权时，对具体范围确认一次。信封绑定 ticket、写入边界与命令；无可信授权且无 UI 的 print/JSON mode 仍须 fail closed。扩大边界或替换命令须真实重新确认，不重开 initial、不重置发现或基线。

新工单用 `implementation.allowedDirectories` 启用受控写入：普通票填核实后的窄目录，可配目录外 `allowedFiles`；高风险、只有精确路径时传 `[]` 和 `allowedFiles`。批次从该票已确认的条目继承；旧信封沿用原形状。不预先列获批目录内每个新文件。将 worker 的 RED/GREEN 与聚焦命令精确登记在 `diagnosticCommands` / `preReviewCommands`，供受控 writer 在原项目环境执行；命令不得改写 Git 候选或 index。独立的父会话验收不加入子写者命令清单。

writer 的写工具会在越界落盘前拒绝。若宿主报告可信 `scopeBlocker`，不要自己改草稿或重派 initial；先只读核实它列出的全部新增路径和理由，再用最新派发 ID 请求 [`scopeRecovery`](../matt-tdd/dispatch-contract.md#单票按范围授权与扩围)。用户同意后同一 writer 用剩余时间继续。已经写出界、候选漂移、未封存或不愿扩围则停下。

| 当前票 | `implementation.delivery` | 候选门禁 |
| --- | --- | --- |
| 普通票，有可执行的确定性验收 | `verified`（默认选择） | 只传 `laneTasks.implement`；必须登记覆盖变更行为的 `preReviewCommands`。writer 做真实 RED→GREEN，宿主对同一候选实测并取得完整 Pack；不启动 reviewer，不声称双 PASS。 |
| 高风险或自动检查无法充分证明关键验收 | `reviewed` | 提供 `implement`、`standards`、`spec`；有合适的命令就登记并先跑，通过后独立评审该票验收和关键风险。初审后最多一次修复（包括最终验证续修）和一次增量复核。 |

只选可在基线上运行并通过、本地确定性、不改写工作区的聚焦命令，不用无关检查充当验收。`task` 只放公共目标和证据边界，`reviewKind=worktree`；writer 与 reviewer 用各自 lane task。存量信封未声明 `delivery` 时仍走原双轴契约，不升级既有授权。任何档都要有真实 TDD 证据；宿主检查一次纠正后仍不通过则停下，不送审、不提交。缺少基线、验收、ticket 或规划材料时停止，提示进入对应上游流程；禁止父会话直接创建或改写 `.x-matt/work/` 来解阻。

首次 writer 达到上限时按[超时续跑契约](../matt-tdd/dispatch-contract.md#初次实现的-writer-超时续跑)处理。符合条件时宿主自动续跑原 writer；单票只可在原文件信封内继续，父会话不改草稿、不重发 initial。只有自动续跑也超时且宿主报告可续跑时，才按最新 dispatchId 请求 `timeoutRecovery` 并由用户确认。

### 2. 只处理真实阻断

`reviewed` 只让已证实的验收失败、可达回归、关键工程约束、安全/数据完整性问题或必要验收证据缺口阻断；命名、非关键规范、重构偏好、等价测试建议进 `notes`。按共享根因合并全部 blocker，一次 `repair` 续跑原 writer，先跑回归再用最新 `dispatchId` 一次 `review`。只复核原问题、累计修复直接影响的行为和有证据的新安全/完整性风险；不重新扫全票。若仍失败或宿主验证没通过，保留候选和证据，停下交用户决定，不自动开始新一轮。

特殊情况按 [Dispatch Lifecycle](../matt-tdd/dispatch-contract.md) 处理：`recovery` 只恢复失败轴，`reconsider` 只裁决有证据的异议，`recollect` 仅修复获批文件信封的越界收集，`writerRecovery` 仅恢复同一个符合条件的失败 writer。都不能抹掉有效 FAIL 或绕过宿主验证。只剩普通 Standards P2 且 Spec PASS 时，可按[显式风险接受](../matt-tdd/dispatch-contract.md#显式风险接受与收尾) 让用户确认精确候选，保留原 FAIL 并在本地 Comments 记录 `Risk acceptance: <宿主返回的 dispatchId>`；验收、安全、完整性、P0/P1 和失败检查不豁免。

### 3. 父会话收尾

核对结构化终态、TDD 证据、实际 diff、候选快照和验收条款；`verified` 还要有宿主 `verification.ok=true`，`reviewed` 要有该候选的两轴 PASS（或合格的用户风险接受）。`reviewPending`、单一 writer COMPLETE、过期 Pack 都不能交付。运行项目要求且尚未覆盖的相关验证；单票完整测试套件由父会话运行，批次按 [matt-implement-spec](../matt-implement-spec/SKILL.md) 去重。失败保留未提交候选。已验候选不得再改代码、测试或配置；不为同一个候选追加 standalone review，用户需要深审时可显式调用 `matt-code-review`。

只有该票适用的门禁全部通过，父会话才可以提交：

1. 再次读取 `git status` 和 diff，确认待提交范围只包含当前 ticket/slice 的实现、测试与已批准共享文件改动，不包含 tracker、用户既有改动和生成物。
2. Local Markdown ticket 此时保持未完成。不得在 implement 中把 parent spec 改为 `shipped` 或移动目录；用户必须在之后的独立步骤显式运行 `matt-archive`。
3. 仅暂存精确允许范围内的实现、测试和必要业务文件；禁止暂存 `.x-matt/work/`，业务项目还禁止整个 `.x-matt/` 与个人 `.pi/`，源码维护例外须已核验。禁止 `git add -f`，唯一例外是源码维护例外下、本次计划内且需分发的 `.x-matt/` 契约文件：逐个路径 `git add -f`，并核对 force-add 集合恰好就是这些路径、完整 staged manifest 只含本次计划内文件；其余情况一律不得强制暂存。不用 `git add .` / `git add -A` 批量夹带文件。检查完整 staged manifest、完整 staged diff 与最终提交信息：除私有路径外，还检查复制进业务文件的 session ID、harness/model/工具说明、AI attribution 或工具生成的 `Co-authored-by`；不误删正常业务术语与人工共同作者，不伪造作者或移除团队要求的身份/签名。使用项目约定的提交格式 `<type>: <中文现在时摘要>`，不引用私有 ticket 路径或自动附加 AI 归因。
4. 创建一个提交到当前 branch；不 push、不创建 PR。remote tracker 仍不关闭或修改，除非用户另行要求。提交失败时 ticket 保持未完成，不写 `resolved` 或完成 comment。
5. 提交成功后先核对真实 commit 的 files、message/trailers 与元信息；若 hook 或其他扩展追加未授权工具归因或改变范围，停止、不 push，报告真实提交，不擅自 amend、关闭 hook 或更改作者身份。核验通过后才在本地把当前 ticket 改为 `Status: resolved`，在 `## Comments` 追加 TDD/验证/review 摘要与 `Implementation commit: <完整 commit SHA>`，重新读取核验；这是 blocking graph 的完成标记，不加入任何提交。若本地写回失败，保留代码提交并报告“代码已提交、tracker 待修复”，停止，不重复实现或重复提交。
6. 核对 commit、父 fixed point、changed files、测试命令、Local Markdown 状态、本地忽略规则和工作区状态。

若 review finding 需要修复，先报告并核对已有范围/写入授权；同范围持续修复不重复授权，不让 reviewer 自己修复或悄悄扩大 ticket。

## 完成标准

实现只有同时满足以下条件才算完成：

- 一个且仅一个 ticket 或未发布的当前会话 slice 已实现；
- 所有批准行为均有公开测试切入点上的 TDD RED→GREEN 证据；
- 相关验收、typecheck（若有）和本票所需验证通过；
- 本候选通过已批准的交付门禁，宿主检查（若声明）通过，无有效遗漏、失败或过期证据；
- 当前 branch 产生一个可核验提交；
- Local Markdown ticket 在代码提交成功后仅于本地变为 `resolved`，完成说明记录可核验的 `Implementation commit`；tracker 未被暂存或提交，remote tracker 未关闭或修改；
- 未推送远端，除非任务明确要求。

完成后报告 commit、实现行为、TDD 证据、验证命令、已运行的评审结果和剩余风险。普通票说明未调用独立 reviewer。独立调用只执行这一票。

唯一批量编排例外：用户显式调用 [matt-implement-spec](../matt-implement-spec/SKILL.md) 时，本 skill 每次仍只执行一个 ticket；完成后交回该 parent，由 `matt-implement-spec` 在同一父会话串行选择下一张。逐票核验已批准的门禁、候选提交和本地状态写回；这不授予独立 implement 自动扩张到下一票的能力。
