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
  pi-upstream-sha: abeeaf95660ba9e8b7c753eb38f441ca707a8823
---

# Grill With Docs

本 skill 在当前父会话中执行，结合 [matt-grilling](../matt-grilling/SKILL.md) 与 [matt-domain-modeling](../matt-domain-modeling/SKILL.md)，适用于单会话内澄清代码库需求。路线仍模糊的跨会话大项目可转 `matt-wayfinder`。

## 流程

1. **初始化**：读取相关代码、项目说明、`.x-matt/context/` 与 `.x-matt/adr/`，区分已有事实、既有决定与待决问题，建立 decision tree。
2. **分轮澄清**：
   - 本地事实直接用只读工具核验；外部事实调用 `matt-research`。
   - 按 `matt-grilling` 每轮询问 1–4 个 frontier 决定并附推荐项。
   - 按 `matt-domain-modeling` 及时更新本地 `.x-matt/context/GLOSSARY.md`（新术语）与 `.x-matt/adr/`（通过三项 ADR gate 且经用户同意的难逆转决定）。遵循[隐私契约](../matt-setup/privacy.md)，业务项目领域文档仅保留在本机 `.x-matt/`。
3. **理解确认与平滑衔接**：
   - Frontier 清空后，呈现清晰的理解摘要（目标、范围、非目标、公开行为、已落盘术语/ADR 与保留约束）。
   - 用一次 `ask_user_question` 请用户确认并选择下一步：
     - **直接开始实现（单 slice）**：范围清晰且单会话可完成时，用户确认后直接进入 `matt-implement`；
     - **沉淀为 spec 并拆票**：多流程、迁移、跨会话或依赖大段参考输入时默认推荐，用户确认后直接进入 `matt-to-spec`；
     - **继续澄清 / 暂停**：按用户选择处理。
