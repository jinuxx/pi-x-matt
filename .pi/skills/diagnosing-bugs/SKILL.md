---
name: diagnosing-bugs
description: 对难复现 bug、间歇性失败和性能回归执行反馈循环→最小复现→假设→探针的受控诊断，并把已确认根因顺序交给 implement。用于用户明确要求 diagnose/debug，或报告具体 broken/throwing/failing/slow 症状且不能直接定位时。
metadata:
  pi-scope: parent
  pi-class: interaction
  pi-dispatch: none
  pi-depends-on: implement
  pi-upstream-path: skills/engineering/diagnosing-bugs/SKILL.md
  pi-upstream-sha: 6654f6b60cd9d5be8b54c6fafe44346dabeb3b76
---

# Diagnosing Bugs

本 skill 是一个 model-invoked 的独立入口，处理一个已经能够明确描述的 hard bug 或性能回归。它不是代码库巡检、普通解释、review、triage 或“顺手看看哪里慢”；没有具体用户症状时不要触发。诊断完成后复用现有 `implement → tdd → code-review → commit`，不在这里复制第二套实现流水线。

开始时完整读取依赖 [implement](../implement/SKILL.md)，但在达到 Root-cause gate 前不得进入实现。父会话拥有用户 checkpoint、证据归属和最终判断；任何时刻最多一个写者，禁止与 `worker` 并行修改同一工作区。

## Redact gate

诊断会展示命令、输出、日志和捕获 artifact。任何展示或持久化前先删除 secret、token、cookie、Authorization header、个人数据与生产标识，统一用 `<REDACTED>` 替换。凭据只通过环境变量传入命令，不写进 task、测试、fixture、日志、截图、Comments 或提交。

若脱敏后证据不足以诊断，停止并使用 `ask_user_question` 请求安全的最小补充；不得要求用户把完整生产 HAR、数据库 dump、core dump 或环境变量粘进会话。涉及生产访问、远程写入、敏感数据或临时生产 instrumentation 时，遵循项目确认边界，未经明确授权不得继续。

## 初始化

1. 固定一个 bug：记录用户原话中的可观察症状、预期行为、实际行为、首次出现时间/已知 good state、环境和影响。多个症状先选一个；不要把附近失败替换成目标 bug。
2. 读取 `git status`、当前 `HEAD`、相关 `CONTEXT.md`/`CONTEXT-MAP.md`、ADR、项目说明、现有测试命令和直接调用路径。保护用户既有改动，不改写或归因它们。
3. 记录诊断前基线、允许读取范围、允许命令、现有工作区变化和敏感数据边界。
4. 诊断阶段默认只读。若建立反馈循环或探针必须写仓库文件，先用一次 `ask_user_question` 确认精确文件范围；只允许临时 harness、fixture 或带唯一 `[DEBUG-<id>]` 前缀的 instrumentation。不得在 Root-cause gate 前写生产修复。

## Phase 1：Feedback-loop gate

反馈循环是强制 gate。先尝试复用现有公开 seam，按以下优先级建立一个能抓住**这个症状**的命令：失败测试、HTTP/CLI 脚本、headless browser、脱敏 trace replay、throwaway harness、固定 seed 的 property/fuzz loop、`git bisect run`、old/new differential loop，最后才是结构化 HITL loop。

持续收紧循环：减少 setup、缩短到秒级、固定时间/RNG/文件系统/网络，并提高 flaky bug 的复现率。循环必须由 agent 无人值守执行；确实需要人工动作时，把步骤与观测分开并明确记录。

没有下列四项证据时，不得读代码形成根因理论，也不得进入 Phase 2：

- **一个精确命令**：已经实际运行至少一次；
- **Red-capable**：断言用户的精确症状，而不是“没有 crash”；
- **Deterministic**：稳定红，或有固定次数与可报告的高复现率；
- **Fast / agent-runnable**：秒级且可无人值守重复。

