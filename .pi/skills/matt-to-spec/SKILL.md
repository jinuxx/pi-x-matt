---
name: matt-to-spec
description: 将当前已完成的设计讨论综合为 parent spec，并按 tracker 配置发布为本地 spec-ready 文档或受保护的 remote issue。
disable-model-invocation: true
metadata:
  pi-scope: parent
  pi-class: interaction
  pi-dispatch: none
  pi-depends-on: ""
  pi-upstream-path: skills/engineering/to-spec/SKILL.md
  pi-upstream-sha: 3cca18b368ae95cdbdebbff572ccafa662551015
---

# To Spec

本 skill 只综合当前父会话中已经讨论和确认的内容，不重新 interview，不替用户补做产品或架构决定。是否需要 spec 必须在进入本 skill 前由用户通过 transition handoff 决定；一旦显式调用，本 skill 必须完成 seam 确认与发布 gate，不得因 agent 判断“一个 session 能完成”而静默跳过到 implement。

## 前置条件

1. 读取当前会话、相关代码、项目说明、`.x-matt/context/`、`.x-matt/adr/`，以及用户明确提供或项目内已持久化的 research note。research completion result 只在原会话中可用；跨 session 时没有可核验 note 就不得把记忆或摘要冒充研究证据。
2. 用户提供 Wayfinder map 时，只接受可核验的准确 reference。要求 `Type: wayfinder-map`、`Status: cleared`、`Not yet specified` 无范围内 fog、没有 open/claimed child；先读取 map 的 `Decisions so far` 标题链接，再按需读取每个 linked resolved ticket 的唯一 Answer。broken link、重复答案、out-of-scope 被列为决定或 active map 都必须停止，不能用会话记忆补洞。
3. 使用项目领域词汇，尊重已接受的 ADR。若用户陈述与代码或文档冲突，停止并报告冲突，不静默选择一方。
4. 检查 `.x-matt/agents/issue-tracker.md` 和 `.x-matt/agents/triage-labels.md`。任一文件缺失、tracker 前置条件无法核验或 label mapping 不含 `ready-for-agent` 时，停止并报告“tracker 尚未配置”；建议用户先运行已移植的 `matt-setup`，不要自行猜测 GitHub、GitLab 或 local-markdown。
5. `matt-to-spec` 不负责搜索重复 issue、创建 tracker 配置、拆 tickets、实现代码或启动 subagent。
6. Local Markdown 发布前读取非空 `PI_SESSION_ID`，用于写入 `Source session: pi:<PI_SESSION_ID>`。缺少 session identity 时停止发布，不使用模型名、时间戳或工作区路径代替。

## Seam gate

写 spec 前先从讨论和代码中勾勒测试 seam：

- 优先使用现有 seam；只有没有合适 seam 时才提议新 seam。
- 取能观察完整用户行为的最高公开 interface；不要把实现细节、内部 helper 或数据库字段当成测试面。
- 尽量使用一个 seam；多个 seam 必须分别说明它们覆盖的独立行为。
- 对每个 seam 写出 interface、可观察行为、输入约束和错误/边界结果。

使用 `ask_user_question` 请求用户确认这些 seams 是否符合预期。问题只针对 seam，不借机开启新的需求访谈。用户拒绝或修改 seam 时，更新 seam 记录并再次确认；未确认前不得写入或发布 spec。

## 综合规则

1. 从当前会话提取已确认的目标、用户故事、实现决定、测试决定、非目标和进一步注意事项。
2. 区分来源：用户决定、Wayfinder resolved ticket、代码库事实、ADR 约束、研究证据和 agent 建议。前五类中只有已确认且可追溯的内容可以进入 spec；未被确认的建议放入待决事项并停止，不把它伪装成决定。
3. 不把 glossary 变成 spec：`.x-matt/context/` 下对应的 `CONTEXT.md` 提供术语，spec 保存本次工作的行为和决定。
4. 对已确认范围内的用户可观察行为，尽可能穷举为 numbered user stories；不要为了“完整”发明用户未确认的需求。架构或重构工作可以减少 user stories，但必须把重点和理由放入 implementation/testing decisions。
5. 规格应覆盖已确认的公开行为和拒绝的范围；不要加入当前讨论没有依据的兼容性、性能、错误处理或未来扩展承诺。
6. 用户提供且后续实现、验证或运维需要依赖的事实、说明性内容、样例和约束，如果压缩改写会损失语义或可追溯性，必须在 `Reference Inputs` 中忠实落盘并标注来源为用户输入；这可以包括业务规则、现状说明、操作步骤、边界解释、样例数据/交互，以及查询、API、schema、配置等技术材料，不以特定项目或材料类型为限。先移除密码、token、cookie、真实私钥及其他 secrets；被脱敏的字段使用明确占位符，不能静默省略整段输入，也不能只改写成 agent 的行为摘要。

## Spec 内容

生成以下 Markdown 内容：

```markdown
## Problem Statement

<从用户视角描述问题>

## Solution

<从用户视角描述已确认的解决方案>

## User Stories

1. As an <actor>, I want a <feature>, so that <benefit>

## Implementation Decisions

- <模块、公开 interface、架构决定、schema/API contract 或具体交互>

## Testing Decisions

- <只验证外部行为，不验证实现细节>
- <要测试的模块和 seam>
- <代码库中的相关测试先例>

## Out of Scope

- <明确拒绝或延后的范围>

## Further Notes

- <约束、来源、风险或后续注意事项>

## Reference Inputs

<用户提供且需要忠实保留的事实、说明、样例、约束或技术材料；标注来源并脱敏 secrets，没有时写 None>
```

不要在内容中写具体文件路径或普通实现代码片段。例外是原型中的状态机、reducer、schema 或类型形状本身就是已确认决定，以及 `Reference Inputs` 中为保持语义与可追溯性而必须忠实保留的用户材料；这些只保留后续工作所需部分并先脱敏 secrets。

## 发布 gate

1. 先在父会话中展示生成的 spec 摘要，尤其是 seams 和 Out of Scope，确认内容忠实于本次讨论。
2. 用户确认后，按 `.x-matt/agents/issue-tracker.md` 发布一个 parent spec。Local Markdown 必须写 `Type: spec`、`Status: spec-ready` 与 `Source session: pi:<PI_SESSION_ID>`，该状态只允许进入 `matt-to-tickets`；remote tracker 才使用项目配置中的 `ready-for-agent` label，且外部 runner 必须显式排除 parent spec，无法确认时停止发布。
3. 发布后核对 issue URL/本地 spec 路径、标题、正文、`Reference Inputs`，以及配置要求的 Type/Status/Source session 或 label，确认只有一个 parent spec 被创建。
4. 没有 tracker、label 配置、用户确认或可核验发布结果时，保持未发布状态并明确报告原因。

发布完成后建议进入 `matt-to-tickets`。当前 `matt-to-tickets` 已移植；下一阶段是 `matt-implement`，它每次只处理一个已确认 ticket，依次执行 TDD、验证、双轴 code-review，并在通过后提交当前 branch。不要在本 skill 中自行拆 ticket 或实现。
