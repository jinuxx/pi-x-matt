---
name: improve-codebase-architecture
description: 只读扫描近期或用户指定范围中的 shallow modules，生成 OS temp 可视化 deepening report，并在用户选择后通过 grilling 形成可进入 to-spec 的架构决定。
disable-model-invocation: true
metadata:
  pi-scope: parent
  pi-class: interaction
  pi-dispatch: none
  pi-depends-on: grilling, domain-modeling
  pi-upstream-path: skills/engineering/improve-codebase-architecture/SKILL.md
  pi-upstream-sha: 6654f6b60cd9d5be8b54c6fafe44346dabeb3b76
---

# Improve Codebase Architecture

本 skill 是手动调用的 architecture survey，不是 refactor runner。一次运行只生成 OS temp HTML report，并最多深入一个用户选择的 candidate；不修改生产代码、不写 tests、不创建 implementation tickets、不进入 `implement`。选定并确认的 deepening decision 后续重新进入 `to-spec → to-tickets → implement`。

开始时完整读取并应用 [grilling](../grilling/SKILL.md) 与 [domain-modeling](../domain-modeling/SKILL.md)。父会话拥有 scope、candidate choice、HITL 和领域文档写入；`architecture-scan` 的唯一 worker 只写 temp report；`architecture-design` 的三个 reader 只返回 interface proposals。

## Vocabulary

所有建议只使用：**module**、**interface**、**implementation**、**depth/deep/shallow**、**seam**、**adapter**、**leverage**、**locality**。interface 同时是 caller surface 与 test surface。一个 adapter 是 hypothetical seam；只有 production/test 等至少两个真实 adapters 才说明 real seam。领域名称来自 `CONTEXT.md`；不要用 component/service/API/boundary 替代上述架构含义。

## Scope gate

1. 记录 `HEAD`、branch、`git status` 与 staged/untracked files。允许已有用户改动，但必须逐文件记录，scan 全程不得改变；报告需说明它观察的是当前 worktree 还是 HEAD。
2. 读取 `CONTEXT-MAP.md`/`CONTEXT.md`、相关 ADR、项目说明、测试布局和用户给出的未来 change direction。
3. 用户指定 module/subsystem/pain point/spec 时直接采用该 scope，不做全库巡检。
4. 未指定方向时读取足够的 `git log --oneline --name-only`，找反复变化的 hot paths；有清晰热点就限于这些路径，变化分散才扩大。不要扫描 dormant 代码来凑候选。
5. 向用户简短报告 scope 与依据。scope 过大、monorepo context 不明或与 ADR 归属冲突时使用 `ask_user_question` 确认；否则直接进行只读 scan。

## Scan and report

调用 `pi_matt_dispatch`：

- `workflow`: `architecture-scan`
- `task`: 包含 fixed HEAD、完整初始 status、精确 scope/hot-spot evidence、future change direction、领域文档/ADR、测试线索、OS temp 规则、禁止 repo 写入与停止条件。

只消费 `scan` lane 的 `structuredOutput`。缺失 lane、schema 无效、status 非 `REPORTED`、reportPath/scopeEvidence/commands 为空、reportPath 位于 repository 内、普通 prose 冒充结果或 scan 后 repository status 不一致时 fail closed。

父会话读取 HTML 与 candidate evidence，确认每项都：

- 指向真实 files/callers/tests；
- 解释 shallow interface 或 locality/seam friction；
- 通过 deletion test：删除 shallow module 会把复杂度集中到更小 interface 后方，而不是散到 callers；
- 有 dependency category 与可观察 test-surface 收益；
- ADR conflict 只在真实 friction 足以重开时明确标注；
- 尚未提出具体 interface。

报告应位于 `$TMPDIR`（无值则 `/tmp` 或 `%TEMP%`），路径形如 `architecture-review-<timestamp>.html`。父会话用平台命令或可用浏览器打开，并告诉用户绝对路径；若 CDN/浏览器策略导致样式或 Mermaid 失败，要求 scan 使用 inline CSS/SVG fallback 重新生成，不把 raw/unrendered HTML 说成可视化成功。

