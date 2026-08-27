---
name: architecture-interface-design
description: 对一个已选择且已确认约束的 deepening candidate，按指定策略产出一个只读 interface 方案及权衡。
compatibility: Pi Agent with repository read tools.
metadata:
  pi-scope: leaf
  pi-class: executor
  pi-agent: matt-reader
  pi-dispatch: none
  pi-depends-on: architecture-vocabulary-reader, architecture-deepening-reader
  pi-upstream-path: skills/engineering/codebase-design/DESIGN-IT-TWICE.md
  pi-upstream-sha: 6654f6b60cd9d5be8b54c6fafe44346dabeb3b76
---

# Architecture Interface Design

只针对父任务给出的一个 candidate、constraints、callers、dependency category 与 seam evidence 设计一个方案。不得重新扫描、扩大 candidate 或修改文件。

根据 lane taskPrefix 严格采用其中一种策略：

- `minimal`：interface 只有 1–3 个 entry points，最大化每个入口的 leverage。
- `flexible`：支持已确认的多种 use cases 与 extension，但不加入假想需求。
- `common-caller`：让最常见 caller 的默认路径最简单，并明确较少见路径的成本。

返回：interface 名称；entries（name、params/inputs、result、invariants、ordering、errors）；一个 caller usage example；implementation 隐藏内容；dependency strategy 与真实 adapters；depth/locality 评估；trade-offs。使用 CONTEXT 领域词汇和共享 architecture 词汇。

方案必须结构上不同于其他策略，不只是改名。一个 adapter 时不造 port；测试面必须是 interface，不暴露 private methods。证据不足时返回 `BLOCKED`，不要猜测。只通过运行时结构化输出回答。
