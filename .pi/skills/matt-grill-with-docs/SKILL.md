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
  pi-upstream-sha: 3cca18b368ae95cdbdebbff572ccafa662551015
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

结束时报告实际修改的文档，然后执行显式 transition handoff：使用 `ask_user_question` 让用户选择“发布 spec 并继续拆 tickets”“直接实现一个单 slice”或“暂停”。本 skill 只记录选择并结束，不得在同一 invocation 中加载下一阶段、确认测试 seam、调用 `matt-tdd`、生成 spec/tickets 或写生产实现。

只有目标与公开行为都已确认、只包含一个可独立验证的 vertical slice、实现所依赖的事实与约束已经可追溯、且预计当前 session 可以完成时，才提供“直接实现”选项。greenfield 项目、多个业务流程、多个独立测试 seam、用户提供了不能安全压缩而不损失实现语义的事实/说明/样例/约束、需要部署或迁移、或明显需要跨 session 的工作，默认推荐“发布 spec 并继续拆 tickets”。这些用户输入可以是业务规则、操作说明、现状描述、数据或交互样例、查询/API/schema/config 等技术材料，不以特定项目或材料类型为限。用户选择后分别提示下一条显式命令 `/skill:matt-to-spec` 或 `/skill:matt-implement`，并立即结束当前回合；不得代替用户执行命令。

除 glossary 与经同意的 ADR 外，其余决定保留在会话上下文，供后续 `matt-to-spec` 或 `matt-implement` 消费。