没有 candidate 是合法结果：报告应明确“未发现通过 deletion test 的候选”，然后停止。若只有 `Speculative`，说明证据弱，不把 top recommendation 冒充必要工作。

## Candidate selection

先展示报告摘要与 top recommendation，再使用一次 `ask_user_question`：最多列出前三个有证据的 candidates，另一个选项是“只保留报告，暂不探索”。candidate 选项使用标题而非 id/path，并说明 recommendation strength 与核心 trade-off；其他 candidate 可由用户通过自定义输入按标题选择。

用户选择“只保留报告”时立即结束，不进入 grilling。用户选择 candidate 后固定一个且仅一个；本 session 不顺手处理第二个。

## Grilling loop

围绕选定 candidate 应用 `grilling` decision tree，依次确认：

- 哪些 future changes/bugs 证明它值得现在 deepening；
- 哪些 responsibility 必须在新 module 后方，哪些仍属于 callers；
- dependency category、real adapters 与 seam placement；
- 哪个 interface-level observable behaviour 构成 test surface；
- 哪些旧 shallow tests 在新 interface tests 覆盖后可删除；
- migration boundary、明确 out of scope 与风险。

不要在用户确认前设计最终 interface。每轮只问当前 frontier 的 1–4 个问题。术语形成时按 `domain-modeling` 即时更新 `CONTEXT.md`；candidate 若与 ADR 冲突，明确引用。用户以长期、load-bearing 原因拒绝 candidate 时，按三项 ADR gate 询问是否记录，以免未来 scan 重复建议；“现在不值得”一类临时原因不写 ADR。

## Design it twice

只有用户已经选择 candidate、constraints/callers/dependency category/seam evidence 已确认，并明确想比较 alternative interfaces 时才进入：

1. 先展示中立问题空间：所有方案必须满足的 constraints、依赖类别、真实 adapters，以及一个只用于 grounding 的粗略 code sketch；说明 sketch 不是 proposal。
2. 调用 `pi_matt_dispatch`：
   - `workflow`: `architecture-design`
   - `task`: 包含 candidate、files/callers evidence、确认 constraints、领域词汇、dependency category、seam/adapters、test surface、禁止范围和停止条件。
3. 只消费 `minimal`、`flexible`、`common-caller` 三个 fresh reader lane 的 `structuredOutput`。数量/key/status/entries/tradeoffs 任一缺失即 fail closed；不得用两个方案冒充 design-it-twice。
4. 顺序展示每个 interface、usage、隐藏的 implementation、dependency strategy 与 trade-offs，再以 depth、locality、seam placement 横向比较。给出有立场的推荐；元素可组合时提议 hybrid，但不得替用户确认。
5. 使用 `ask_user_question` 让用户选择一个方案、hybrid、继续澄清或拒绝当前 candidate。未确认前保持 frontier 未完成。

三个 readers 永远只读，不能修改 code、tests、`CONTEXT.md` 或 ADR。领域文档仍由父会话唯一写入。

## Shared decision gate

frontier 清空后向用户汇总：candidate title、evidence、通过 deletion test 的理由、最终 module responsibility、interface/test surface、dependency strategy/adapters、migration boundary、rejected alternatives、领域文档/ADR 变化与 residual risks。使用 `ask_user_question` 请求明确确认。

确认后只形成 decision handoff：

- 报告绝对路径只属于当前机器/会话，不作为跨会话唯一证据；
- 跨 session 时将选定 candidate 的 files/evidence/problem/solution/deletion test 与最终决定写入用户指定的 spec/tracker 流程，不能仅依赖 temp report；
- 决定仍需进入 `to-spec`，再由 `to-tickets` 切 tracer-bullet slices，并由 `implement` 执行 TDD/review；
- 本 skill 不修改生产代码、不提交 refactor、不把 HTML 写入 repo。

任何 scan/report schema 缺失、repo 被 child 修改、candidate 无 deletion-test evidence、用户未选/未确认、design lanes 不完整、领域冲突未解决或需要扩大权限时保持未完成并停止。
