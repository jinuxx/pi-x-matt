---
name: implement
description: 根据已确认的 ticket 或当前会话单 slice 计划实现一个工作切片，依次执行 TDD、验证、独立 code review，并提交当前分支。
disable-model-invocation: true
metadata:
  pi-scope: parent
  pi-class: interaction
  pi-dispatch: none
  pi-depends-on: domain-modeling
  pi-upstream-path: skills/engineering/implement/SKILL.md
  pi-upstream-sha: 6654f6b60cd9d5be8b54c6fafe44346dabeb3b76
---

# Implement

本 skill 把已经决定的一个工作切片变成当前分支上的提交。它不重新 grill，不改变计划/ticket 的目标，不批量处理多个 tickets，也不平行写共享工作区。每次 invocation 只处理一个 ticket；没有已发布 ticket 时，只接受当前会话已确认、可在一个 session 完成且尚未发布为 `Type: spec`/`Status: spec-ready` 的单 slice 计划。`spec-ready` parent spec 必须先进入 `to-tickets`，不能直接实现。

## 开始前

1. 确认当前 branch 是用户希望写入的 branch；读取 `git status`、`git log` 和当前 fixed point。不要改写或归因用户既有工作区改动。
2. 读取完整 ticket/spec/当前已确认计划、相关 `CONTEXT-MAP.md`/`CONTEXT.md`、ADR、项目说明和直接调用者。使用已确认的领域词汇。
3. 对 ticket 核对 title、type、parent、status、blocked-by、acceptance criteria 和 scope。Local Markdown 只接受 `Type: ticket` 且 `Status: ready-for-agent` 的入口；`Parent: None` 只表示没有 parent spec 的当前会话单 slice，其他 Parent 值必须作为 ticket 中声明的仓库相对路径读取，并核对目标是 `Type: spec`、`Status: spec-ready`。`scripts/check-local-ticket.mjs` 只做 Parent 字段存在性 preflight，不能替代该 relationship 核验。逐个读取 `Blocked by` 引用，只有 blocker 同时为 `Type: ticket` 且 `Status: resolved` 才算完成。只实现一个 ticket；parent/blocker 未完成、ticket reference 无法核验或输入互相矛盾时停止。
4. 从 ticket 或当前会话单 slice 计划中提取已批准 seams。若没有可执行的 seam、行为或测试命令，停止并报告缺口；不要在 implement 中重新设计。将 seam 交给 `tdd`，由其执行公开 seam 确认 gate。
5. 固定实现前基线和调度前工作区状态，并明确允许修改的范围、测试命令、typecheck 命令（若项目提供）和停止条件。
6. 完整读取并应用 [domain-modeling](../domain-modeling/SKILL.md) 的写入边界。worker 若在实现中发现值得持久化的新术语或 ADR 级决定，必须通过 `contact_supervisor` 报告而不是写共享文档；当前 TDD run 随即停止为 `BLOCKED`。run 退出后由父会话按 domain-modeling gate 取得用户决定并写入，再以新基线重新调度，确保父会话与 worker 不并行写同一工作区。

## 执行顺序

### 1. TDD

调用 `pi_matt_dispatch`：

- `workflow`: `tdd`
- `task`: 包含单 ticket/当前会话 slice 的目标、验收行为、已确认 seams、fixed point、既有工作区改动、允许范围、测试/typecheck 命令、相关标准和停止条件。

只有 TDD 返回完整 `COMPLETE`，且每个批准 slice 都有真实 RED、GREEN、changed files 和 commands 证据时才继续。TDD reviewer 失败、缺少结构化结果或 gate 未满足时停止，不自行补实现。

TDD worker 是唯一写者。implement 父会话不直接与 worker 并行写入，也不允许另一个 worker 同时处理同一工作区。

### 2. 持续验证

TDD 期间按 slice 运行最小单测；有 typecheck 时定期运行。TDD 完成后运行 ticket 相关测试、typecheck（若有）和一次完整测试套件。任何失败都保持未提交状态，报告命令、失败证据和阻塞原因。

### 3. 独立 code review

在提交前调用 `pi_matt_dispatch`：

- `workflow`: `code-review`
- `task`: 包含固定基线、从 fixed point 到当前工作树的真实 diff、ticket/当前会话 slice、仓库标准、已批准 seams、测试命令和停止条件。

明确告诉 reviewer 读取 worktree diff；不要把普通 prose 或 worker 自评当成 review 证据。Standards 与 Spec 两个 lane 都必须返回 `PASS`。任一 lane 失败、缺失或没有结构化结果时停止，不提交，不自动修改 reviewer finding。

### 4. 提交

只有 TDD、完整验证和双轴 code review 全部通过后，父会话才可以提交：

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
- Standards 与 Spec review 均为 `PASS`；
- 当前 branch 产生一个可核验提交；
- Local Markdown ticket 在同一提交中变为 `resolved`；remote tracker 未关闭或修改；
- 未推送远端，除非任务明确要求。

完成后报告 commit、实现行为、TDD 证据摘要、review verdict、验证命令和 residual risks。下一个 ticket 必须在新的 implement session 中处理；不要在当前会话继续批量实现。
