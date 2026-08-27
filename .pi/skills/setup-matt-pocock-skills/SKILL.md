---
name: setup-matt-pocock-skills
description: 为当前仓库配置 issue tracker、ready-for-agent 标签词汇和领域文档布局，使规格与 tickets 发布链可执行。
disable-model-invocation: true
metadata:
  pi-scope: parent
  pi-class: interaction
  pi-dispatch: none
  pi-depends-on: ""
  pi-upstream-path: skills/engineering/setup-matt-pocock-skills/SKILL.md
  pi-upstream-sha: 6654f6b60cd9d5be8b54c6fafe44346dabeb3b76
---

# Setup Matt Pocock Skills

本 skill 是 Pi-only 的一次性仓库配置流程，必须留在当前父会话中执行。它只建立其他 skills 读取的项目内 Markdown 契约，不启动 subagent、不修改 skill 文件、不猜测 tracker，也不创建远端 issue、label 或其他外部资源。

## 探索

写入前读取真实仓库状态：

1. `git remote -v` 与 `.git/config`，识别 GitHub、GitLab 或无 remote；不要仅凭目录名推断。
2. 根目录 `AGENTS.md`；Pi-only 移植不读取或创建 `CLAUDE.md`。
3. `docs/agents/`、`.scratch/`、`CONTEXT.md`、`CONTEXT-MAP.md`、`docs/adr/` 与 context-scoped ADR 目录。
4. registry 是否已登记 `triage` 与 `wayfinder`。即使尚未移植 triage，`to-spec` 与 `to-tickets` 仍需要 `ready-for-agent` 映射；wayfinder 已登记时 tracker 契约还必须包含可执行的 Wayfinding operations。
5. `pnpm-workspace.yaml`、`package.json#workspaces` 和真实的多包目录，只在证据充分时判断为 multi-context。

先总结已存在、缺失和可能复用的配置。已有 `docs/agents/*.md` 时按更新处理，保留用户自定义内容，不从头覆盖。

## 分段决策

每节只问一个问题，使用 `ask_user_question`，并把有仓库证据的推荐项放在第一位。

### A. Issue tracker

必须由用户确认 issues 的实际存储位置：

- GitHub remote：推荐 GitHub，使用 `gh`。
- GitLab remote：推荐 GitLab，使用 `glab`。
- 无可识别 remote：推荐 Local Markdown，写入 `.scratch/<feature-slug>/`。
- Other：要求用户提供一段可执行说明，至少包含 create、read、label/status、blocking relationship 和结果核验方式。

选择 GitHub/GitLab 时先只读核验 CLI、认证和 remote 解析；失败时保持未配置，不写一个看似可用的契约。不得以 setup 名义创建远端 issue、label、project 或 repository。

### B. Label vocabulary

询问是否保留 canonical labels，推荐是：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。用户拒绝时收集现有 tracker 中的实际映射。该文件只定义语义映射，不创建远端 labels；GitHub/GitLab 缺少 `ready-for-agent` 时必须报告下游发布仍会 fail closed。

即使 `triage` 尚未登记，也要写 `docs/agents/triage-labels.md`，因为 `to-spec`、`to-tickets` 和 Local Markdown lifecycle 需要区分 `spec-ready`、`ready-for-agent` 与 `resolved`。`spec-ready` 与 `resolved` 是非 triage 的 lifecycle 状态；`ready-for-agent` 是 canonical triage role，也是可实现 ticket 的入口状态。

### C. Domain docs

没有真实 monorepo signals 时直接采用 single-context：根目录按需创建 `CONTEXT.md`，ADR 位于 `docs/adr/`；setup 本身不创建空 glossary 或 ADR。只有发现真实多 context 时才询问是否采用根 `CONTEXT-MAP.md` 与各 context 的 `CONTEXT.md`/`docs/adr/`。

### D. Pi instruction file

根目录已有 `AGENTS.md` 时更新其中唯一的 `## Agent skills` block。不存在时询问是否创建项目级 `AGENTS.md`；用户拒绝则只写 `docs/agents/`，并明确 Pi 不会自动获得这些入口说明。不得编辑用户级 `~/.pi/agent/AGENTS.md`。

## 写入前确认

展示完整 draft 并取得一次明确批准，至少包括：

- `AGENTS.md` 中将新增或替换的 `## Agent skills` block；
- `docs/agents/issue-tracker.md`；
- `docs/agents/triage-labels.md`；
- `docs/agents/domain.md`。

用户要求修改时更新 draft 并再次确认；批准前不得写文件。

`AGENTS.md` block 使用：

```markdown
## Agent skills

### Issue tracker

<issues 存储位置的一行摘要>。见 `docs/agents/issue-tracker.md`。

### Triage labels

<canonical role 到实际 label/status 的一行摘要>。见 `docs/agents/triage-labels.md`。

### Domain docs

<single-context 或 multi-context 的一行摘要>。见 `docs/agents/domain.md`。
```

## 配置内容

issue tracker 文档以 vendored seed 为行为基准：

- GitHub：`vendor/mattpocock-skills/skills/engineering/setup-matt-pocock-skills/issue-tracker-github.md`
- GitLab：`vendor/mattpocock-skills/skills/engineering/setup-matt-pocock-skills/issue-tracker-gitlab.md`
- Local Markdown：`vendor/mattpocock-skills/skills/engineering/setup-matt-pocock-skills/issue-tracker-local.md`
- Domain：`vendor/mattpocock-skills/skills/engineering/setup-matt-pocock-skills/domain.md`

读取选中的完整 seed 后再生成目标文件，不凭记忆缩写。只保留当前已移植能力需要且可执行的约定；`triage` 尚未移植，可以标注为未来约定，但不得声称当前可调用。`wayfinder` 已移植，配置不得省略它需要的 map、child decision ticket、blocking、frontier、claim、release、resolve、out-of-scope、fog graduation 和结果核验操作。

Local Markdown 至少定义：spec 路径、每 implementation ticket 文件路径、`Type`、`Parent`、`Status`、`Blocked by`、comments 和发布后读取核验；parent spec 使用 `spec-ready`，可实现 ticket 使用 `ready-for-agent`，完成 ticket 使用 `resolved`，并明确由 implement 父会话在最终提交中写回完成状态。Wayfinding artifacts 使用独立的 map 与 decision-ticket 路径，避免和 implementation `issues/` 冲突，并定义 `active`/`cleared` map、`open`/`claimed`/`resolved`/`out-of-scope` decision 生命周期及 claim identity。GitHub/GitLab 至少定义：CLI、repo 解析、create/read、label、native blocking/sub-issue 优先级、fallback body reference、Wayfinding operations 和发布后查询核验。Other 必须达到同等可执行程度，否则停止。

## 写入与验证

1. 对批准文件做小范围写入；`AGENTS.md` block 已存在时原位更新，不追加重复 section。
2. 重新读取全部目标文件，核对 tracker 类型、路径/remote、label mapping、domain layout 和互相引用。
3. Local Markdown 不预先创建 `.scratch` feature；GitHub/GitLab 只执行只读 CLI/auth/repo/label 核验。
4. 缺少 CLI、认证、remote、必要 label、可执行 Other workflow 或任一目标文件核验失败时，明确列为未完成；不得告诉下游 tracker 已配置。
5. 成功时报告修改文件，并说明 `to-spec` 与 `to-tickets` 现在会读取这些契约。日后切换 tracker 或布局时重新运行本 skill；普通文字调整可直接编辑 `docs/agents/*.md`。
