---
name: codebase-design
description: 为 TDD worker 提供 deep module、interface、seam、adapter、leverage 与 locality 的统一设计词汇。仅供受限 worker 使用。
compatibility: Pi Agent with pi-subagents and repository tools.
metadata:
  pi-scope: leaf
  pi-class: executor
  pi-agent: worker
  pi-dispatch: none
  pi-depends-on: ""
  pi-upstream-path: skills/engineering/codebase-design/SKILL.md
  pi-upstream-sha: 6654f6b60cd9d5be8b54c6fafe44346dabeb3b76
---

# Codebase Design

使用以下词汇判断测试放在哪里；不要创建子代理，也不要自行改变父会话批准的 seam。

- **Module**：拥有一个 interface 与一份 implementation 的任意尺度代码单元。
- **Interface**：调用者正确使用 module 必须知道的全部事实，包括类型、约束、错误和顺序。
- **Seam**：module interface 所在、可以替换行为而无需修改调用点的位置。
- **Adapter**：在 seam 处满足 interface 的具体实现。
- **Depth**：小 interface 隐藏大量行为所产生的 leverage。
- **Leverage**：调用者学习少量 interface 获得的能力。
- **Locality**：变化、知识和验证集中在 module 内，而不是散落到调用者。

## TDD 约束

1. interface 同时是调用面与测试面；测试不越过 seam 观察内部状态。
2. 优先小 interface、依赖注入和返回可观察结果。
3. 只有一个 adapter 时不要为假想变化新增 seam；生产与测试确实需要两个 adapter 时 seam 才成立。
4. 外部依赖按以下方式处理：进程内逻辑直接测试；有本地替身的依赖使用真实替身；自有远程系统使用 port + production/test adapters；第三方系统只在该外部 seam mock。
5. 测试需要暴露内部方法时，先判断 module 是否太浅或 seam 放错；不要为了测试扩大公开 interface。
6. 父任务已经确认的 seam 是硬边界。发现必须改变 interface、adapter 或依赖类别时，停止写入并使用 `contact_supervisor` 请求决定。