向用户展示脱敏后的命令、关键 red 输出和运行时长。若无法建立循环，列出已尝试方法，并用 `ask_user_question` 只请求以下之一：可复现环境、脱敏最小 artifact、或临时 instrumentation 授权。仍无循环时以 `BLOCKED` 停止；**no red-capable command, no hypothesis**。

## Phase 2：Reproduce and minimise

连续运行循环，确认失败正是用户描述的症状。对 flaky bug 报告运行次数、失败次数和比例。然后一次删除一个输入、caller、配置、数据或步骤，每次都重跑同一命令；只保留 load-bearing 元素。

完成条件：最小 repro 仍稳定 red，且移除任一剩余元素会 green。保存脱敏的原始症状与最小 repro 证据，二者都要在修复后复跑。

## Phase 3：Hypothesis checkpoint

在测试任何理论前生成 **3–4 个**按证据排序、相互可区分且可证伪的假设。每个假设使用格式：

> 如果 X 是根因，那么改变/观察 Y 会使症状消失、恶化或出现 Z。

先向用户展示排序、支持证据、反证和对应 probe，再使用一次 `ask_user_question`：把最高优先级假设放在第一个推荐选项，其余假设作为选项；用户也可通过自动提供的自定义输入补充证据或重排。用户确认前不得写探针或修复。

## Phase 4：Probe and root-cause gate

每个 probe 必须对应一个 Phase 3 prediction，一次只改变一个变量。优先 debugger/REPL，其次是边界上的定向日志；禁止“log everything and grep”。所有临时日志使用同一个唯一 `[DEBUG-<id>]` 前缀。

性能回归先记录 baseline measurement、profiler/query plan 或可重复 timing，再做 bisection/differential；measure first, fix second。

Root-cause gate 需要：

- 至少一个假设被证伪，最终根因假设的 prediction 被真实命令支持；
- 原始 Phase 1 loop 与最小 repro 在修复前仍为 red；
- 根因能解释用户症状和最小 repro 中每个 load-bearing 元素；
- 已识别正确的公开 regression seam，或明确证明当前架构没有这样的 seam；
- 所有生产文件中的 `[DEBUG-<id>]` instrumentation 已移除，`grep` 结果为空。

没有正确 regression seam 时，先清理所有诊断改动并停止。把“无法通过真实 call-site pattern 锁定 bug”作为架构 finding 报告；不得写浅层测试，也不得假定尚未移植的 `improve-codebase-architecture` 当前可调用。

## 交给 Implement

Root-cause gate 通过且存在正确 seam 后，形成当前会话单 slice handoff：

- 用户精确症状与已确认 root cause；
- Phase 1 原始 loop 命令、最小 repro 命令及脱敏 RED 证据；
- 被证伪假设和正确 prediction；
- 已确认 regression seam、interface 与修复后可观察行为；
- 固定基线、既有工作区改动、允许文件、测试/typecheck/full-suite 命令；
- 临时 artifact 清单和 cleanup 条件。

然后按已完整读取的 `implement` 执行一个且仅一个当前会话 slice；已有 `Type: ticket`/`Status: ready-for-agent` ticket 时沿用其 tracker 生命周期。`implement` 仍负责 seam 确认、唯一 `worker` 的真实 RED→GREEN、完整验证、fresh 双轴 review、状态回写和提交。诊断证据不能替代 TDD 的 RED/GREEN，也不能替代 review。

## Final cleanup

只有以下条件全部满足才可宣称 bug 已修复：

- Phase 1 原始 loop 对原始场景已 green；
- regression test 在正确 seam 上通过；
- 相关测试、typecheck 和完整 suite 按 `implement` 通过；
- `grep` 确认所有 `[DEBUG-<id>]` instrumentation 已删除；
- throwaway harness/artifact 已删除，或按用户批准保存在明确的 `.scratch/` 诊断路径且不含敏感数据；
- Standards 与 Spec review 均 PASS，提交可核验；
- 完成报告明确写出正确假设、根因、命令证据、commit 与 residual risks。

任何 gate 缺失、测试失败、仍有临时 instrumentation、无法脱敏或需要扩大权限时保持未完成状态并停止。
