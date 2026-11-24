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
  pi-upstream-sha: abeeaf95660ba9e8b7c753eb38f441ca707a8823
---

# To Spec

先应用[业务项目隐私契约](../matt-setup/privacy.md)：业务项目整个 `.x-matt/` 与个人 `.pi/` 仅保存在本机，发布前确认本机 Git exclude 保护生效，不暂存、不提交 spec。

本 skill 只综合当前会话（或 cleared Wayfinder map）中已经确认的设计，不重新发起冗长访谈，也不擅自编造未讨论的需求。

## 前置条件

1. 读取当前会话决策、相关代码、`.x-matt/context/`、`.x-matt/adr/` 与相关 research note。若输入为 Wayfinder map，核验其 `Status: cleared` 且无残留 fog。
2. 检查 `.x-matt/agents/issue-tracker.md` 与 `.x-matt/agents/triage-labels.md`；缺失时提示先运行 `matt-setup`。
3. Local Markdown 发布前读取非空 `PI_SESSION_ID`，用于写入 `Source session: pi:<PI_SESSION_ID>`。
4. 默认跳过 `.x-matt/work/shipped/`，不把归档内容当作 active 输入。

## 测试切入点与 Spec 综合

1. 先勾勒最高层的公开**测试切入点**（从哪个公开入口测、能验证什么、验证不到什么），随 spec 草稿一并展示。
2. 综合生成包含以下结构的 Markdown：
   - `## Problem Statement` / `## Solution`
   - `## User Stories`（已确认的可观察行为）
   - `## Implementation Decisions`（公开 interface、架构与契约决定，不粘贴普通实现代码）
   - `## Testing Decisions`（测试切入点与相关测试先例）
   - `## Out of Scope` / `## Further Notes`
   - `## Reference Inputs`（用户提供且不能安全压缩的事实、样例或约束，脱敏 secrets 后忠实保留；无则写 `None`）

## 确认、发布与衔接

1. 向用户展示 spec 摘要、测试切入点与 Out of Scope，使用 `ask_user_question` 一次确认发布（以及发布后是否直接进入 `matt-to-tickets` 拆票）。
2. 确认后按 `.x-matt/agents/issue-tracker.md` 发布 parent spec（Local Markdown 写 `Type: spec`、`Status: spec-ready`、`Source session: pi:<PI_SESSION_ID>` 到 `.x-matt/work/<feature-slug>/spec.md`），并读回核验。
3. 若用户已选择继续拆票，直接衔接 `matt-to-tickets`；否则报告发布路径并结束。
