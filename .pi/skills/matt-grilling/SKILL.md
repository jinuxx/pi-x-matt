---
name: matt-grilling
description: 通过分轮 decision tree 追问计划、决定或想法，直到用户确认 shared understanding。用于压力测试思路或任何 grill 类请求。
metadata:
  pi-scope: parent
  pi-class: interaction
  pi-dispatch: none
  pi-depends-on: ""
  pi-upstream-path: skills/productivity/grilling/SKILL.md
  pi-upstream-sha: abeeaf95660ba9e8b7c753eb38f441ca707a8823
---

# Grilling

本 skill 在当前父会话中执行。它不启动写者，也不替用户回答产品、范围或设计决定。

## Decision tree

1. 把目标拆成 decision tree：每个决定只连接到依赖它的后续决定。
2. **Frontier** 是所有前置决定已解决、现在可以回答的问题。每轮只问当前 frontier，不提前询问依赖未决答案的问题。
3. 用户回答后更新 tree：记录已解决决定、显式未决项、新暴露分支与剪枝，重新计算 frontier。
4. 对可逆且不影响公开行为的细节给出推荐默认值；用户未接受前保持未决。

## 每轮协议

- 每轮使用一次 `ask_user_question`，包含 1–4 个互不依赖的 frontier 问题。有推荐项时放第一位并标 `(Recommended)`，措辞让“确认推荐项 = 回答是”。
- 问题聚焦正在决定的取舍，简洁直接。
- 事实（代码现状、配置、外部一手资料）先自行查证，不让用户回答能查到的事实；本地用只读工具，外部资料调用 `matt-research`。

## 完成与衔接

Frontier 为空时，汇总目标、范围、非目标、已确认决定与显著风险，使用 `ask_user_question` 请用户确认理解并选择下一步：

- **直接开始实现**（适用于范围清晰、可在当前会话完成的单 slice）：确认后可直接衔接 `matt-implement`；
- **生成 spec 并拆 tickets**（适用于多流程、跨会话或较复杂改动）：确认后可直接衔接 `matt-to-spec`；
- **先暂停 / 继续澄清**：按用户反馈暂停或继续追问。

作为依赖被 `matt-grill-with-docs` 或 `matt-wayfinder` 调用时，将确认结果交还给调用方衔接。
