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
  pi-upstream-sha: 3cca18b368ae95cdbdebbff572ccafa662551015
---

# Implement

本 skill 把已经决定的一个工作切片变成当前分支上的提交。它不重新 grill，不改变计划/ticket 的目标，不批量处理多个 tickets，也不平行写共享工作区。每次 invocation 只处理一个 ticket；没有已发布 ticket 时，只接受用户在先前 transition handoff 中明确选择“直接实现”、可在一个 session 完成且尚未发布为 `Type: spec`/`Status: spec-ready` 的单 slice 计划。缺少 ticket 本身不构成 direct-slice 授权。`spec-ready` parent spec 必须先进入 `matt-to-tickets`，不能直接实现。

## 开始前

1. 确认当前 branch 是用户希望写入的 branch；读取 `git status`、`git log` 和当前 fixed point。不要改写或归因用户既有工作区改动。
2. 读取完整 ticket/spec/当前已确认计划、`.x-matt/context/`、`.x-matt/adr/`、项目说明和直接调用者。使用已确认的领域词汇。
3. 对 ticket 核对 title、type、parent、status、blocked-by、acceptance criteria 和 scope。Local Markdown 只接受 `Type: ticket` 且 `Status: ready-for-agent` 的入口；`Parent: None` 只表示没有 parent spec 的当前会话单 slice，其他 Parent 值必须作为 ticket 中声明的仓库相对路径读取，并核对目标是 `Type: spec`、`Status: spec-ready`。如果目标项目提供 `scripts/check-local-ticket.mjs`，它只做 Parent 字段存在性 preflight，不能替代该 relationship 核验；没有该脚本时直接执行本段的人工读取核验。逐个读取 `Blocked by` 引用，只有 blocker 同时为 `Type: ticket` 且 `Status: resolved` 才算完成。只实现一个 ticket；parent/blocker 未完成、ticket reference 无法核验或输入互相矛盾时停止。没有 ticket 时，必须在当前会话中找到 grilling/diagnosis 等上游流程留下的明确 direct-slice handoff 和用户授权；greenfield、多业务流程、多个独立 seam、部署或迁移工作，以及依赖用户提供且不能安全压缩的事实、说明、样例或约束的工作，不得作为无 ticket 单 slice 开始。材料类型不限于技术 contract。
4. 从 ticket 或当前会话单 slice 计划中提取候选 seams，并先做测试价值判断。显式 acceptance criterion、缺陷回归、业务规则、分支/状态转换、权限/数据完整性和公开 contract 必须有测试；不要仅因代码行数少而跳过。纯机械且已被现有行为测试覆盖的映射、无分支且无业务语义并可由编译/typecheck/现有 contract test 直接保障的低风险简单变更、框架自身行为、不可达或规格明确排除的假设性边缘情况，不必新增独立测试方法；多个紧密相关的简单字段优先由一个行为级测试覆盖，而不是一字段一测试。把保留的测试行为和省略项的理由都写入 TDD task。若没有可执行的公开 seam、行为或聚焦测试命令，停止并报告缺口；不要在 implement 中重新设计。
5. 固定实现前基线和调度前工作区状态，并把验证命令明确分为三类：每轮 RED/GREEN 使用的最小命令、所有 slices 完成后由 worker 运行的相关回归命令、以及只由父会话运行的最终验证命令（完整测试套件与必要的全量 typecheck/build）。同时明确允许修改的范围和停止条件。不得把父会话最终验证命令作为 worker 执行项下发。
6. 完整读取并应用 [domain-modeling](../matt-domain-modeling/SKILL.md) 的写入边界。worker 若在实现中发现值得持久化的新术语或 ADR 级决定，必须通过 `contact_supervisor` 报告而不是写共享文档；当前 TDD run 随即停止为 `BLOCKED`。run 退出后由父会话按 domain-modeling gate 取得用户决定并写入，再以新基线重新调度，确保父会话与 worker 不并行写同一工作区。

## 执行顺序

### 1. TDD

调用 `pi_matt_dispatch`：

- `workflow`: `matt-tdd`
- `task`: 只包含三条 lane 都可安全读取的共享事实：单 ticket/当前会话 slice 的目标、验收行为、已确认 seams、fixed point、既有工作区改动、允许范围、`reviewKind=worktree`、标准文件、当前 ticket/parent spec、reviewer 初始证据边界、module/package 搜索边界和停止条件。不得放入 report-only、旧 transcript、禁止 diff、`status COMPLETE` 等 implement 专属指令。
- `laneTasks`: 必须同时提供 `implement`、`standards`、`spec` 三项完整任务替换，并在每项复制该 lane 所需的共享事实。`implement` 才包含 RED/GREEN 最小命令、worker 相关回归命令，并明确完整测试套件与最终验证属于父会话、worker 不得运行；`standards` 与 `spec` 只包含各自的当前工作区取证与输出要求，不得要求 reviewer 返回 implement schema 或以旧 worker transcript 代替 diff。reviewer 取证仍须明确：tracked 文件逐文件读取 worktree diff，`??` untracked 文件直接读取，deleted 文件只读 diff，rename 同时核验 old/new 路径。

