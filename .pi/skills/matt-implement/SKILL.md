---
name: matt-implement
description: 根据已确认的 ticket 或当前会话单 slice 计划实现一个工作切片，执行带双轴复核的 TDD、父会话验证，并提交当前分支。
disable-model-invocation: true
metadata:
  pi-scope: parent
  pi-class: interaction
  pi-dispatch: none
  pi-depends-on: matt-domain-modeling
  pi-upstream-path: skills/engineering/implement/SKILL.md
  pi-upstream-sha: a496f5513d4a4cf889bc48e189e579f4b0bdf6aa
---

# Implement

本 skill 把已经决定的一个工作切片变成当前分支上的提交。它不重新 grill，不改变计划/ticket 的目标，不批量处理多个 tickets，也不平行写共享工作区。每次 invocation 只处理一个 ticket；没有已发布 ticket 时，只接受用户在先前 transition handoff 中明确选择“直接实现”、可在一个 session 完成且尚未发布为 `Type: spec`/`Status: spec-ready` 的单 slice 计划。缺少 ticket 本身不构成 direct-slice 授权。`spec-ready` parent spec 必须先进入 `matt-to-tickets`，不能直接实现。

先应用[业务项目隐私契约](../matt-setup/privacy.md)：业务项目整个 `.x-matt/` 与个人 `.pi/` 都是私有资料，不只是 tracker；不向团队 AGENTS/README、代码注释或提交信息写入工具使用标记。真实插件源码仓库按契约保留分发资源例外，不把源码整体忽略。将本次私有路径和已核验例外交给 worker/reviewer。

## 开始前

1. 确认当前 branch 是用户希望写入的 branch；读取 `git status`、`git log` 和当前 fixed point。不要改写或归因用户既有工作区改动。
2. 用户以编号、URL 或路径传入 ticket reference 时，先按 `.x-matt/agents/issue-tracker.md` 的 tracker 契约取回并陈述其标题；同一 reference 对应多个候选、无匹配或与用户描述不符时，用 `ask_user_question` 澄清后再继续。必须获得完整 ticket/当前已确认计划和 parent spec 中相关 acceptance、decision、out-of-scope；内容已在会话中且来源/基线可核验时不重复读取。提取本次适用的 AGENTS/README 条款与领域词汇；相关源码、测试和一层直接调用者列入精确 manifest。架构全文、全部 ADR 和整个模块调用者仅按需读取，不把所有材料全文下发。
3. 对 ticket 核对 title、type、parent、status、blocked-by、acceptance criteria 和 scope。Local Markdown 只接受 `Type: ticket` 且 `Status: ready-for-agent` 的入口；ticket 路径、Parent 或任何待读取 blocker 一旦位于 `.x-matt/work/shipped/`，立即 fail closed，提示该 ticket 已随 spec 归档，不能实现、重新开启或借 archived blocker 解锁 active ticket。默认不得枚举 shipped 内容；用户同一会话点名授权也仅允许历史只读，不构成实现授权。`Parent: None` 只表示没有 parent spec 的当前会话单 slice，其他 Parent 值必须作为 ticket 中声明的仓库相对路径读取，并核对目标是 active `Type: spec`、`Status: spec-ready`。如果目标项目提供 `scripts/check-local-ticket.mjs`，它只做 Parent 字段存在性与 shipped 非入口 preflight，不能替代该 relationship 核验；没有该脚本时直接执行本段的人工读取核验。逐个读取 `Blocked by` 引用，只有 blocker 同时为 `Type: ticket` 且 `Status: resolved` 才算完成。只实现一个 ticket；parent/blocker 未完成、ticket reference 无法核验或输入互相矛盾时停止。没有 ticket 时，必须在当前会话中找到 grilling/diagnosis 等上游流程留下的明确 direct-slice handoff 和用户授权；greenfield、多业务流程、多个独立 seam、部署或迁移工作，以及依赖用户提供且不能安全压缩的事实、说明、样例或约束的工作，不得作为无 ticket 单 slice 开始。材料类型不限于技术 contract。
   Local Markdown tracker 只在本机维护：按 `.x-matt/agents/issue-tracker.md` 核验当前 feature 受本地 Git exclude 保护且未被跟踪，否则停止并提示先修复配置。按精确路径直接读取 ignored ticket/parent/blocker，不依赖 Git-aware 搜索或 `git show`；在 Context Pack 中提供内容与 hash，不能因它们不在 Git diff 中就判为缺失。对每个 resolved blocker 还须读取 Comments 的完整 `Implementation commit`，核验 commit 存在且 `git merge-base --is-ancestor <SHA> HEAD` 成功；记录缺失或仅在其他 branch 上存在时停止，不能用本地残留状态解锁。metadata checker 不能替代此核验。
