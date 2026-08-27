---
name: matt-grill-with-docs
description: 在代码库中分轮澄清计划或设计，并在术语与重大决定形成时更新 `.x-matt/context/` 和 `.x-matt/adr/`。
disable-model-invocation: true
metadata:
  pi-scope: parent
  pi-class: interaction
  pi-dispatch: none
  pi-depends-on: matt-grilling, matt-domain-modeling
  pi-upstream-path: skills/engineering/grill-with-docs/SKILL.md
  pi-upstream-sha: 6654f6b60cd9d5be8b54c6fafe44346dabeb3b76
---

# Grill With Docs

本 skill 必须留在当前父会话中执行。开始前完整读取并同时应用 [matt-grilling](../matt-grilling/SKILL.md) 与 [matt-domain-modeling](../matt-domain-modeling/SKILL.md)；缺少任一依赖时停止，不退化为普通问题列表。

适用于可在一个 session 内澄清的代码库变更。目标可以命名、但路线仍有 fog 且明显超过一个 session 的大型工作，应转入已移植的手动 `matt-wayfinder`；决定已经完成的多 session 工作直接进入 `matt-to-spec`，不要为了规模而强行创建 map。

## 初始化

1. 明确本次要澄清的目标，而不是先设计实现。
2. 读取相关代码、项目说明、`.x-matt/context/` 和 `.x-matt/adr/`，区分已有事实、已有决定与新提议。
3. 在当前会话维护以下状态，不另建 scratch 决策文档：
   - 目标、范围和非目标
   - 已核验 facts 及其来源
   - 已确认 decisions
   - 未解决 frontier 与正在调查的前置 facts
   - 本次已写入的 glossary terms 与 ADRs
4. 把初始开放项建成 decision tree，再进入分轮访谈。

## 分轮循环

1. 先处理事实：本地事实由父会话只读核验；外部事实调用 `matt-research` workflow。调查未完成时，只暂停依赖该事实的分支。
2. 按 `matt-grilling` 协议一次询问当前 frontier 的 1–4 个决定，并为每项给出有依据的推荐答案。
3. 用户回答后，明确区分新事实和用户决定。不要把 agent 推荐、现有代码或默认实践改写为用户决定。
4. 按 `matt-domain-modeling` 规则检查每个答案：
   - 新的 canonical term 一旦确定，立即更新 `.x-matt/context/` 下对应的 `CONTEXT.md`。
   - 与 glossary 或代码冲突时，先暴露冲突并留在 frontier。
   - 决定同时通过三项 ADR gate 时，向用户提议；取得同意后立即写入。
5. 更新会话状态和 decision tree，重复直到 frontier 为空。

每次共享文档写入前说明将修改的术语或决定；写后检查 diff。子代理和 reviewer 不得写 `.x-matt/context/` 或 `.x-matt/adr/`。

## Shared-understanding gate

Frontier 为空后，向用户呈现一份可核对的理解摘要：

- 目标、范围、非目标
- 已确认的公开行为和关键决定
- 已核验 facts 与仍存在的未知项
- 本次新增或修改的领域术语
- 本次新增的 ADR
- 进入规格阶段仍需保留的约束

使用 `ask_user_question` 请求用户明确确认 shared understanding。用户选择继续澄清时，把反馈重新加入 decision tree；只有用户确认后才能结束。

结束时报告实际修改的文档，并按工作大小给出下一步：需要跨多个 session 保存和切分的工作进入 `matt-to-spec`；能在当前 session 以一个已确认 slice 完成的小变更直接进入 `matt-implement`。不要在本 skill 中生成 spec、tickets 或生产实现；除 glossary 与经同意的 ADR 外，其余决定保留在会话上下文，供后续 `matt-to-spec` 或 `matt-implement` 消费。
