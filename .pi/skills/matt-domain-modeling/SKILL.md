---
name: matt-domain-modeling
description: 在设计讨论中澄清项目术语、维护 CONTEXT.md，并只为难逆转且存在真实权衡的决定记录 ADR。
metadata:
  pi-scope: parent
  pi-class: interaction
  pi-dispatch: none
  pi-depends-on: ""
  pi-upstream-path: skills/engineering/domain-modeling/SKILL.md
  pi-upstream-sha: 6654f6b60cd9d5be8b54c6fafe44346dabeb3b76
---

# Domain Modeling

本 skill 是父会话中的主动纪律：在术语和决定形成时立即校验并落盘。仅阅读现有 glossary 不算 domain modeling。

## 定位上下文

1. 先检查根目录 `CONTEXT-MAP.md`、`CONTEXT.md` 和相关 `docs/adr/`。
2. 存在 `CONTEXT-MAP.md` 时按 map 定位对应 context；无法判断归属时向用户确认。否则使用根目录 `CONTEXT.md`。
3. 文件和目录按需创建：首个项目术语确定时才创建 `CONTEXT.md`；首个符合条件且经用户同意的决定出现时才创建 ADR 目录。

## 术语纪律

- 用户使用的词与现有 glossary 冲突时立即指出，并要求在两个含义间明确选择。
- 对含糊或过载词提出一个精确 canonical term，并用具体边界场景验证它。
- 用户描述的领域关系必须和相关代码交叉核验；矛盾属于待决问题，不能把代码或用户陈述静默当成真相。
- 术语一旦解决，立即对目标 `CONTEXT.md` 做小范围编辑，不在会话结束时批量补写。
- `CONTEXT.md` 只保存项目领域词汇，不保存实现细节、需求、计划、测试、决定流水账或通用编程概念。

格式：

```markdown
# <Context Name>

<一到两句上下文说明>

## Language

**<Canonical Term>**:
<一到两句定义它是什么>
_Avoid_: <不推荐的同义词>
```

定义应简短且有立场；只有确有替代词时才写 `_Avoid_`。自然形成多个领域簇时才增加二级分组。

## ADR 适用范围

以下决定通常值得进入 ADR，前提仍是同时满足三项 gate：架构形状（例如 monorepo 或事件溯源）、上下文之间的集成方式、带来明显锁定的技术选择、领域边界或所有权、偏离直觉做法的 deliberate deviation、代码中看不出的长期约束，以及值得保留的非显然 rejected alternative。库、函数名或临时实现细节通常不值得记录。

## ADR gate

只有以下三项同时成立时才向用户提议 ADR：

1. 改变决定的成本显著，难以逆转。
2. 缺少背景时，未来维护者会对该选择感到意外。
3. 存在真实备选方案，并基于具体权衡选定了其中一个。

任一项不成立就不创建 ADR。三项均成立时先说明为什么符合，并通过 `ask_user_question` 取得用户同意。ADR 使用对应 context 的 `docs/adr/`；扫描现有四位编号后递增，文件名为 `NNNN-slug.md`。

默认只写：

```markdown
# <Short decision title>

<一至三句：背景、决定和原因。>
```

只有状态、重要备选方案或非显然后果确有长期价值时才增加对应小节。

## 写入边界

父会话是 glossary 与 ADR 的唯一写者。写前读取当前内容，保留用户已有结构和无关改动；事实调查子代理只返回证据，不写共享文档。每次写入后核对 diff，确保 glossary 没有变成 spec，ADR 没有记录临时或显然决定。