4. 从 ticket 或当前会话单 slice 计划中提取候选 seams，并先做测试价值判断。显式 acceptance criterion、缺陷回归、业务规则、分支/状态转换、权限/数据完整性和公开 contract 必须有测试；不要仅因代码行数少而跳过。纯机械且已被现有行为测试覆盖的映射、无分支且无业务语义并可由编译/typecheck/现有 contract test 直接保障的低风险简单变更、框架自身行为、不可达或规格明确排除的假设性边缘情况，不必新增独立测试方法；多个紧密相关的简单字段优先由一个行为级测试覆盖，而不是一字段一测试。参数化案例按独立行为、字段映射和共享校验等价类选取：同一等价类保留一个代表输入即可，不默认生成字段×状态×错误值的全排列；只有当某个组合本身产生不同的可观察行为、状态转换或安全/数据完整性风险时才单独保留。不为压缩数量而合并独立行为，也不规定测试案例数上限。把保留的测试行为、代表输入、预计展开次数和省略项的理由都写入 TDD task。若没有可执行的公开 seam、行为或聚焦测试命令，停止并报告缺口；不要在 implement 中重新设计。
5. 按 [Context Pack 契约](../matt-tdd/context-packs.md) 生成明确的 Implementation Context Pack：ticket 内容/准确摘要、parent/blocker 核验、acceptance matrix、known code map、expected change points、fixed point、文件 hash、精确 manifest（关系与必须/按需读取）、允许修改范围、定向搜索的一层边界和停止条件。验证命令分为 RED/GREEN、worker 相关回归、parent-only final validation；完整测试套件与全量 typecheck/build 仅由父会话保留和执行，不得把父会话最终验证命令作为 worker 执行项下发。
6. 完整读取并应用 [domain-modeling](../matt-domain-modeling/SKILL.md) 的写入边界。worker 若在实现中发现值得持久化的新术语或 ADR 级决定，必须通过 `contact_supervisor` 报告而不是写领域文档；当前 TDD run 随即停止为 `BLOCKED`。run 退出后由父会话按 domain-modeling gate 取得用户决定并仅写本地资料，再以新基线重新调度，确保父会话与 worker 不并行写同一工作区；源码维护例外遵循已声明边界。

## 执行顺序

### 1. TDD

调用 `pi_matt_dispatch`：

- `workflow`: `matt-tdd`
- `implementation`：按 [Dispatch Lifecycle](../matt-tdd/dispatch-contract.md) 提供当前 ticket/direct-slice、稳定 scope、精确 allowedFiles 与获批的本地 diagnosticCommands。修复与送审期间复用同一范围；保存每次返回的宿主 `dispatchId`。
- `task`: 只包含三条 lane 都可安全读取的共享事实：单 ticket/当前会话 slice 的目标、验收行为、已确认 seams、fixed point、既有工作区改动、允许范围、`reviewKind=worktree`、标准文件、当前 ticket/parent spec、reviewer 初始证据边界、module/package 搜索边界和停止条件。不得放入 report-only、旧 transcript、禁止 diff、`status COMPLETE` 等 implement 专属指令。
- `laneTasks`: 必须同时提供 `implement`、`standards`、`spec` 三项完整替换。`implement` 接收 Implementation Context Pack、RED/GREEN 与相关回归命令，明确不执行父会话最终验证；`standards` 接收适用工程规范摘录和安全/正确性边界；`spec` 接收 ticket acceptance matrix 与 parent spec 相关条款。两条 reviewer lane 先消费 workflow 独立采集的 Review Evidence Pack（完整 combined diff、新文件全文/hash、deleted/rename old/new），不再逐文件重复取证，不返回 implement schema，也不以旧 worker transcript 代替 diff。默认只读 manifest；仅在具体证据不足时定向补读一层直接依赖。

