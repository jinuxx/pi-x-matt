---
name: matt-prototype
description: 为一个无法仅靠讨论解决的设计问题构建 throwaway prototype：逻辑/状态使用单文件 HTML，UI 使用真实页面上下文中的多方案切换。用于探索要构建什么，不用于修 bug 或实现已确定需求。
metadata:
  pi-scope: parent
  pi-class: orchestration
  pi-upstream-path: skills/engineering/prototype/SKILL.md
  pi-upstream-sha: 3cca18b368ae95cdbdebbff572ccafa662551015
---

# Prototype

Prototype 是**回答一个设计问题的 throwaway code**。只有问题无法通过 `matt-grilling` 直接决定、且答案必须看见或运行具体 artifact 才触发；已经知道要构建什么时进入 `matt-implement`，已构建功能出错时进入 `matt-diagnosing-bugs`。一次 invocation 只回答一个问题，不原型化整套产品。

父会话拥有 question/branch 确认、HITL 评审、verdict 和 branch capture；`matt-prototype` workflow 的唯一 `matt-worker` 只构建批准 artifact，不创建 branch、不 commit、不 stage、不 push。父会话与 worker 不并行写同一工作区，任何时刻只运行一个 prototype worker。

## Question gate

先读取相关代码、项目说明、`.x-matt/context/`、`.x-matt/adr/`、当前 tracker/map ticket 和真实 route/module。把 design question 收敛为一句可由 artifact 回答的话，并判断 branch：

- **Logic**：状态模型、业务规则、transition、data shape 或 API surface 是否符合预期。
- **UI**：页面/组件应采用什么 layout、information hierarchy 或 primary interaction。

问题含糊、同时跨两类或范围超过一次短原型时，使用 `ask_user_question` 让用户选择或拆分；不得按 surrounding code 静默默认。展示唯一 question、branch、预期 artifact、允许文件和 review 方式，取得明确确认后才调度 worker。

## Workspace gate

1. 记录当前 branch、`HEAD`、`git status`、staged files 和用户既有改动。禁止在 detached HEAD、merge/rebase/cherry-pick 中启动。
2. 默认要求干净工作区。Wayfinder 调用时允许保留已声明的 map/ticket claim 改动，但必须逐文件记录为 caller-owned，worker 和后续 prototype commit 都不得暂存它们。
3. 任何 prototype 允许文件若已有用户改动，或存在未声明的 staged/untracked 文件，停止并建议用户清理或在专用 worktree 重新调用；不得 stash、reset、checkout 或覆盖。
4. 选择遵循项目 convention、名称显式含 `matt-prototype` 的 artifact 路径。UI 优先嵌入现有 route/page；只有没有自然 host 时才创建 throwaway route。Logic 必须是一个自包含 HTML 文件。
5. 固定 capture branch 名 `prototype/<slug>`。本地 branch 已存在时停止并请求新 slug；不得 force、delete、push 或复用未知 branch。

## Artifact rules

共同规则：只使用已安装依赖；不加 package；内存/stub 优先；不得访问生产数据库、真实写 API、secrets 或外部 mutation；不写 tests、不做生产级错误处理/抽象；只运行最小 syntax/compile/load check。artifact 必须清楚标记 prototype，启动不需要猜测，并在每次 action/variant switch 后呈现相关状态。

### Logic

完整应用私有 `prototype-logic`：生成一个双击即可打开的 HTML/CSS/JS 文件。顶部可见 question；纯 reducer/state machine/functions 与 DOM shell 分离；提供领域语言 state panel、free-play actions 和可重置的 tabbed guided walkthroughs。用户应能在不读代码的情况下验证 happy path、关键 edge case 与非法操作。

### UI

完整应用私有 `prototype-ui`：默认 3、最多 5 个结构显著不同的 variants，使用项目现有 UI system。在同一 route 通过 `?variant=` 和 bottom switcher 切换，优先保留真实只读数据上下文；不得连接真实 mutation。方向键切换不能拦截输入控件，switcher 在 production build 必须隐藏。用户本人选择/组合方案，agent 不得宣布 winner。

## Build dispatch

调用 `pi_matt_dispatch`：

- `workflow`: `matt-prototype`
- `task`: 包含已确认 question、`logic`/`ui` branch、fixed HEAD、原 branch、caller-owned 改动、允许文件、host route/module、现有依赖、最小运行/加载命令、review targets、禁止范围和停止条件。

