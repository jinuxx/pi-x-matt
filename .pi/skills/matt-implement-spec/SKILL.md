---
name: matt-implement-spec
description: 在当前分支按依赖顺序串行实现已拆票的 Local Markdown spec，逐票验证提交，整批完成后做一次建议型集成评审。
disable-model-invocation: true
metadata:
  pi-scope: parent
  pi-class: interaction
  pi-dispatch: none
  pi-depends-on: matt-implement
  pi-upstream-path: skills/engineering/implement-spec/SKILL.md
  pi-upstream-sha: abeeaf95660ba9e8b7c753eb38f441ca707a8823
---

# Implement Spec（串行轻量版）

在当前父会话中按 `Blocked by` 依赖顺序逐票应用 [matt-implement](../matt-implement/SKILL.md)：**逐票只做确定性验证并提交，全部票完成后统一跑一次全量验证与一次建议型集成评审**。

## 开始前

1. 确认项目已配置 Local Markdown tracker 且本机 exclude 保护 `.x-matt/` 与个人 `.pi/`（应用[隐私契约](../matt-setup/privacy.md)）。
2. 读取目标 active `spec.md`（`Type: spec`、`Status: spec-ready`，跳过 `.x-matt/work/shipped/`）及同目录下全部 `issues/*.md`。
3. 校验依赖图：所有 blocker 为本 feature 内真实 ticket，无循环依赖；已 `resolved` 的 ticket 核对 `Implementation commit` 属于当前 `HEAD` ancestry。
4. 检查 `git status` 干净（不含 ignored 本地资料），记录整批起始 `fixedPoint`（新批次取当前 `HEAD` SHA；续跑时取首个实现提交前的原始 `fixedPoint`）。
5. 简明列出待执行 tickets 顺序与各票主要验证命令后直接连续推进，不重复停下询问确认；仅在工作区不干净、依赖异常或续跑缺少基线时暂停澄清。

## 串行逐票循环

每轮从 frontier（`ready-for-agent` 且所有 blockers 已 `resolved`）按编号顺序取第一张 ticket：

1. 完整应用 `matt-implement`：调用 `matt-tdd` + 聚焦 `verifyCommands` → 核对 `git diff --stat` 与验收条款 → 提交到当前分支 → 本地写回 `Status: resolved` 与 `Implementation commit: <SHA>`。
2. 逐票阶段默认不跑独立 reviewer，也不重复跑耗时全量套件；如某票属于高风险改动，可按需补跑单票 `matt-code-review`。
3. 某票遇阻（测试持续失败或需产品决定）时暂停并向用户报告当前进度、已完成提交与阻塞点，不跳票、不回滚。

## 整批收尾与集成评审

全部 tickets 均为 `resolved` / `out-of-scope` 后：

1. 运行项目完整测试套件与全量 typecheck/build；如有失败先定位修复。
2. 调用一次 `pi_matt_dispatch` 的 `matt-code-review`，传入 `reviewScope: { kind: "committed", fixedPoint: "<起始 SHA>" }`：
   - `laneTasks.spec` 提供完整 active parent spec 与聚合验收清单；
   - `laneTasks.standards` 提供适用工程规范与隐私/安全关注点。
3. 将建议型双轴报告整理呈现给用户（区分 P0/P1 与 P2 建议），由用户决定是否做针对性修补或直接结束交付。

不自动将 parent spec 改为 `shipped`、不调用 `matt-archive`、不 push 或开 PR；归档由用户后续显式运行 `/skill:matt-archive`。