`pi_matt_dispatch` 只在无法确认本次实现由你显式发起时才要求运行时确认：本 session 用 `/skill:matt-implement` 显式启动时直接放行一次，并绑定具体范围；运行时确认也保存为同一限定授权。后续同范围修复及 reload 从宿主当前 session branch 的可信记录恢复，不重复入口确认，不相信模型提供的“已授权”文字。新 ticket、范围扩张、架构选择或破坏性操作仍需新决定。取消、授权过期、无可靠记录且无 UI 的 print/JSON mode 或未响应授权时都必须 fail closed，不能改用其他调度入口绕过。

只有 TDD 返回完整 `COMPLETE`，且每个批准 slice 都有真实 RED、GREEN、changed files 和 commands 证据时才继续。TDD 内置的 fresh Standards/Spec lanes 是本次实现默认且唯一的一轮独立 code review；lane task 应明确：只有存在有证据的验收遗漏、标准/正确性/安全/数据完整性问题或缺少必需测试时返回 `FAIL`，非阻断的可维护性建议写入 notes 并保持 `PASS`。TDD reviewer 失败、缺少结构化结果或 gate 未满足时停止，不自行补实现。若阻塞原因是缺少 Git baseline、spec、ticket、acceptance criteria 或其他规划 artifact，禁止父会话直接创建或改写 `.x-matt/work/` 来解阻；应停止并提示用户显式进入 `matt-to-spec`、`matt-to-tickets` 或修正已有 artifact。

两个 reviewer 都完成后，先合并报告同一轮全部 findings，按共享根因归组但保留 Standards/Spec 各自结论。reviewer 须完成限定范围检查，一次报告全部有证据的阻断项，不因首个 finding 提前结束。在已批准的连续修复范围内，不再次询问同一范围；只有新增范围或实质决定时才请求一次用户决定，不逐条或逐 lane 询问。

聚焦 `matt-tdd` 必须提供结构化 `repair`：引用最近宿主 dispatchId、全部获批 finding IDs，并说明不变量、校验/归一化顺序、共享调用路径、必要正反例与回归。**repair 只运行 writer 与证据采集，不自动启动双轴。** 宿主 resume 最近的可恢复 writer，保留原模型、工具与上下文；不可恢复则停止，不暗中换 fresh writer。writer 只处理获批 findings，并运行 RED/GREEN 与相关回归，不把父会话最终验证移交给 worker。

修复返回后，父会话核对实际 diff、逐项 findings 和验证证据：仍有同范围且证据支持的修复时，引用最新 dispatchId 继续 `repair`；缺少依据或实质决定时停止。原 findings 与根因计数跨修复保留，不通过拆轮绕过诊断。候选代码已准备好时才发送 `review: {dispatchId: "<最新已完成 repair>"}`，仍提供完整三项 laneTasks；它只启动 fresh Standards/Spec，不重跑 writer 或重复采集证据。修复的 `state=complete`、`implement.status=COMPLETE` 或 `reviewPending=true` 都不代表交付通过。

正式复审检查自最近一次正式评审以来的**累计修复增量**、原 findings 及必要的一层直接依赖，不只检查最后一次补丁；不得重新扫描或重新裁决已经 PASS 且未变化、无依赖影响的其他文件，真实新安全/完整性问题除外。该次双轴 `PASS` 取代此前失败结果，不再追加 standalone code review。

