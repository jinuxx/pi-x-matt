---
name: wayfinder
description: 把单个会话容纳不下且路线仍模糊的大型工作，规划为 tracker 上的共享决策地图，并每个会话最多解决一个 frontier ticket，直到可以交给 to-spec。
disable-model-invocation: true
metadata:
  pi-scope: parent
  pi-class: interaction
  pi-dispatch: none
  pi-depends-on: grilling, domain-modeling, to-spec
  pi-upstream-path: skills/engineering/wayfinder/SKILL.md
  pi-upstream-sha: 6654f6b60cd9d5be8b54c6fafe44346dabeb3b76
---

# Wayfinder

本 skill 是手动调用的多会话规划入口，只适用于**目标可以命名、但到达目标的路线仍存在 fog，且无法装进一个 agent session** 的工作。单会话可澄清的工作使用 `grill-with-docs`；决定已经完成时直接进入 `to-spec`。Wayfinder 默认只形成决定，不交付 destination、不写生产实现、不创建 implementation tickets。

开始时完整读取 [grilling](../grilling/SKILL.md) 与 [domain-modeling](../domain-modeling/SKILL.md)。地图清空后才读取 [to-spec](../to-spec/SKILL.md)。父会话是 map、decision tickets、`CONTEXT.md` 与 ADR 的唯一写者；事实调查子代理保持只读。

## Tracker gate

先按根 `AGENTS.md` 指针读取 `docs/agents/issue-tracker.md`、`docs/agents/triage-labels.md` 和 `docs/agents/domain.md`。tracker 文档必须明确提供可执行的 **Wayfinding operations**：map、child decision ticket、blocking、frontier、claim、release、resolve、out-of-scope、fog graduation 与结果核验。任一操作缺失、CLI/auth/remote 无法只读核验或 tracker 未配置时停止，并建议运行 `setup-matt-pocock-skills`；不得自行猜测 GitHub、GitLab 或 Local Markdown，也不得沿用上游的隐式 local fallback。

所有 tracker 写入使用配置中的真实操作。外部 tracker 的 create/edit/assign/close 属外部写入，执行前必须取得明确授权；Local Markdown 是当前仓库内写入，可在用户明确调用本 skill 后按已确认 draft 执行。写后必须重新读取目标并核验。

## 共同词汇与不变量

- **Destination**：整张 map 完成时得到的 spec-ready 决策集、关键决定或明确 change boundary，不是当前 session 的结束点。
- **Decision ticket**：正文是一个可回答的问题；不是“构建 X”的 implementation slice。
- **Fog / Not yet specified**：在 destination 范围内、但现在还不能精确表述为问题的区域。
- **Frontier**：所有 open、unblocked、unclaimed child tickets，按 tracker 配置的稳定顺序排列。
- **Out of scope**：明确位于 destination 之外，不会从 fog 毕业。

人类可见叙述和 map 的 `Decisions so far` 始终使用 ticket **标题链接**，不得用裸编号、slug 或路径代替名称。完整答案只存在一个 ticket 中；map 仅保存一行 gist 和链接，不复制详情。open tickets 由 frontier query 得到，不列进 map body。

每个 decision ticket 只能是 `research`、`prototype`、`grilling`、`task`：

- `research`（AFK）：外部一手事实阻塞决定；调用已注册 `research` workflow，只消费 completion result 的 `structuredOutput`。
- `prototype`（HITL）：必须用具体 artifact 提高讨论 fidelity，并由用户本人选择或评价。若 registry 尚未登记 `prototype`，未 claim 的 ticket 保持 open；已 claim 的 ticket 按 tracker release 协议恢复 open/unclaimed 并核验，然后报告缺失。不得由 agent 自选方案或假装已调用。
- `grilling`（HITL）：默认类型；同时应用 `grilling` 与 `domain-modeling`，用户必须为自己一侧的决定发声。
- `task`（HITL/AFK）：只做阻塞某个决定的前置工作。若内容已经在交付 destination 或生产实现，说明 ticket 错型并停止。

除相互独立的 `research` tickets 外，一个 session 最多 resolve 一个 decision ticket。chart session 可以创建 map 和 tickets，但不得顺手解决 HITL ticket。

## Mode A：Chart the map

### 1. Name the destination

用 `grilling` 的 decision tree 与 `domain-modeling` 的术语/ADR 纪律，先确定 destination、范围、非目标和完成地图的可观察条件。使用 `ask_user_question` 取得明确确认；确认前不得创建 map 或 ticket。

### 2. Breadth-first frontier

再次 breadth-first grilling：横向找出当前已经能精确表述的问题、真实 blocking edges 与尚不能成题的 fog，不要深入解决某一分支。问题已经 sharp 就建 ticket，即使它当前 blocked；只有无法精确表述时才放进 `Not yet specified`。

若没有 fog、所有路线已清楚且整体可在一个 session 处理，停止并让用户选择 `grill-with-docs`、`to-spec` 或一个小型 `implement` slice；不要为了使用 Wayfinder 而创建空 map。

### 3. Approve and publish

先展示完整 draft：map title、Destination、Notes、Not yet specified、Out of scope、每张 decision ticket 的标题/Question/Type、blocking graph 与初始 frontier。使用一次 `ask_user_question` 让用户批准、修改或取消。Notes 不得由 agent 自行加入“允许执行 destination”的授权；任何执行 override 必须由用户明确批准并记录其边界，即便有 override 也不能绕过项目的外部写入或生产控制确认。

批准后按 tracker 契约：

