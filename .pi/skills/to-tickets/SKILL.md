---
name: to-tickets
description: 将已确认的 spec 或当前讨论拆成带 blocking edges 的 tracer-bullet tickets，并在用户批准后发布到已配置的 issue tracker。
disable-model-invocation: true
metadata:
  pi-scope: parent
  pi-class: interaction
  pi-dispatch: none
  pi-depends-on: ""
  pi-upstream-path: skills/engineering/to-tickets/SKILL.md
  pi-upstream-sha: 6654f6b60cd9d5be8b54c6fafe44346dabeb3b76
---

# To Tickets

本 skill 把已确认的 spec、计划或当前会话拆成 tickets。它只负责切分、展示、取得用户批准和发布，不实现代码，也不启动 subagent。适用于工作需要多个 fresh session；一个 session 能完成的变更应直接进入 implement。

## 前置条件

1. 读取当前会话中的 spec 或用户提供的 spec reference；若是 issue/URL，读取完整正文和评论。
2. 读取相关代码、`CONTEXT-MAP.md`/`CONTEXT.md` 和 ADR，使用项目领域词汇，尊重既有决定。
3. 检查 `docs/agents/issue-tracker.md` 和 triage label 配置。当前项目尚未移植 `setup-matt-pocock-skills`，也没有 tracker 配置时停止并报告“tracker 尚未配置”；不要猜测 GitHub、GitLab 或 local-markdown。
4. 不要把 `to-tickets` 当作 triage：它产生的 tickets 已按 `ready-for-agent` 约定准备好，不需要再次 triage；不要关闭或修改 parent spec issue。

## 切分原则

每张 ticket 必须是一个 tracer bullet：

- 穿过本 slice 需要的全部层次，形成一条窄但完整的用户可观察路径；不要按 schema/API/UI/tests 等水平分层。
- 完成后可以独立 demo 或验证；验收标准必须能在 ticket 开始的基线提交上失败，并在完成后观察为真。
- 能由一个 fresh context 完成。超出单 session 容量时继续拆分，但不要牺牲端到端完整性。
- 标题和正文使用领域 glossary，不写具体文件路径、行号或容易过时的代码片段。
- 先识别“make the change easy”的 prefactoring，把必要的 prefactor ticket 放在功能 ticket 前。

### Wide refactor 例外

如果是一个 blast radius 很大的机械重构，无法让任何垂直 slice 单独保持绿色，使用 expand–contract：

1. Expand：新旧形式并存，保持现有行为。
2. Migrate：按包或目录批次迁移调用点，每批独立验证并 blocked by expand。
3. Contract：确认没有旧调用者后删除旧形式，blocked by 所有 migrate tickets。
4. 如果迁移批次也无法独立保持绿色，明确建立 integration-and-verify ticket，并让它 blocked by 所有批次。

## Blocking edges

为每张 ticket 列出真正阻止它开始的 tickets，不要把“相关”或“可能更方便”当成 blocker。无 blocker 的 ticket 可以立即开始；发布顺序按 blockers-first，保证依赖已有 tracker identifier 后再建立 native blocking links。tracker 不支持 native edges 时，在 ticket body 的 `Blocked by` 中保留引用。

## User quiz

在任何发布前，展示编号列表。每张 ticket 必须包含：

- **Title**：短且描述行为的标题
- **Blocked by**：真实前置 tickets，或 None
- **What it delivers**：完成后可 demo/验证的端到端行为
- **Acceptance criteria**：可观察、可失败、只覆盖本 ticket 拥有的行为

随后使用 `ask_user_question` 逐轮确认：粒度是否过粗/过细、blocking edges 是否真实、哪些 ticket 应合并或继续拆分。用户未批准前不得创建本地文件、issue 或 native relationship。用户要求调整时重算编号、依赖和 frontier，再次展示。

## 发布

1. 用户批准 breakdown 后，先发布无 blocker 的 tickets，再按依赖顺序发布后续 tickets。
2. local-markdown tracker：按 blockers-first 写入 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`，每张 ticket 一个文件，`NN` 从 `01` 开始；每个文件标记 `Status: ready-for-agent`，并写明 acceptance criteria 和 Blocked by。
3. real tracker：按配置执行 issue 创建，使用 `ready-for-agent` label；优先使用 tracker 原生 blocking/sub-issue relationship，不可用时将 blocking references 写入 body。父 spec 只作为 parent reference，不关闭、不修改。
4. 每次创建后读取或查询结果，核对标题、正文、label、identifier 和 blocking edge。任何发布结果无法核验时停止并报告，不继续批量创建。
5. 发布完成后报告 ticket 数量、frontier、blocking graph 和下一步 `implement`；`implement` 已移植，每次只处理一个 ticket，并在 TDD、完整验证和双轴 code-review 通过后提交当前 branch。不要在 `to-tickets` 中自行实施或批量处理 tickets。

## Ticket 模板

```markdown
# <NN>: <Ticket title>

**Parent:** <父 spec 的本地路径/identifier，或 None>

**What to build:** <从用户角度描述端到端行为>

**Blocked by:** <编号/标题，或 None (can start immediately)>

**Status:** ready-for-agent

- [ ] <可观察且可失败的验收标准>
- [ ] <可观察且可失败的验收标准>
```

## Real tracker issue template

```markdown
## Parent

<reference to the parent spec issue, when one exists>

## What to build

<从用户角度描述端到端行为>

## Acceptance criteria

- [ ] <可观察且可失败的验收标准>
- [ ] <可观察且可失败的验收标准>

## Blocked by

- <每个 blocking ticket 的 tracker reference，或 None (can start immediately)>
```

real tracker ticket 应使用 `ready-for-agent` label，并优先通过 tracker 原生 relationship 写入 parent/sub-issue 和 blocking edges；正文中的 Parent 与 Blocked by 是可核验的备用记录。

