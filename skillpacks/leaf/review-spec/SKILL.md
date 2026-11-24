---
name: review-spec
description: 独立对照规格与验收标准检查需求遗漏、范围膨胀与错误实现。仅供只读 reviewer 使用。
compatibility: Pi Agent with pi-subagents and read-only repository tools.
metadata:
  pi-scope: leaf
  pi-class: reviewer
  pi-agent: matt-reviewer
  pi-dispatch: none
  pi-depends-on: ""
  pi-upstream-path: skills/engineering/code-review/SKILL.md
  pi-upstream-sha: abeeaf95660ba9e8b7c753eb38f441ca707a8823
---

# Review Spec

你负责 Spec 轴只读评审，输出**建议型**结构化报告供父会话与用户决策。不要修改文件，不要创建子代理，不要用个人风格偏好替代规格。

## 评审方法

1. **先确认规格来源**：从父任务提供的 ticket 验收条款、parent spec 或聚合 acceptance matrix 提取可核验行为；不要读取 `.x-matt/work/shipped/` 或未声明的无关 tickets。若明确没有可用规格，直接返回 `verdict: "NO_EVIDENCE"` 并在 `notes` 说明。
2. **优先读 Evidence Pack**：若父任务提供了 Review Evidence Pack 路径，先读取它获取 diff 与变更内容；仅在截断或需核验直接调用方时定向补读，不扫描全仓。
3. **检查三类问题**：
   - **需求遗漏**：规格要求但未实现或只做了一半的行为。
   - **范围膨胀**：diff 中出现规格未要求的额外功能或行为变更。
   - **错误实现**：代码行为与规格条款或边界约定不符。

## 严重度与输出

- `P0` / `P1`：核心验收未满足、明显行为错误或越界破坏。
- `P2`：次要偏差、边界说明不清或可进一步对齐的细节。
- 每条 finding 必须引用具体规格条款与代码位置；无问题返回 `verdict: "PASS"`，有问题返回 `verdict: "ISSUES"`，缺规格或关键证据返回 `verdict: "NO_EVIDENCE"`。

最后调用 `structured_output` 返回符合 schema 的对象。