`pi_matt_dispatch` 只在无法确认本次实现由你显式发起时才要求运行时确认：当你在本 session 用 `/skill:matt-implement` 显式启动时直接放行；模型自行走到 TDD、或本 session 没有该显式调用记录时，会要求你确认当前入口是一个已核验 ticket 或已批准 direct slice。取消、无 UI 的 print/JSON mode 或未响应授权时都必须 fail closed，不能排队 workflow，也不能改用其他调度入口绕过。

只有 TDD 返回完整 `COMPLETE`，且每个批准 slice 都有真实 RED、GREEN、changed files 和 commands 证据时才继续。TDD 内置的 fresh Standards/Spec lanes 是本次实现默认且唯一的一轮独立 code review；lane task 应明确：只有存在有证据的验收遗漏、标准/正确性/安全/数据完整性问题或缺少必需测试时返回 `FAIL`，非阻断的可维护性建议写入 notes 并保持 `PASS`。TDD reviewer 失败、缺少结构化结果或 gate 未满足时停止，不自行补实现。若阻塞原因是缺少 Git baseline、spec、ticket、acceptance criteria 或其他规划 artifact，禁止父会话直接创建或改写 `.x-matt/work/` 来解阻；应停止并提示用户显式进入 `matt-to-spec`、`matt-to-tickets` 或修正已有 artifact。

两个 reviewer 都完成后，先合并报告同一轮全部 findings，再向用户请求一次范围决定，不要逐条或逐 lane 重复询问。用户批准修复时，启动一次聚焦 `matt-tdd`：writer 只处理获批 findings，reviewer 只复核该修复增量、原 finding 及必要的一层直接依赖；不得重新扫描或重新裁决已经 PASS 且未变化的其他文件。该聚焦 workflow 的最终双轴 `PASS` 取代此前失败结果，不再追加 standalone code review。

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

额外 review 若确有必要，使用 `workflow`: `matt-code-review`，task 仍须包含 `reviewKind`、fixed point、具体 changed-file 状态、逐文件证据方式、ticket/spec/标准路径和搜索边界。任一轴失败时合并报告全部 findings，并取得一次新的范围授权；不得让 reviewer 修复，也不得逐 finding 启动完整工作区复审。

### 4. 提交

只有 TDD、完整验证和最终双轴复核全部通过后，父会话才可以提交：

1. 再次读取 `git status` 和 diff，确认只包含当前 ticket、没有用户既有改动和生成物。
2. 当前入口是 Local Markdown ticket 时，把它改为 `Status: resolved`，在 `## Comments` 追加本次 TDD/验证/review 完成说明，并把该 ticket 文件加入允许提交范围；这是 blocking graph 的完成标记，不适用于 parent spec。
3. 暂存允许范围内的实现、测试和 Local Markdown ticket 文件，使用项目约定的提交格式 `<type>: <中文现在时摘要>`。
4. 创建一个提交到当前 branch；不 push、不创建 PR。remote tracker 仍不关闭或修改，除非用户另行要求。提交失败时撤销父会话刚写入的 `resolved` 状态与完成 comment，不把未提交工作标记为完成。
5. 核对 commit、父 fixed point、changed files、测试命令、Local Markdown 状态和工作区状态。

若 review finding 需要修复，先向用户报告并取得新的范围/写入授权；不要在同一 invocation 中让 reviewer 自己修复或悄悄扩大 ticket。

## 完成标准

实现只有同时满足以下条件才算完成：

- 一个且仅一个 ticket 或未发布的当前会话 slice 已实现；
- 所有批准行为均有公开 seam 上的 TDD RED→GREEN 证据；
- 相关测试、typecheck（若有）和完整测试套件通过；
- 最后一次成功 `matt-tdd` 内置的 Standards 与 Spec review 均为 `PASS`，或满足额外 review 条件时 standalone review 也通过；
- 当前 branch 产生一个可核验提交；
- Local Markdown ticket 在同一提交中变为 `resolved`；remote tracker 未关闭或修改；
- 未推送远端，除非任务明确要求。

完成后报告 commit、实现行为、TDD 证据摘要、review verdict、验证命令和 residual risks。下一个 ticket 必须在新的 implement session 中处理；不要在当前会话继续批量实现。
