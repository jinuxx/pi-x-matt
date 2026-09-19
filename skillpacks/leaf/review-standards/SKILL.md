---
name: review-standards
description: 独立检查目标代码是否违反仓库明确标准、引入正确性或测试风险，并用代码异味启发式补充有证据的判断。仅供只读 reviewer 使用。
compatibility: Pi Agent with pi-subagents and read-only repository tools.
metadata:
  pi-scope: leaf
  pi-class: reviewer
  pi-agent: matt-reviewer
  pi-dispatch: none
  pi-depends-on: ""
  pi-upstream-path: skills/engineering/code-review/SKILL.md
  pi-upstream-sha: 3cca18b368ae95cdbdebbff572ccafa662551015
---

# Review Standards

你负责 Standards 轴。不要创建子代理，不要修改文件，不要替 Spec 轴判断需求。

## 证据顺序

1. 先读取 **Review Evidence Pack**，获得 `reviewKind`、fixed point/current HEAD、git status、完整 changed-file manifest、全部 tracked diff、新文件完整内容/hash，以及本 lane 适用工程规范摘录和安全/正确性边界。来源、hash 和完整性必须明确；不要求重复读取规范全文或 parent spec 全文。测试记录区分 workflow/runner 原始证据与 worker-reported 结果，后者不能替代真实 diff。缺少 reviewKind、精确 manifest 或可核验来源时返回 `NO_EVIDENCE`，不自行扫描补齐。
2. 对 Pack 内容独立判断，而非采纳 writer 的结论。已提供完整证据时不再执行 status/diff 或逐文件 read。没有 Pack 的 standalone 评审可按父任务给定范围一次取证：`worktree-files` 后使用完整、未截断的 combined `worktree-diff`；`committed` 使用 `diff-files ref` 与 combined `diff ref`；`files` 只读取精确目标文件且不调用 Git。tracked 必须获得全部 diff；untracked 必须获得全文；deleted 只读 diff；rename 核对 old/new。禁止用 `ref...HEAD` 作为工作区唯一证据。
3. 默认只能读取 manifest 内文件。仅在 diff/新文件内容被截断、引用 symbol 无法判断、需要核验一层直接依赖、Pack 与工作区 hash 不一致，或发现潜在安全/数据完整性问题时补读。每次先说明“哪个 hunk 缺少什么证据”；截断只补缺失部分，不能把大文件截断当作无需完整 diff/新文件的理由。基线/hash 失效且无法在限定范围核验时返回 `NO_EVIDENCE`，请父会话刷新 Pack。
4. 额外搜索只定位已命名 symbol、配置项或测试，必须限定到任务 module/package，最多扩展一层直接调用者、被调用者、配置、映射或聚焦测试，不递归。禁止无证据扫描整个 module、源码/测试/资源目录或仓库根目录。
5. 检查明确规则、正确性、可达回归和测试缺口；再以神秘命名、重复、Feature Envy、Data Clumps、Primitive Obsession、重复分支、Shotgun Surgery、Divergent Change、Speculative Generality、Message Chains、Middle Man、Refused Bequest 补充有证据的判断。

仓库明确标准覆盖通用异味。自动化工具已经可靠检查的格式问题不重复报告。异味必须标明为 judgement call。

## Finding 门槛

只报告由以下至少一种证据支撑的问题：明确规则冲突、真实代码路径、可复现失败、测试缺口导致的可达回归，或具体 diff hunk。每项给出 P0/P1/P2、位置、证据和最小修复。

限定证据集足以证明问题时立即返回 `FAIL`；完成限定检查且没有 finding 时返回 `PASS`；限定证据不足时立即返回 `NO_EVIDENCE`。`NO_EVIDENCE` 是诚实的停止结果，不得为了制造 `PASS` 扩大文件范围、扫描目录或追踪更多调用层级。

最终使用运行时结构化输出工具返回 schema 对象。
