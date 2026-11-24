---
name: matt-diagnosing-bugs
description: 对难复现 bug、间歇性失败和性能回归执行反馈循环→最小复现→假设→探针的受控诊断，并把已确认根因交给 implement 修复。
metadata:
  pi-scope: parent
  pi-class: interaction
  pi-dispatch: none
  pi-depends-on: matt-implement
  pi-upstream-path: skills/engineering/diagnosing-bugs/SKILL.md
  pi-upstream-sha: abeeaf95660ba9e8b7c753eb38f441ca707a8823
---

# Diagnosing Bugs

处理一个可明确描述的 hard bug、间歇性失败或性能回归。诊断完成后直接交接给 [matt-implement](../matt-implement/SKILL.md) 做回归测试与修复，不重复实现第二套流水线。

## 脱敏与边界

- 任何展示或记录前先移除 secret、token、cookie、私钥与生产敏感标识（用 `<REDACTED>` 替换）；凭据仅通过环境变量传递。
- 诊断阶段默认只读；若必须写临时 harness 或 `[DEBUG-<id>]` 探针日志，先取得用户确认，并在修复前清理干净。

## 四阶段诊断

### Phase 1：建立可复现反馈循环（强制）
在提出根因理论之前，先建立一条已经实际运行、能稳定复现目标症状、秒级且可无人值守重跑的命令（优先复用现有公开测试切入点，其次 CLI/HTTP 脚本、最小 harness 或 `git bisect`）。没有可运行的复现命令时，向用户请求最小复现条件并暂停。

### Phase 2：最小化复现
确认失败对应用户的精确症状；对 flaky bug 统计复现率。逐步删除非必要输入与步骤，得到“移除任一剩余元素就会变绿”的最小 repro。

### Phase 3：假设排序确认
列出 3–4 个按证据排序、可证伪的假设（格式：“如果 X 是根因，改变/观察 Y 将出现 Z”），展示给用户并用 `ask_user_question` 确认优先验证方向。

### Phase 4：单变量探针与根因确认
每次只验证一个变量；性能问题先测基线与 profile 再定位。确认根因后：
- 验证该根因能解释原始症状与最小 repro；
- 移除所有 `[DEBUG-<id>]` 临时日志并 `grep` 确认残留为空；
- 确认存在合适的公开回归**测试切入点**（若架构缺失可测试切入点，停止并建议通过 `matt-improve-codebase-architecture` 先改善接口，不写浅层测试）。

## 交给 Implement 修复与收尾

将确认的根因、复现命令、最小 repro、回归测试切入点交给 `matt-implement`（通过 `matt-tdd` 完成回归 RED→GREEN 与聚焦验证），最后核对：
- 原始 Phase 1 复现命令与新增回归测试均通过；
- 项目相关测试与 typecheck 通过；
- 所有临时 `[DEBUG-<id>]` 与 throwaway harness 已清理，提交符合项目隐私契约（需要时可按需调用 `matt-code-review`）。
