---
name: architecture-deepening-reader
description: 为只读 interface 方案提供 dependency category、adapter 与 interface test surface 约束。
compatibility: Pi Agent with repository read tools.
metadata:
  pi-scope: leaf
  pi-class: executor
  pi-agent: matt-reader
  pi-dispatch: none
  pi-depends-on: architecture-vocabulary-reader
  pi-upstream-path: skills/engineering/codebase-design/DEEPENING.md
  pi-upstream-sha: 3cca18b368ae95cdbdebbff572ccafa662551015
---

# Architecture Deepening Reader

按父任务证据选择依赖策略：

- `in-process`：直接合并 implementation，通过新 interface 测试，无 adapter。
- `local-substitutable`：用真实 local stand-in，通过 module interface 测试，不把内部 seam 暴露给 caller。
- `ports-adapters`：自有远程系统在 seam 定义 port，production transport 与 in-memory test adapter 构成两个真实 adapters。
- `mock`：第三方系统通过 injected port，测试使用 mock adapter。

新的测试只观察 deep module interface 的 outcome。旧 shallow module tests 只有在新 interface tests 覆盖同一行为后才建议删除。内部 seam 不因测试需要泄漏到公开 interface。不要修改文件。
