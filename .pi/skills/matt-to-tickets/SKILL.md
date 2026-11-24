---
name: matt-to-tickets
description: 将已确认的 spec 或当前讨论拆成带 blocking edges 的 tracer-bullet tickets，并在用户批准后发布到已配置的 issue tracker。
disable-model-invocation: true
metadata:
  pi-scope: parent
  pi-class: interaction
  pi-dispatch: none
  pi-depends-on: ""
  pi-upstream-path: skills/engineering/to-tickets/SKILL.md
  pi-upstream-sha: abeeaf95660ba9e8b7c753eb38f441ca707a8823
---

# To Tickets

本 skill 将已确认的 spec 或讨论拆分为垂直切片（tracer-bullet）tickets，经用户确认后发布到已配置的 issue tracker。

## 前置条件

1. 读取目标 active spec（Local Markdown 位于 `.x-matt/work/<feature-slug>/spec.md`，`Type: spec`、`Status: spec-ready`，跳过 `.x-matt/work/shipped/`）、相关代码与领域文档。
2. 检查 `.x-matt/agents/issue-tracker.md` 与 `.x-matt/agents/triage-labels.md`；缺失时提示先运行 `matt-setup`。
3. 应用[业务项目隐私契约](../matt-setup/privacy.md)：业务项目 `.x-matt/` 仅本地保存，不暂存不提交；Local Markdown 读取非空 `PI_SESSION_ID` 写入 `Source session`。

## 切分原则

每张 ticket 应是一个可独立验证的 tracer bullet：

- 穿过所需各层，形成一条窄但完整的用户可观察路径（避免纯水平分层）；验收标准在当前基线可失败、完成后可验证。
- 大小适合单个 `matt-worker` 会话完成；必要的 prefactoring 单独成票放在前置。
- 大范围机械重构无法垂直保持绿色时，使用 expand → migrate → contract 模式。
- 只标注真实阻塞前置的 `Blocked by`（remote tracker 支持 native edges 时正文省略 `## Blocked by`）。

## 确认、发布与衔接

1. 展示编号清单（Title、Blocked by、What it delivers、Acceptance criteria），使用 `ask_user_question` 确认拆分方案，并询问发布后是否直接开始实现（单票 `matt-implement` / 整批串行 `matt-implement-spec` / 先暂停）。
2. 按 blockers-first 顺序发布并读回核验：
   - Local Markdown 写入 `.x-matt/work/<feature-slug>/issues/<NN>-<slug>.md`，模板包含：
     - 头部：`Type: ticket`、`Parent: <spec 路径或 None>`、`Status: ready-for-agent`、`Source session: pi:<PI_SESSION_ID>`、`Blocked by: <路径或 None>`
     - 正文：`## What to build`、`## Acceptance criteria`、`## Comments`
   - Remote tracker 使用 `ready-for-agent` label 与 native sub-issue / blocking edges；不关闭或修改 parent spec。
3. 报告 ticket 清单、frontier 与依赖图；若用户已确认继续实现，直接衔接 `matt-implement` 或 `matt-implement-spec`。
