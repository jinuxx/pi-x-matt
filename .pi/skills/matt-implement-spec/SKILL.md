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
4. 检查 `git status` 干净（不含 ignored 本地资料），记录整批评审起始提交（`fixedPoint`）：新批次取当前 `HEAD` SHA；续跑时从所有已 `resolved` ticket 的 `Implementation commit` 中取 Git 祖先历史上最早提交的第一父提交（`<commit>^1`）作为默认起点并在开场汇报中一句话说明，无需停下询问。
5. 简明列出待执行 tickets 顺序、评审起点与各票主要验证命令后直接连续推进，不重复停下询问确认；仅在工作区不干净、依赖异常，或续跑时最早提交无父提交（根提交）/历史分叉导致无法确定评审起点时暂停澄清。向用户说明或澄清时使用通俗中文，不直接抛出 `fixedPoint` 等内部字段名。

## 串行逐票循环

每轮从 frontier（`ready-for-agent` 且所有 blockers 已 `resolved`）按编号顺序取第一张 ticket：

1. 完整应用 `matt-implement`：调用 `matt-tdd` + 聚焦 `verifyCommands` → 核对 `git diff --stat` 与验收条款 → 提交到当前分支 → 本地写回 `Status: resolved` 与 `Implementation commit: <SHA>`。
2. 逐票阶段默认 **0 次独立评审**，也不重复跑耗时全量套件；仅在某票涉及鉴权、资金或不可逆迁移等极端高风险时才可按需补跑**最多 1 次**单票 `matt-code-review`，禁止单票二次复审。确认要修的 P0/P1 合并为 1 轮修完（满足 ≤ 3 文件小修条件时由父会话直修），P2 记入整批汇总，不擅自多轮返工。
3. 某票遇阻（测试持续失败、需产品决定，或触发无人值守轮次软刹车）时暂停并向用户用大白话报告当前进度、已完成提交与剩余风险（触发条件、最坏后果、改动量），不改票据为 `blocked`、不跳票、不回滚，待用户回复后继续。

## 整批收尾与集成评审

全部 tickets 均为 `resolved` / `out-of-scope` 后，**先核对本节再收工**（避免长会话压缩后遗漏；未完成本节前不要宣布整批结束）：

1. 运行项目完整测试套件（或跨全票联合回归）与全量 typecheck/build；如有失败先定位修复。
2. 调用 `pi_matt_dispatch` 的 `matt-code-review`，传入 `reviewScope: { kind: "committed", fixedPoint: "<起始 SHA>" }`（若整批超过 5 票或改动量极大，可按业务阶段拆分为 2~3 次连续提交区间分别评审，避免单份 diff 过巨影响质量）：
   - `laneTasks.spec` 提供完整 active parent spec 与聚合验收清单；
   - `laneTasks.standards` 提供适用工程规范与隐私/安全关注点。
3. 将建议型双轴报告整理呈现给用户（区分 P0/P1 与 P2 建议），由用户决定是否做针对性修补或直接结束交付。

不自动将 parent spec 改为 `shipped`、不调用 `matt-archive`、不 push 或开 PR；归档由用户后续显式运行 `/skill:matt-archive`。