1. 创建 map，`Decisions so far` 初始为空；
2. 第一遍创建所有当前可精确表述的 child tickets，取得真实 identity；
3. 第二遍写 blocking edges；
4. 重新读取 map、tickets、parent/child、types、statuses 和 edges，计算并展示 frontier；
5. 对每个初始 `research` ticket，先按 tracker claim 协议读取非空 `PI_SESSION_ID`、写入 `pi:<PI_SESSION_ID>` 并核验，再分别调用 `pi_matt_dispatch` 的 `research` workflow。缺失 identity 时不得 claim；lane 缺失、失败或无效 `structuredOutput` 时按 tracker release 协议恢复 open/unclaimed；有效结果由父会话按 resolve 协议写入。普通 prose output 不能作为答案。

charting 完成后停止，不进入第一个 HITL ticket。

## Mode B：Work through the map

用户必须提供 map 的可核验 reference；Local Markdown 使用仓库相对 `map.md` 路径，不凭 effort 名、编号或相似标题猜测。每次 session：

1. 只加载 map 的 low-resolution body 和 child metadata，不预加载全部答案。核对 destination、Notes、Status、parent links、ticket type 和 map 身份。
2. 若用户指定 ticket，确认它属于该 map、仍 open、unblocked、unclaimed；否则按 tracker 的 frontier 顺序选第一张。没有 frontier 但仍有 open/claimed/fog 时报告具体阻塞，不猜下一步。
3. **先 claim，再工作**。按 tracker 操作读取非空 `PI_SESSION_ID`，只使用 `pi:<PI_SESSION_ID>` 作为稳定 claim identity；缺失时 fail closed。写前与写后都重新读取。若期间状态、claim 或 blockers 改变，停止并报告并发冲突，不覆盖其他 session。
4. 只读取当前 ticket 的完整 Question，以及证明相关性所需的 linked decisions。不要把整张历史重新灌入上下文。
5. 按 ticket type 解决：
   - `grilling`：执行 live `grilling` + `domain-modeling`，用户确认答案前不得代答或 resolve；
   - `research`：调用 `research` workflow，只接受结构化来源与 gaps；多个 research 可并行，但分别 claim、核验和记录；
   - `prototype`：调用已登记的 `prototype`，或让用户提供并评价明确 artifact；resolver 不可用时按 tracker release 协议恢复 open/unclaimed 并核验；
   - `task`：执行不交付 destination 的最小前置动作；需要用户动作时给精确 checklist，外部写入、购买、生产控制或敏感数据操作仍需明确确认。
6. 形成 Answer draft，包含决定/事实、理由、被拒绝方案、artifact/source pointers 与剩余未知。HITL ticket 使用 `ask_user_question` 请求用户确认 resolution；AFK ticket 由父会话核验一手证据和未知项。resolver 不可用、用户选择延期、证据无效或本 session 无法完成时，不得遗留自己的 claimed ticket：按 tracker release 协议恢复 open/unclaimed 并核验，然后停止。

## Resolve protocol

resolution 采用单一真相来源：

1. 重新读取 ticket、map 和 blockers；确认 claim 仍属于当前 session。
2. 把完整答案写入 ticket 的 resolution comment/`## Answer`，设为 resolved/closed；不要把答案复制进 map。
3. 在 map 的 `Decisions so far` 追加一行标题链接和一行以内 gist。
4. 检查本次答案是否让 fog 变成可精确问题：先起草新 tickets，取得必要 HITL 批准后第一遍创建、第二遍 wiring，再从 `Not yet specified` 删除已经毕业的同一 patch。不得让同一内容同时存在于 fog 与 ticket。
5. 若某项已越过 destination，关闭对应 ticket 并在 `Out of scope` 写标题链接、gist 与原因；不要加入 `Decisions so far`。若决定使其他 tickets 无效，更新或关闭它们，但不得静默改写已 resolved 的历史答案。
6. 重新读取所有本次写入，核验 status、answer、map pointer、fog removal、blocking 和 frontier。核验失败时保持未完成并停止。

完成这些步骤后停止本 session；除 research 例外，不选择下一张 ticket。

## Cleared-map gate

只有同时满足以下条件，map 才能从 active 改为 cleared：

- 所有 child tickets 都是 resolved 或明确 out-of-scope，没有 open、claimed 或未解析 blocker；
- `Not yet specified` 没有仍在 destination 范围内的 fog；
- 每个 resolved ticket 恰好有一个 `Decisions so far` 标题链接，每个 out-of-scope ticket 只在 `Out of scope` 出现；
- Destination 没有被 Notes 中未经用户批准的 execution override 改写；
- tracker 写后核验通过，且没有并发冲突。

清空后重新读取 `to-spec`，把 **cleared map reference**、`Decisions so far` pointers、相关 ticket answers、领域文档和 ADR 交给它综合。不要把 decision tickets 当成 implementation tickets，不要直接进入 `to-tickets` 或 `implement`，也不要在 Wayfinder 中生成 spec。报告地图已清空并停止，等待用户明确进入下一阶段。

## Fail-closed conditions

以下任一情况都保持 map/ticket 未完成：tracker operations 不完整；destination 未确认；无法取得或核验 claim；frontier 计算不唯一；research 无有效 `structuredOutput`；HITL 用户未确认；prototype resolver/asset 不可用；blocking、parent 或 title link 损坏；需要扩大权限；存在未持久化跨会话证据；或 map clear gate 未满足。不得以自然语言总结代替 tracker 状态。
