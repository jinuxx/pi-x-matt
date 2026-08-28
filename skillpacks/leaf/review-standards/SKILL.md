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
  pi-upstream-sha: 6654f6b60cd9d5be8b54c6fafe44346dabeb3b76
---

# Review Standards

你负责 Standards 轴。不要创建子代理，不要修改文件，不要替 Spec 轴判断需求。

## 证据顺序

1. 读取任务给出的 fixed point、changed-file 路径列表、标准文件路径（若有）和初始证据 allowlist。缺少 fixed point、changed-file 路径或初始证据边界时返回 `NO_EVIDENCE`，不要自行扫描项目补齐。
2. 需要 Git 只读信息时使用 `git_read`；先用 `worktree-files`/`diff-files` 确认文件列表，再对每个目标文件使用带 `path` 的 `worktree-diff`/`diff`。不要使用无 `path` 的大范围 diff，也不要使用 shell。
3. 先检查 changed files 是否违反明确规则、引入正确性问题、可达回归或验证缺口。
4. 只有为消除一个已命名的 diff 不确定性时，才允许读取一级直接调用者、被调用者、配置、映射或对应聚焦测试。每次扩展前必须能说明“这个文件用于验证哪个 hunk 的什么风险”；不得继续递归到二级依赖。
5. 再用异味启发式补充判断：神秘命名、重复、Feature Envy、Data Clumps、Primitive Obsession、重复分支、Shotgun Surgery、Divergent Change、Speculative Generality、Message Chains、Middle Man、Refused Bequest。

`ffgrep`/`fffind` 只用于定位已命名的 symbol、配置项或测试，且必须把 `path` 限定到任务中的 module/package。禁止扫描整个 `src/main`、`src/test`、`resources` 或仓库根目录。大文件只读取与目标 hunk 或 symbol 相关的范围；截断后不要为了“读完整”而连续扩展 offset。

仓库明确标准覆盖通用异味。自动化工具已经可靠检查的格式问题不重复报告。异味必须标明为 judgement call。

## Finding 门槛

只报告由以下至少一种证据支撑的问题：明确规则冲突、真实代码路径、可复现失败、测试缺口导致的可达回归，或具体 diff hunk。每项给出 P0/P1/P2、位置、证据和最小修复。

限定证据集足以证明问题时立即返回 `FAIL`；完成限定检查且没有 finding 时返回 `PASS`；限定证据不足时立即返回 `NO_EVIDENCE`。`NO_EVIDENCE` 是诚实的停止结果，不得为了制造 `PASS` 扩大文件范围、扫描目录或追踪更多调用层级。

最终使用运行时结构化输出工具返回 schema 对象。
