# pi-x-matt

`pi-x-matt` 将 [mattpocock/skills](https://github.com/mattpocock/skills) 中的方法论移植为纯 Pi Agent + pi-subagents 的项目级能力。它不提供 Claude Code、Codex 或其他 agent harness 的运行时兼容层。

当前已实现 tracker 配置、交互式需求到实现链、多会话 wayfinding、throwaway prototype 与 hard-bug 诊断入口，以及 9 个交互式 parent：`setup-matt-pocock-skills`、`grilling`、`domain-modeling`、`grill-with-docs`、`wayfinder`、`to-spec`、`to-tickets`、`implement`、`diagnosing-bugs`；另有 4 个执行型 parent：`research`、`prototype`、双轴 `code-review` 与分阶段 `tdd`。交互式 parent 在父会话中保留 HITL 决策，不通过后台 workflow 运行；执行型 parent 使用 pi-subagents lanes，其中 `prototype` 仍由父会话保留 question 与用户 verdict gate。

## 架构

系统分为三个边界：

1. **父会话 skill**：位于 `.pi/skills/`，负责识别任务、保留 HITL 决策、调用项目 dispatcher 和综合结果。交互式 parent（`setup-matt-pocock-skills`、`grilling`、`domain-modeling`、`grill-with-docs`、`wayfinder`、`to-spec`、`to-tickets`、`implement`、`diagnosing-bugs`）留在当前会话中，直接使用用户问答和受限调查；执行型 parent（`research`、`prototype`、`code-review`、`tdd`）通过 registry workflow 调度子代理。
2. **leaf agent**：位于 `.pi/agents/`，只完成一次明确委派。所有 agent 都设置 `inheritSkills: false`、私有 `skillPath` 和 `maxSubagentDepth: 0`，且工具列表不包含 `subagent`。
3. **私有 leaf skill**：位于 `skillpacks/leaf/`，不会进入父会话的 Pi skill catalog，只能由 agent 的 `skillPath` 解析，并由每次 launch 精确选择。

运行链路支持单 lane、并行 lane 和按 stage 顺序执行、stage 内并行的 pipeline：

```text
用户任务
  → 父会话读取 .pi/skills/<workflow>/SKILL.md
  → pi_matt_dispatch 校验 registry 与 workflow digest
  → 计算每个 lane 的 leaf 闭包
  → 通过 pi-subagents RPC 异步启动一个或多个 fresh worker/reviewer/researcher
  → 子代理读取私有 leaf skill 并按结构化 schema 返回结果
  → 父会话核验并综合结果
```

`research` 与 `prototype` 使用单 lane；`prototype` 只把 artifact 构建交给唯一 `worker`，question、浏览器评审、用户 verdict 和本地 throwaway branch capture 仍由父会话负责；`code-review` 使用相互独立的 `standards` 与 `spec` 两个 reviewer lane；`tdd` 先由唯一 `worker` 执行 red→green，再由两个 fresh reviewer 并行复核。`setup-matt-pocock-skills`、`grilling`、`domain-modeling`、`grill-with-docs`、`wayfinder`、`to-spec`、`to-tickets`、`implement` 和 `diagnosing-bugs` 是 `dispatch: none` 的 interaction parent：interaction parent 本身不定义 `workflow.json`，也不能作为 lane 直接传给 `pi_matt_dispatch`；它们可以在父会话中调用执行型 parent workflow。`setup-matt-pocock-skills` 负责项目级 tracker 与文档契约，`grilling`、`domain-modeling` 和 `grill-with-docs` 负责单会话澄清与共享文档，`wayfinder` 负责跨会话 decision map、fog 与 frontier，`to-spec` 负责 seam 确认与规格综合，`to-tickets` 负责 tracer-bullet 切分与 blocking edges，`implement` 在父会话中调用 `tdd` 和 `code-review`，负责单 ticket 的 TDD、验证、review 和当前分支提交；model-invoked 的 `diagnosing-bugs` 先在父会话中建立 red-capable loop、最小复现并验证根因，再把一个已确认 slice 顺序交给 `implement`。

## pi-subagents 最小加载

`.pi/settings.json` 使用 Pi package delta filter，只加载 `pi-subagents` 的 extension。`autoload: false` 会在用户级已安装同一 package 时复用该安装并应用项目过滤，避免用户级与项目级两个绝对路径各自注册 RPC bridge；若用户级未安装，则仍从项目安装中显式加载该 extension：

```json
{
  "packages": [
    {
      "source": "npm:pi-subagents",
      "autoload": false,
      "extensions": ["+index.ts"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ],
  "subagents": {
    "disableBuiltins": true,
    "projectRootResolution": "nearest",
    "agentOverrides": {
      "reviewer": {
        "model": "deepseek/deepseek-v4-pro",
        "thinking": "high"
      }
    }
  }
}
```

因此项目不会加载包内 `pi-subagents`/`council-mode` skills、prompt templates 或 builtin agents。项目只暴露四个自定义 agent；项目级 reviewer 固定使用 `deepseek/deepseek-v4-pro`、thinking `high`，worker 保持当前父会话模型：

| Agent | 权限 | 当前用途 |
| --- | --- | --- |
| `reader` | 本地只读 | 代码库探索 |
| `researcher` | `read`、`web_search`、`web_fetch` | `research` |
| `reviewer` | 本地只读 | `code-review` 与 `tdd` 的 Standards/Spec lanes |
| `worker` | 单写者工具集 | `tdd` 的 red→green 实现与 `prototype` artifact 构建 |

`researcher` 依赖父环境中已经注册的 `web_search` 与 `web_fetch` provider。显式 allowlist 不会自动加载 provider；若工具未注册，pi-subagents 应在 child 启动阶段失败，而不是生成无来源回答。

## Registry 与代码边界

每个 Pi-native `SKILL.md` 的标准 `metadata` 保存以下移植信息：

- `pi-scope`：`parent` 或 `leaf`
- `pi-class`：parent 为 `orchestration` 或 `interaction`；leaf 必须为 `executor` 或 `reviewer`
- `pi-agent`：唯一允许接收其 leaf 闭包的 agent（仅 leaf）
- `pi-dispatch`：执行型 parent 的 `workflow.json` 定义 `single`、`parallel` 或 `pipeline`；interaction parent 固定为 `none`
- `pi-depends-on`：执行型 parent 的 lane leaf 依赖，或 interaction parent 的 interaction parent 依赖
- `pi-upstream-path` / `pi-upstream-sha`：上游来源

运行：

```bash
npm run registry       # 生成 config/skill-registry.json
npm run registry -- --check
npm run drift          # 检查 vendored 上游是否影响已移植 skill
npm run test           # 聚焦测试
npm run check          # 测试 + registry freshness + upstream drift
```

生成器会拒绝重复名、保留名、未知 agent、缺失依赖、依赖环、父依赖、跨 agent 依赖、错误 scope/class/dispatch、越出 vendored upstream 根目录的来源路径和 SHA 漂移。执行型 parent workflow 还必须定义有效的 lane、封闭 object `outputSchema`、正数 `timeoutMs` 与 `turnBudget`；每个 workflow 至多包含一个 `acceptanceRole: writer` lane。interaction parent 必须没有 `workflow.json`，且只能依赖其他 interaction parent。pipeline 的 stage 必须从 1 连续编号；任何模式的 lane gate 都必须引用 schema 中声明的 enum 值，`code-review` 与 `tdd` 的 reviewer verdict 均由 gate 强制为 `PASS`；后续 stage 会收到前序 `structuredOutput` 作为可核验的过程证据。

项目 extension `.pi/extensions/pi-matt-dispatch/index.ts` 是规范调度入口。它在每次 dispatch 时重新验证 registry 中所有 port 的 source/workflow digest 和项目内路径，计算 leaf 闭包并校验 agent 绑定；工具调用只把已验证 plan 放入内存队列，随后在 `turn_end` 的有效 extension context 中通过 pi-subagents 进程内 RPC 发起异步 run。普通 prose output 被禁用；workflowScript 会核对每个 stage 的结果数量、lane key 与运行时 schema 捕获的 `structuredOutput`，缺失、错序或 gate 不满足时整个 workflow fail closed。不存在的 workflow、过期 registry、错误 scope、跨 agent skill 或不支持的 dispatch mode 同样会被拒绝。

工具 allowlist 是真实的能力边界；SKILL.md 中的文字不是沙箱。直接调用底层 `subagent` 仍是管理员级逃生口，因此本项目的父 skills 统一要求使用 `pi_matt_dispatch`。

## 当前使用方式

在本目录启动或 reload Pi，使 `.pi/settings.json`、project agents、skills 和 extension 生效：

```text
/reload
```

首次使用发布链前运行 `setup-matt-pocock-skills`，由用户确认 tracker、label mapping 和领域文档布局；它只在用户批准 draft 后写入 `docs/agents/*.md` 与可选的项目级 `AGENTS.md`，不会创建远端 issue 或 label。未完成 setup 时，`to-spec` 与 `to-tickets` 保持 fail closed。本仓库当前已配置 Local Markdown tracker，spec 与 tickets 写入 `.scratch/<feature-slug>/`；parent spec 使用 `spec-ready`，可实现 ticket 使用 `ready-for-agent`，完成后由 `implement` 在最终提交中写为 `resolved`。

需求尚未明确时，使用 `grill-with-docs`。它会在当前父会话中分轮询问 decision tree；事实由代码库或 `research` 调查，用户决定保留为用户决定；新术语即时写入 `CONTEXT.md`，符合三项 gate 的决定在用户同意后写入 ADR。单个 session 能澄清的工作在 shared understanding 后进入 `to-spec` 或一个 `implement` slice；目标可命名但路线仍有 fog、明显需要多个 session 时，手动进入 `wayfinder`。

讨论无法回答一个明确的状态/逻辑或 UI 设计问题时，使用 model-invoked `prototype`。父会话先确认唯一 question 与 logic/UI branch，再由单 worker 构建：logic 是可双击的单文件 HTML；UI 是真实页面上下文中通过 `?variant=` 切换的 3–5 个结构差异方案。用户本人给出 verdict 后，artifact 只提交到本地 `prototype/<slug>` branch，不合并、不 push；原 branch 只接收可核验 context pointer，生产实现仍进入 `to-spec`/`implement`。

`wayfinder` 先让用户确认整张 map 的 Destination，再 breadth-first 创建问题型 decision tickets、真实 blockers 与 `Not yet specified` fog。每个后续 session 先 claim frontier，再最多解决一张 HITL ticket；相互独立的 research tickets 是唯一并行例外。prototype ticket 调用上述 workflow，并在取得 artifact branch pointer 与用户 verdict 后才 resolve。Local Markdown 的 map 位于 `.scratch/<effort>/map.md`，decision tickets 位于独立 `decisions/`，不会和 implementation `issues/` 冲突。地图只有在所有决定 resolved/out-of-scope 且 fog 清空后才标记 cleared，并交给 `to-spec`；不得从 decision map 直接进入实现。

需求已经在当前会话中确认，或已有 cleared Wayfinder map 时，使用 `to-spec`。它不会重新访谈，而是先让用户确认最高测试 seam，再按当前会话或 linked decision answers、代码库、`CONTEXT.md`、ADR 和明确提供的 research note 综合规格；只有配置了 `docs/agents/issue-tracker.md`、用户确认 spec 且发布结果可核验时才发布 parent spec；Local Markdown 使用 `spec-ready`，remote tracker 使用 `ready-for-agent` 时必须让外部 runner 排除 parent spec，避免绕过 tickets 整体实现。随后使用 `to-tickets`，先让用户批准 tracer-bullet breakdown 和 blocking edges，再按 tracker 配置发布 tickets。每次使用 `implement` 只实现一个已确认 ticket，依次调用 TDD、完整验证和双轴 code-review，全部通过后提交当前 branch；当前没有实现批量 ticket 或 push/PR 的自动化。

具体 hard bug、间歇性失败或性能回归无法直接定位时，使用 model-invoked 的 `diagnosing-bugs`。它在任何理论之前强制建立一个已实际运行的 red-capable command，随后最小化 repro、让用户检查 3–4 个可证伪假设、用单变量 probe 确认根因并清理 `[DEBUG-<id>]` instrumentation。存在正确 regression seam 时，它把根因、循环命令和 seam 作为当前会话单 slice 交给 `implement`；没有正确 seam 时停止并报告架构缺口，不写浅层测试或直接修生产代码。

```json
{
  "workflow": "research",
  "task": "明确问题、时间边界、必需来源、输出格式与停止条件"
}
```

代码评审使用 `workflow: "code-review"`，task 中应包含目标、边界、fixed point/diff、标准来源、spec 来源和停止条件。

TDD 使用 `workflow: "tdd"`。调度前必须由用户确认公开 seam 与待验证行为；task 还要包含固定基线、既有工作区变化、允许范围和测试命令。`tdd-executor` 的依赖闭包会同时向 worker 授予 `codebase-design`，但 reviewer 只获得各自只读 review skill。

把 task 传给 `pi_matt_dispatch`。调度是异步的；父会话不应轮询等待，完成后由 pi-subagents 自动回传。父会话只消费 completion result 中每个 lane 的 `structuredOutput`，不解析普通 `output` 或 `outputReference`。

## 已验证行为

以下异步冒烟来自开发阶段的手工运行，不属于 `npm run check` 的离线测试；仓库内可复现的是 registry、dispatcher、权限与 gate 的聚焦测试。

- Research 单 lane 异步冒烟：成功加载私有 `research-executor`，调用 `web_search`/`web_fetch` 并生成 artifact。
- Code Review 并行冒烟：`standards` 与 `spec` 两个 reviewer 均以 fresh context 完成，分别生成结构化结果，且未修改项目文件。
- TDD pipeline 真实冒烟：worker 加载 `codebase-design` + `tdd-executor`，取得一轮真实 RED/GREEN；随后两个 fresh reviewer 只读复核。registry、依赖闭包、唯一写者、lane gate、stage 顺序与前序证据传递另有聚焦测试覆盖。

## 上游与许可证

上游快照位于 `vendor/mattpocock-skills/`，固定 commit 记录于 `vendor/UPSTREAM_SHA`。vendor 不在 Pi skill discovery 或 agent `skillPath` 中，但它是可追踪的项目源文件，并非路径级安全沙箱。

上游使用 MIT License，原文保留在 `vendor/mattpocock-skills/LICENSE`；归属说明见 `NOTICE.md`。

## 当前边界

当前刻意不实现万能 router、动态多写者、自动导入全部 skills 或跨 harness 兼容。TDD 遵循上游方法：refactor 不混入 red→green 循环；fresh review 发现需要重构时，由父会话取得授权后再启动下一次受限实现。
