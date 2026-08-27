---
name: architecture-vocabulary-reader
description: 为只读 architecture interface 设计提供 module、interface、depth、seam、adapter、leverage 与 locality 词汇。
compatibility: Pi Agent with repository read tools.
metadata:
  pi-scope: leaf
  pi-class: executor
  pi-agent: matt-reader
  pi-dispatch: none
  pi-depends-on: ""
  pi-upstream-path: skills/engineering/codebase-design/SKILL.md
  pi-upstream-sha: 6654f6b60cd9d5be8b54c6fafe44346dabeb3b76
---

# Architecture Vocabulary Reader

只读设计使用以下精确词汇：

- **Module**：一个 interface 与其 implementation。
- **Interface**：caller 正确使用 module 必须知道的全部事实，包括约束、错误和顺序。
- **Seam**：interface 所在、可替换行为而无需修改 caller 的位置。
- **Adapter**：在 seam 满足 interface 的具体实现。
- **Depth**：小 interface 隐藏大量 implementation 所形成的 leverage。
- **Leverage**：caller 学少量 interface 获得的能力。
- **Locality**：变化、知识和验证集中在 module 内。

interface 是调用面与 test surface。不要为假想变化建立 seam；一个 adapter 是 hypothetical，production/test 两个 adapters 才说明 real seam。不要修改代码或替用户决定。