同一根因两次修复仍失败，第三次 writer 前由 dispatcher 强制 `DIAGNOSIS_REQUIRED`；相关修复回归立即触发。按 [Dispatch Lifecycle](../matt-tdd/dispatch-contract.md) 在当前 ticket 内做受限诊断，提交真实 repro 与根因契约后再继续；不是取消 review、限制必要测试数或重新设计模块。执行失败/结果缺失不计作根因修复轮次，使用有界 reviewer `recovery`，不得重做已完成实现。

TDD worker 是唯一写者。implement 父会话不直接与 worker 并行写入，也不允许另一个 worker 同时处理同一工作区。

### 2. 持续验证

TDD 期间由 worker 按 slice 运行最小单测，并在全部 slices 完成后运行一次相关回归命令；只有明确属于当前 slice 的聚焦 typecheck 才交给 worker。TDD 完成后，父会话再运行必要的 ticket 相关复核、typecheck（若有）和一次完整测试套件。完整测试套件不得消耗 TDD worker 的 workflow runtime。任何失败都保持未提交状态，报告命令、失败证据和阻塞原因。

### 3. 复用 TDD 双轴复核

提交前默认复用最后一次成功 `matt-tdd` 中 fresh Standards/Spec reviewer 的结构化 `PASS`，不要再调用 `matt-code-review` 重复评审同一 worktree。父会话必须核对该结果对应当前 fixed point 和 changed files，且 TDD 完成后除测试生成物清理、Local Markdown ticket 状态与完成说明外，没有代码、测试、配置、迁移或业务文档变化。

只有以下任一条件成立时才额外调用 `matt-code-review`：

- 用户明确要求 standalone code review；
- TDD 的任一 reviewer 结果缺失、schema 无效或无法对应当前工作区；
- TDD 结束后代码、测试、配置、迁移或业务文档又发生变化；
- 当前实现不是由包含 fresh Standards/Spec lanes 的 `matt-tdd` 产生。

`repair` 有意暂缓 reviewer 不属于“结果缺失”，必须使用上面的 `review` 完成送审，不能因此追加 standalone review 或沿用修复前的 PASS。

额外 review 若确有必要，使用 `workflow`: `matt-code-review`，提供当前 Review Evidence Pack 或精确取证范围：`reviewKind`、fixed point、完整 changed-file manifest、完整 combined diff/新文件内容与 hash、lane-specific ticket/spec/标准条款及一层搜索边界。任一轴失败时合并报告全部 findings；已有连续修复授权覆盖时不重新确认，只有新增范围/决定时取得一次授权。不得让 reviewer 修复，也不得逐 finding 启动完整工作区复审。

### 4. 提交

只有 TDD、完整验证和最终双轴复核全部通过后，父会话才可以提交：

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
- 所有批准行为均有公开 seam 上的 TDD RED→GREEN 证据；
- 相关测试、typecheck（若有）和完整测试套件通过；
- 最后一次成功 `matt-tdd` 内置的 Standards 与 Spec review 均为 `PASS`，或满足额外 review 条件时 standalone review 也通过；
- 当前 branch 产生一个可核验提交；
- Local Markdown ticket 在代码提交成功后仅于本地变为 `resolved`，完成说明记录可核验的 `Implementation commit`；tracker 未被暂存或提交，remote tracker 未关闭或修改；
- 未推送远端，除非任务明确要求。

完成后报告 commit、实现行为、TDD 证据摘要、review verdict、验证命令和 residual risks。独立调用时，下一个 ticket 必须在新的 implement session 中处理；不要在当前会话继续批量实现。

唯一批量编排例外：用户显式调用 [matt-implement-spec](../matt-implement-spec/SKILL.md) 时，本 skill 每次仍只执行一个 ticket；完成后交回该 parent，由 `matt-implement-spec` 在同一父会话串行选择下一张。每票重新核验 handoff、seams、范围与宿主授权，单写者、逐票完整验证、双轴 PASS 和提交/本地状态写回条件不变；这不授予独立 implement 自动扩张到下一票的能力。
