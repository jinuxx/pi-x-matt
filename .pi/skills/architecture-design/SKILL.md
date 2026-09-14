---
name: architecture-design
description: 内部 orchestration：为一个用户已选择的 deepening candidate 并行生成 minimal、flexible 与 common-caller 三种不同 interface 方案。
disable-model-invocation: true
metadata:
  pi-scope: parent
  pi-class: orchestration
  pi-upstream-path: skills/engineering/codebase-design/DESIGN-IT-TWICE.md
  pi-upstream-sha: 3cca18b368ae95cdbdebbff572ccafa662551015
---

# Architecture Design

仅供 `matt-improve-codebase-architecture` 在用户选定 candidate、完成初步 grilling、确认 constraints/callers/dependency category/seam evidence，并明确要求比较 alternative interfaces 后调用。

父会话先展示中立的问题空间、约束、依赖类别和仅用于 grounding 的粗略 sketch，不把 sketch 当提案。然后调用 `pi_matt_dispatch` 的 `architecture-design` workflow。三个 fresh `matt-reader` lane 分别优化 minimal interface、flexibility 与 common caller；全部只读，不修改 repository。

只消费三个 lane 的 `structuredOutput`。结果数量、lane key、status、entries/tradeoffs 缺失或任一 lane 失败时 fail closed，不用两个方案冒充 design-it-twice。父会话顺序展示三个方案，以 depth、locality、seam placement 比较，再给出有立场的推荐或 hybrid；最终选择仍由用户确认。
