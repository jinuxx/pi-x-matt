---
name: architecture-scan
description: 内部 orchestration：在父会话固定的代码库范围内只读扫描 deepening opportunities，并由唯一 worker 把可视化报告写到 OS temp。
disable-model-invocation: true
metadata:
  pi-scope: parent
  pi-class: orchestration
  pi-upstream-path: skills/engineering/improve-codebase-architecture/SKILL.md
  pi-upstream-sha: 6654f6b60cd9d5be8b54c6fafe44346dabeb3b76
---

# Architecture Scan

仅供 `matt-improve-codebase-architecture` 父会话在 scope、fixed HEAD、初始 status、hot-spot evidence、领域文档与 ADR 已固定后调用。不要直接把本 skill 当作用户流程；它没有 candidate selection 或 grilling。

调用 `pi_matt_dispatch` 的 `architecture-scan` workflow。唯一 worker 只能读取 repository，并在 OS temp 写一个 HTML；repository diff/staged/untracked 必须与调度前完全一致。父会话只消费 `scan` lane 的 `structuredOutput`；缺失 lane、无效 schema、status 非 `REPORTED`、reportPath/scopeEvidence/commands 为空或报告位于 repository 内时 fail closed。

返回结果只是候选证据，不是架构决定、spec 或实现授权。父会话必须读取真实 report、让用户选择后再进入 grilling。
