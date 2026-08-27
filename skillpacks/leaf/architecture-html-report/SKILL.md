---
name: architecture-html-report
description: 把经过 deletion test 的 deepening candidates 渲染为 OS temp 中的可视化 HTML 报告。仅供 architecture scan worker 使用。
compatibility: Pi Agent with repository read tools and OS temp write access.
metadata:
  pi-scope: leaf
  pi-class: executor
  pi-agent: worker
  pi-dispatch: none
  pi-depends-on: ""
  pi-upstream-path: skills/engineering/improve-codebase-architecture/HTML-REPORT.md
  pi-upstream-sha: 6654f6b60cd9d5be8b54c6fafe44346dabeb3b76
---

# Architecture HTML Report

只把已通过父任务证据核验和 deletion test 的 candidates 写成报告；不得在报告生成阶段发明新 candidate。

- 目标路径为 `$TMPDIR/architecture-review-<timestamp>.html`；`TMPDIR` 缺失时 macOS/Linux 使用 `/tmp`，Windows 使用 `%TEMP%`。每次使用新文件，不覆盖旧报告，不写 repository。
- Header 只含 repo、日期与 visual legend；直接进入 candidates。
- 每张 card 必须包含 title、recommendation strength（`Strong`/`Worth exploring`/`Speculative`）、dependency category、files、Problem、Solution、Benefits、Before/After visual 和必要的 ADR warning。
- Benefits 只用 **locality**、**leverage**、interface/test surface 等可核验收益，不写“cleaner/easier to maintain”。
- Before/After 是中心内容：依赖/call flow 可使用 Mermaid；deep-vs-shallow mass、cross-section、collapse 使用 inline HTML/CSS/SVG。图不清楚时重画，不用长段落补救。
- 默认遵循上游 Tailwind/Mermaid CDN scaffold。网络策略、离线环境或浏览器安全策略不允许 CDN 时，改用 inline CSS 与 hand-built SVG，并在 warnings 中说明；不得伪称 Mermaid 已渲染。
- 架构词汇只能使用 module、interface、implementation、depth/deep/shallow、seam、adapter、leverage、locality。项目领域名来自 `CONTEXT.md`。
- 报告末尾只有一个 Top recommendation；没有 actionable candidate 时明确写“未发现通过 deletion test 的候选”，不得捏造。

写后读取文件，确认 doctype、每张 candidate id/card、before/after、strength 与 top recommendation 都存在，并返回绝对路径。不要自动提交、push 或复制到仓库。