只消费 `matt-prototype` lane 的 `structuredOutput`。lane 缺失、status 不是 `BUILT`、artifactPaths/runInstructions/reviewTargets/changedFiles/commands/cleanupPlan 任一为空或普通 prose 冒充结构化结果时 fail closed；不要把 worker 自评当成用户 verdict。

## Runnable verification

worker 返回后，父会话先读取真实 diff，确认只包含批准 artifact 和必要的 prototype-only wiring，caller-owned 文件未被改动或暂存。然后实际执行 `runInstructions`：

- Logic：在浏览器中打开自包含 HTML，核对 free-play、每个 walkthrough reset、action 后状态与非法操作呈现。
- UI：启动项目现有开发命令，在真实 host context 中逐个打开 `?variant=` URL，核对 variants 结构差异、switcher、键盘行为、read-only/stub mutation 与 production hide gate。

使用可用浏览器工具做 load/interaction verification；工具不可用时把准确路径/URL 交给用户手动打开，但不得声称已自动验证。运行失败、页面空白、控制台关键错误、variant 不可区分或改动越界时停止；只可在用户确认原 question/scope 不变后顺序重跑一个 worker 修正。

## HITL verdict

展示 question、artifact/URL、每个 walkthrough 或 variant 的差异和已验证限制。使用 `ask_user_question`：

- Logic：让用户选择“模型符合预期”“需要按具体反馈修订”“模型方向不成立”。
- UI：把 3–4 个 variants 作为选项；若有 5 个，先让用户淘汰到最多 4 个再使用工具。用户可通过自动提供的自定义输入组合方案或描述修改。

用户未实际查看 artifact、没有给 verdict 或要求改变 design question 时，不得宣称完成。原 question 内的小修订可以再次顺序 dispatch；新问题必须结束当前 prototype，另开 invocation。

## Capture on a throwaway branch

用户给出 verdict 后，prototype artifact 作为 primary source 留在本地 branch，不进入原 branch：

1. 再次核对当前 branch/HEAD、caller-owned 改动、artifact diff 和 staged files；出现并发变化时停止。
2. 从当前原 branch 创建未占用的 `prototype/<slug>`，只暂存 worker 报告的 `artifactPaths`/`changedFiles`，逐项确认没有 caller-owned 文件、secret、真实数据或无关生成物。
3. 使用 `docs: 保存<问题简述>原型证据` 提交 artifact；不 push、不建 PR、不把 prototype branch merge 回原 branch。
4. 切回原 branch。禁止 stash/reset；切换失败时报告当前位置并停止，不伪称清理完成。
5. 核对原 branch 中所有 prototype diff 已消失，caller-owned 改动保持原样；记录 branch、commit SHA、question、verdict、run instructions 和 artifact paths 作为 context pointer。

如果 prototype 改动无法与 caller-owned 文件分离、branch 创建/提交/切回失败或原 branch 仍残留 artifact，保持未完成并请求人工处理。不得为“清理”删除用户工作。

## Return to caller

- Wayfinder 调用：把 context pointer、用户 verdict、理由、被拒 variants/scenarios 和 remaining unknowns 交回当前 decision ticket 的 resolve protocol；prototype 自己不改 map/status。
- `matt-grill-with-docs` 调用：把 verdict 作为用户确认的设计证据放回 decision tree，必要时按 `matt-domain-modeling` gate 更新术语/ADR。
- 独立调用：在当前会话报告 pointer；需要跨 session 进入实现时，用户明确指定 tracker/note 目标后再持久化答案。

生产实现始终重新进入 `matt-to-spec`/`implement → tdd → code-review`。prototype 没有 RED/GREEN、没有生产 review，不能直接 promote、cherry-pick 或复制到生产；已验证的 pure logic/API shape 只能作为后续明确决策，由实现阶段按生产标准重写。

## Completion gate

只有以下全部满足才完成：唯一 question 与 branch 经用户确认；唯一 worker 返回有效 `BUILT`；artifact 实际 runnable；用户本人给出 verdict；prototype commit 只存在于本地 `prototype/<slug>`；原 branch 无 prototype 残留；context pointer 可核验；无 push、真实 mutation、secret 或 caller-owned 改动。否则返回阻塞点，不把“文件已生成”当成问题已回答。
