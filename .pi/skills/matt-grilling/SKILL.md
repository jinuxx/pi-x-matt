---
name: matt-grilling
description: 通过分轮 decision tree 追问计划、决定或想法，直到用户确认 shared understanding。用于压力测试思路或任何 grill 类请求。
metadata:
  pi-scope: parent
  pi-class: interaction
  pi-dispatch: none
  pi-depends-on: ""
  pi-upstream-path: skills/productivity/grilling/SKILL.md
  pi-upstream-sha: 3cca18b368ae95cdbdebbff572ccafa662551015
---

# Grilling

本 skill 在当前父会话中执行。它不启动写者，不通过 `pi_matt_dispatch` 委派整个访谈，也不替用户回答产品、范围或设计决定。

## Decision tree

1. 把目标拆成 decision tree：每个决定只连接到依赖它的后续决定。
2. **Frontier** 是所有前置决定已解决、现在可以回答的问题。每轮只问当前 frontier，不提前询问依赖未决答案的问题。
3. 用户回答后更新 tree：记录已解决决定、显式未决项、新暴露分支和被答案剪掉的分支，然后重新计算 frontier。
4. 对可逆且不影响公开行为的细节给出推荐默认值；推荐不是决定，用户未接受前保持未决。

## 每轮协议

- 每轮使用一次 `ask_user_question`，包含 1–4 个互不依赖的 frontier 问题。存在推荐答案时，将推荐选项放在第一项并标记 `(Recommended)`。
- 问题必须说明正在决定什么以及主要权衡；不要把背景说明、实现教程或多个依赖问题塞进一个问题。
- 用户可一次回答整轮。收到答案前不要进入下一轮，也不要开始实施。
- 自定义答案不够明确时，只追问影响行为、持久数据、成本、架构或范围的歧义。

## 事实与决定

- **Fact** 由代码、配置、文档、工具或一手外部资料决定。先自行调查；不要让用户回答可以查到的事实。
- **Decision** 需要价值判断或取舍。必须由用户回答；代码现状和 agent 推荐只能作为证据。
- 本地事实由父会话直接使用 `fffind`、`ffgrep`、`read` 等只读工具核验；需要外部一手资料时调用已注册的 `matt-research` workflow。
- 异步调查是未解决前置条件。继续询问不依赖它的其他 frontier；调查完成前不要猜测其下游问题。

## 完成 gate

Frontier 为空时，汇总目标、范围、非目标、已确认决定、仍存在的事实缺口和显著风险。使用 `ask_user_question` 请求用户明确选择“确认 shared understanding”或“继续澄清”。只有用户确认后，本次 grilling 才完成；确认前不得实施或宣称计划已经定稿。

## Transition handoff

用户确认 shared understanding 后必须把控制权交还给用户，本次 skill 到此结束。不得在同一 invocation 或同一自动连续流程中继续确认测试 seam、调用 `matt-tdd`、写生产代码，或为解阻实现而创建 spec/tickets。

- standalone grilling：报告 shared understanding 已确认，再使用一次 `ask_user_question` 让用户选择“发布 spec 并继续拆 tickets”“直接实现一个单 slice”或“暂停”。只记录选择并提示下一条显式命令 `/skill:matt-to-spec` 或 `/skill:matt-implement`，随后结束；不得代替用户执行命令。只有一个明确、可在当前 session 完成且事实已可追溯的单 slice 才提供直接实现选项。
- 被 `matt-grill-with-docs`、`matt-wayfinder` 或其他 parent 作为依赖使用时：只把确认结果交还给该 parent，由调用方执行自己的 transition gate；不得替调用方选择或启动下一阶段。
- “需求已经明确”“用户希望开始实现”或缺少 TDD 所需 artifact，都不是自动越过 transition handoff 的授权。下一阶段必须由用户在 grilling 完成之后另行明确选择。
