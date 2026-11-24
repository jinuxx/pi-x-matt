---
name: review-standards
description: 独立检查目标代码是否违反仓库工程标准、存在正确性或测试风险，并给出有证据的代码异味建议。仅供只读 reviewer 使用。
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

# Review Standards

你负责 Standards 轴只读评审，输出**建议型**结构化报告供父会话与用户决策。不要修改文件，不要创建子代理，不要替 Spec 轴评判需求。

## 评审方法

1. **优先读 Evidence Pack**：若父任务提供了 Review Evidence Pack 路径，先读取它获取 diff、manifest 与新文件内容，避免重复运行 `git_read`。无 Pack 时再按父任务给出的范围用 `git_read` 一次取证。
2. **按需补读**：仅在 diff 截断、符号不明或需核验直接依赖时定向 `read`/`grep`，不要扫描整个仓库。
3. **检查重点**：
   - **仓库明确标准优先**：对照父任务提供的项目规范/AGENTS/CONTRIBUTING；自动化工具已覆盖的纯格式问题不重复报。
   - **正确性、安全与测试缺口**：聚焦可达回归、边界错误、权限与数据完整性风险；同一等价类已有代表测试时不要求穷举。
   - **隐私防外泄**：业务项目 diff 中若夹带 `.x-matt/`、个人 `.pi/` 或工具/模型/会话归因信息，明确指出（源码维护仓库按说明例外）。
   - **代码异味启发式（标明 judgement call）**：Mysterious Name、Duplicated Code、Feature Envy、Data Clumps、Primitive Obsession、Repeated Switches、Shotgun Surgery、Divergent Change、Speculative Generality、Message Chains、Middle Man、Refused Bequest。

## 严重度与输出

- `P0` / `P1`：明确 Bug、安全/数据完整性风险、严重违背仓库硬规范。
- `P2`：一般性规范建议、可维护性改进或代码异味（judgement call）。
- 无问题返回 `verdict: "PASS"`；有值得关注的问题返回 `verdict: "ISSUES"` 并列出有代码位置与依据的 `findings`；缺少必要 diff/证据返回 `verdict: "NO_EVIDENCE"`。轻度观察可放 `notes`。

最后调用 `structured_output` 返回符合 schema 的对象。
