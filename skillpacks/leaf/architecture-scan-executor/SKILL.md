---
name: architecture-scan-executor
description: 在固定 scope 内只读探索代码库，寻找通过 deletion test 的 deepening candidates，并把报告写到 OS temp。
compatibility: Pi Agent with repository read tools and OS temp write access.
metadata:
  pi-scope: leaf
  pi-class: executor
  pi-agent: matt-worker
  pi-dispatch: none
  pi-depends-on: codebase-design, architecture-html-report
  pi-upstream-path: skills/engineering/improve-codebase-architecture/SKILL.md
  pi-upstream-sha: 6654f6b60cd9d5be8b54c6fafe44346dabeb3b76
---

# Architecture Scan Executor

你是唯一临时报告写者。repository 必须全程只读；只允许在 OS temp 创建本次 HTML。不要 edit/write repo 文件，不要 stage、commit、branch、push、安装依赖或创建子代理。

## Scan

1. 读取父任务的 fixed HEAD、初始 `git status`、精确 scope、hot-spot evidence、相关 `CONTEXT.md`/`CONTEXT-MAP.md`、ADR 和未来 change direction。scope 未固定或已有状态发生变化时停止。
2. 在 scope 内有机追踪真实 callers、interface、implementation、tests 与依赖；不要机械按文件名、行数或通用 smell 打分。
3. 只记录有证据的 friction：理解一个概念需要跨多个 shallow modules、interface 接近 implementation 复杂度、为测试抽出的纯函数却没有 call-site locality、seam 泄漏、或正确 interface test surface 不存在。
4. 每个 candidate 必须执行 deletion test：删除目标 shallow module 后，复杂度是否会集中到更小 interface 后方？只会散到 callers 的候选淘汰。
5. 分类依赖：`in-process`、`local-substitutable`、`ports-adapters`、`mock`。一个 adapter 只是 hypothetical seam；至少 production/test 两个 adapters 才是 real seam。
6. 使用项目领域词汇和 codebase-design 的 module/interface/depth/seam/adapter/leverage/locality。不得重新争论 ADR；只有 friction 足以重开决定时标注具体 ADR conflict。
7. 最多输出 6 个 candidates，按真实 evidence 与近期 leverage 排序；允许 0 个，不为填报告制造建议。不要在 scan 阶段设计具体 interface。

## Report and output

应用 `architecture-html-report` 写入 temp，并确认写入前后 repository status 完全相同。使用结构化输出返回：

- `status`: 报告可读取且 repository 未变化时 `REPORTED`，否则 `BLOCKED`
- `scope`, `scopeEvidence[]`
- `reportPath`: 绝对 temp HTML 路径
- `candidates[]`: id、title、strength、dependencyCategory、files、problem、solution、benefits、deletionTest、before、after、adrConflict、evidence
- `topRecommendation`: 无 candidate 时可为空字符串
- `commands[]`: 实际只读/报告校验命令及 outcome
- `warnings[]`: CDN/offline、coverage、未知项

candidate 数量可以为 0；但 reportPath、scopeEvidence 与 commands 必须可核验。repository 发生任何变化、报告路径位于 repo 内、证据不足或 deletion test 未执行时不得返回 `REPORTED`。
