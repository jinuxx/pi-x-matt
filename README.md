# pi-x-matt

`pi-x-matt` 将 [mattpocock/skills](https://github.com/mattpocock/skills) 中的方法论移植为纯 Pi Agent + pi-subagents 的项目级能力。它不提供 Claude Code、Codex 或其他 agent harness 的运行时兼容层。

当前已实现 tracker 配置、交互式需求到实现链、多会话 wayfinding、throwaway prototype、hard-bug 诊断与 architecture deepening survey，以及 10 个交互式 parent：`matt-setup`、`matt-grilling`、`matt-domain-modeling`、`matt-grill-with-docs`、`matt-wayfinder`、`matt-to-spec`、`matt-to-tickets`、`matt-implement`、`matt-diagnosing-bugs`、`matt-improve-codebase-architecture`；另有 6 个执行型 parent：`matt-research`、`matt-prototype`、`architecture-scan`、`architecture-design`、双轴 `matt-code-review` 与分阶段 `matt-tdd`。交互式 parent 在父会话中保留 HITL 决策，不通过后台 workflow 运行；执行型 parent 使用 pi-subagents lanes，其中 `matt-prototype` 与 architecture workflows 的用户选择仍留在父会话。

## 安装

要求已安装 Pi 与 Node.js 20 或更高版本。在目标代码库中先安装与项目绑定的子代理运行时和工具 provider，再安装本 package：

```bash
pi install -l npm:@ff-labs/pi-fff
pi install -l npm:@vanillagreen/pi-codex-minimal-tools
pi install -l npm:pi-subagents
pi install -l git:github.com/jinuxx/pi-x-matt@v0.2.7
```

`@ff-labs/pi-fff` 为本地代码子代理提供 `fffind` 与 `ffgrep`；`@vanillagreen/pi-codex-minimal-tools` 为 `matt-worker` 提供 `apply_patch`。后者仅在 OpenAI/Codex-like 模型上激活；其他模型仍使用原有 `edit`/`write`。

然后重启或 reload Pi：

```text
/reload
```

首次使用时手动运行 `matt-setup`，在父会话中选择 issue tracker（Local Markdown、GitHub 或 GitLab）并确认项目文档契约。package manifest 会自动加载 dispatcher、`matt-*` skills 和 `matt-*` agents；`pi-subagents` 作为 project-local 前置 package 加载。若目标项目已有 `pi-subagents`，不要再添加第二个 `pi-subagents` extension 路径，以免重复注册工具。若要保持最小加载，可把 `.pi/settings.json` 中的 `npm:pi-subagents` 字符串改为：

```json
{
  "source": "npm:pi-subagents",
  "autoload": false,
  "extensions": ["+index.ts"],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

不要把这份 object 与同一 package 的另一个 entry 并存。

安装包拥有 Pi package 的系统访问能力：`matt-worker` 可以在用户批准的范围内修改目标仓库，`matt-researcher` 可以访问配置的 web provider。安装前请审阅 source，升级时使用固定 tag：

```bash
pi update git:github.com/jinuxx/pi-x-matt@v0.2.7
```

## 架构

系统分为三个边界：

1. **父会话 skill**：位于 `.pi/skills/`，负责识别任务、保留 HITL 决策、调用项目 dispatcher 和综合结果。交互式 parent（`matt-setup`、`matt-grilling`、`matt-domain-modeling`、`matt-grill-with-docs`、`matt-wayfinder`、`matt-to-spec`、`matt-to-tickets`、`matt-implement`、`matt-diagnosing-bugs`、`matt-improve-codebase-architecture`）留在当前会话中，直接使用用户问答和受限调查；执行型 parent（`matt-research`、`matt-prototype`、`architecture-scan`、`architecture-design`、`matt-code-review`、`matt-tdd`）通过 registry workflow 调度子代理。
2. **leaf agent**：位于 `.pi/agents/`，只完成一次明确委派。所有 agent 都设置 `inheritSkills: false`、私有 `skillPath` 和 `maxSubagentDepth: 0`，且工具列表不包含 `subagent`。
3. **私有 leaf skill**：位于 `skillpacks/leaf/`，不会进入父会话的 Pi skill catalog，只能由 agent 的 `skillPath` 解析，并由每次 launch 精确选择。

作为 Git package 安装时，package root 负责保存和校验 `.pi/skills`、`skillpacks/leaf`、`config/skill-registry.json` 与上游快照；目标项目 root 提供代码、测试和统一的 `.x-matt/` 项目文档树。dispatcher 不再要求 package 文件出现在目标项目中，child 仍以目标项目 root 作为 `cwd`。

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

`matt-research`、`matt-prototype` 与 `architecture-scan` 使用单 lane；`architecture-design` 使用 minimal/flexible/common-caller 三个 fresh 只读 lane；`matt-prototype` 只把 artifact 构建交给唯一 `matt-worker`，`architecture-scan` 的 worker 只写 OS temp report；`matt-code-review` 使用相互独立的 `standards` 与 `spec` reviewer lanes；`matt-tdd` 先由唯一 `matt-worker` 执行 red→green，再由两个 fresh reviewer 并行复核。`matt-setup`、`matt-grilling`、`matt-domain-modeling`、`matt-grill-with-docs`、`matt-wayfinder`、`matt-to-spec`、`matt-to-tickets`、`matt-implement`、`matt-diagnosing-bugs` 和 `matt-improve-codebase-architecture` 是 `dispatch: none` 的 interaction parent：interaction parent 本身不定义 `workflow.json`，可以在父会话中调用执行型 workflow。`matt-improve-codebase-architecture` 先调用 `architecture-scan` 生成 temp report，用户选择 candidate 并 grilling 后，只有明确需要 alternative interfaces 才调用 `architecture-design`；它不修改生产代码。`matt-implement` 仍在父会话中调用 `matt-tdd` 和 `matt-code-review`，负责单 ticket 的实现、验证、review 与提交。

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
    "projectRootResolution": "nearest"
  }
}
```

因此本地开发配置不会加载包内 `pi-subagents`/`council-mode` skills、prompt templates 或 builtin agents。package manifest 只加载本 package 的 dispatcher，并只暴露四个 `matt-*` 自定义 agents；reviewer 默认继承用户当前模型，不要求 DeepSeek provider。`pi-subagents` 由上面的 project-local package 配置提供：

| Agent | 权限 | 当前用途 |
| --- | --- | --- |
| `matt-reader` | 本地只读 | 代码库探索与 `architecture-design` 三方案 lanes |
| `matt-researcher` | `read`、`web_search`、`web_fetch` | `matt-research` |
| `matt-reviewer` | 本地只读 | `matt-code-review` 与 `matt-tdd` 的 Standards/Spec lanes |
| `matt-worker` | 单写者工具集 | `matt-tdd` 实现、`matt-prototype` artifact 与 OS temp architecture report |

`matt-researcher` 依赖父环境中已经注册的 `web_search` 与 `web_fetch` provider。显式 allowlist 不会自动加载 provider；若工具未注册，pi-subagents 应在 child 启动阶段失败，而不是生成无来源回答。

## Registry 与代码边界

每个 Pi-native `SKILL.md` 的标准 `metadata` 保存以下移植信息：

- `pi-scope`：`parent` 或 `leaf`
- `pi-class`：parent 为 `orchestration` 或 `interaction`；leaf 必须为 `executor` 或 `reviewer`
- `pi-agent`：唯一允许接收其 leaf 闭包的 agent（仅 leaf）
- `pi-dispatch`：执行型 parent 的 `workflow.json` 定义 `single`、`parallel` 或 `pipeline`；interaction parent 固定为 `none`
- `pi-depends-on`：执行型 parent 的 lane leaf 依赖，或 interaction parent 的 interaction parent 依赖
- `pi-upstream-path` / `pi-upstream-sha`：上游来源

维护者运行：

```bash
npm run registry       # 生成 config/skill-registry.json
npm run registry -- --check
npm run drift          # 检查 vendored 上游是否影响已移植 skill
npm run test           # 聚焦测试
npm run check          # 测试 + registry freshness + upstream drift
npm run pack:check     # 检查 package 文件清单
```

生成器会拒绝重复名、保留名、未知 agent、缺失依赖、依赖环、父依赖、跨 agent 依赖、错误 scope/class/dispatch、越出 vendored upstream 根目录的来源路径和 SHA 漂移。执行型 parent workflow 还必须定义有效的 lane、封闭 object `outputSchema`、正数 `timeoutMs` 与 `turnBudget`；每个 workflow 至多包含一个 `acceptanceRole: writer` lane。interaction parent 必须没有 `workflow.json`，且只能依赖其他 interaction parent。pipeline 的 stage 必须从 1 连续编号；任何模式的 lane gate 都必须引用 schema 中声明的 enum 值，`matt-code-review` 与 `matt-tdd` 的 reviewer verdict 均由 gate 强制为 `PASS`；后续 stage 会收到前序 `structuredOutput` 作为可核验的过程证据。

项目 extension `.pi/extensions/pi-matt-dispatch/index.ts` 是规范调度入口。它在每次 dispatch 时重新验证 registry 中所有 port 的 source/workflow digest 和项目内路径，计算 leaf 闭包并校验 agent 绑定；工具调用只把已验证 plan 放入内存队列，随后在 `turn_end` 的有效 extension context 中通过 pi-subagents 进程内 RPC 发起异步 run。普通 prose output 被禁用；workflowScript 会核对每个 stage 的结果数量、lane key 与运行时 schema 捕获的 `structuredOutput`，缺失、错序或 gate 不满足时整个 workflow fail closed。不存在的 workflow、过期 registry、错误 scope、跨 agent skill 或不支持的 dispatch mode 同样会被拒绝。

工具 allowlist 是真实的能力边界；SKILL.md 中的文字不是沙箱。直接调用底层 `subagent` 仍是管理员级逃生口，因此本项目的父 skills 统一要求使用 `pi_matt_dispatch`。

## 当前使用方式

在目标代码库启动或 reload Pi，使项目级 package、`matt-*` agents、skills 和 extension 生效：

```text
/reload
```

首次使用发布链前运行 `matt-setup`，由用户确认 tracker、label mapping 和领域文档布局；它只在用户批准 draft 后写入 `.x-matt/` 与可选的项目级 `AGENTS.md` 指针，不会创建远端 issue 或 label。Matt 管理的项目文档统一采用：

```text
.x-matt/
├── agents/   # tracker、label 和 domain 契约
├── context/  # CONTEXT.md、CONTEXT-MAP.md 与多 context glossary
├── adr/      # single-context ADR；多 context 时按子目录分组
└── work/     # Local Markdown spec、tickets、map 和 decisions
```

未完成 setup 时，`matt-to-spec` 与 `matt-to-tickets` 保持 fail closed。本仓库当前已配置 Local Markdown tracker，spec 与 tickets 写入 `.x-matt/work/<feature-slug>/`；parent spec 使用 `spec-ready`，可实现 ticket 使用 `ready-for-agent`，完成后由 `matt-implement` 在最终提交中写为 `resolved`。

需求尚未明确时，使用 `matt-grill-with-docs`。它会在当前父会话中分轮询问 decision tree；事实由代码库或 `matt-research` 调查，用户决定保留为用户决定；新术语即时写入 `.x-matt/context/CONTEXT.md`，符合三项 gate 的决定在用户同意后写入 `.x-matt/adr/`。单个 session 能澄清的工作在 shared understanding 后进入 `matt-to-spec` 或一个 `matt-implement` slice；目标可命名但路线仍有 fog、明显需要多个 session 时，手动进入 `matt-wayfinder`。

讨论无法回答一个明确的状态/逻辑或 UI 设计问题时，使用 model-invoked `matt-prototype`。父会话先确认唯一 question 与 logic/UI branch，再由单 worker 构建：logic 是可双击的单文件 HTML；UI 是真实页面上下文中通过 `?variant=` 切换的 3–5 个结构差异方案。用户本人给出 verdict 后，artifact 只提交到本地 `prototype/<slug>` branch，不合并、不 push；原 branch 只接收可核验 context pointer，生产实现仍进入 `matt-to-spec`/`matt-implement`。

`matt-wayfinder` 先让用户确认整张 map 的 Destination，再 breadth-first 创建问题型 decision tickets、真实 blockers 与 `Not yet specified` fog。每个后续 session 先 claim frontier，再最多解决一张 HITL ticket；相互独立的 research tickets 是唯一并行例外。prototype ticket 调用上述 workflow，并在取得 artifact branch pointer 与用户 verdict 后才 resolve。Local Markdown 的 map 位于 `.x-matt/work/<effort>/map.md`，decision tickets 位于独立 `decisions/`，不会和 implementation `issues/` 冲突。地图只有在所有决定 resolved/out-of-scope 且 fog 清空后才标记 cleared，并交给 `matt-to-spec`；不得从 decision map 直接进入实现。

需求已经在当前会话中确认，或已有 cleared Wayfinder map 时，使用 `matt-to-spec`。它不会重新访谈，而是先让用户确认最高测试 seam，再按当前会话或 linked decision answers、代码库、`.x-matt/context/`、`.x-matt/adr/` 和明确提供的 research note 综合规格；只有配置了 `.x-matt/agents/issue-tracker.md`、用户确认 spec 且发布结果可核验时才发布 parent spec；Local Markdown 使用 `spec-ready`，remote tracker 使用 `ready-for-agent` 时必须让外部 runner 排除 parent spec，避免绕过 tickets 整体实现。随后使用 `matt-to-tickets`，先让用户批准 tracer-bullet breakdown 和 blocking edges，再按 tracker 配置发布 tickets。每次使用 `matt-implement` 只实现一个已确认 ticket，依次调用 TDD、完整验证和双轴 code-review，全部通过后提交当前 branch；当前没有实现批量 ticket 或 push/PR 的自动化。

具体 hard bug、间歇性失败或性能回归无法直接定位时，使用 model-invoked 的 `matt-diagnosing-bugs`。它在任何理论之前强制建立一个已实际运行的 red-capable command，随后最小化 repro、让用户检查 3–4 个可证伪假设、用单变量 probe 确认根因并清理 `[DEBUG-<id>]` instrumentation。存在正确 regression seam 时，它把根因、循环命令和 seam 作为当前会话单 slice 交给 `matt-implement`；没有正确 seam 时停止并给出可供手动 `matt-improve-codebase-architecture` 固定 scope 的架构 finding，不写浅层测试或直接 refactor。

周期性 architecture upkeep、build 前 seam 评估或诊断确认缺少正确 seam 时，手动运行 `matt-improve-codebase-architecture`。它按用户方向或近期 hot paths 限定 scope，调用 `architecture-scan` 在 OS temp 生成 deletion-test report；用户可以只保留报告，或选择一个 candidate 进入 `matt-grilling`/`matt-domain-modeling`。需要比较 interface 时再调用三个只读 `architecture-design` lanes。最终只产生可进入 `matt-to-spec` 的决定，不修改生产代码。

```json
{
  "workflow": "matt-research",
  "task": "明确问题、时间边界、必需来源、输出格式与停止条件"
}
```

代码评审使用 `workflow: "matt-code-review"`。父会话必须在 task 中声明 `reviewKind=worktree|committed|files`，并提供具体 changed-file/目标文件路径、对应逐文件证据方法、初始证据 allowlist、标准文件路径、当前 ticket/parent spec 路径、允许的一层依赖扩展和 module/package 搜索边界。`worktree` 先读取状态：tracked 文件逐路径 `worktree-diff`，`??` untracked 文件直接读取，deleted 文件只读 diff，rename 同时核验 old/new；禁止使用 `ref...HEAD` 作为工作区唯一证据。`committed` 才使用 `diff-files ref` 和逐文件 `diff ref path`；`files` 不调用 Git diff。Spec reviewer 必须先读取 ticket/parent spec 并提取验收行为，完成前禁止 diff、FFF 和实现文件读取。两轴只能为已命名风险读取一级依赖，使用路径限定 FFF，禁止项目扫描；限定证据不足时立即返回 `NO_EVIDENCE`，不得扩大范围制造 `PASS`。`matt-reviewer` 使用 soft 12、hard 20 的只读工具预算，达到 hard 后仍可返回结构化结果。

TDD 使用 `workflow: "matt-tdd"`。调度前必须由用户确认公开 seam、待验证行为和测试价值判断：显式验收、缺陷回归、业务规则、状态分支、权限/数据完整性与公开 contract 必须测试；不为重复现有覆盖、无分支且无业务语义并可由编译/typecheck/现有 contract test 直接保障的低风险简单变更、框架自身行为、不可达或规格排除的假设性边缘情况机械新增独立测试，紧密相关的简单字段可以合并到一个行为级测试。task 还要包含固定基线、既有工作区变化、允许范围、RED/GREEN 最小命令、worker 相关回归命令、`reviewKind=worktree`、标准文件具体路径、当前 ticket/parent spec 路径、reviewer 初始证据边界和 module/package 搜索边界。完整测试套件、全量 build 与最终验证不下发给 worker，由父会话在 TDD workflow 完成后运行一次。`tdd-executor` 的依赖闭包会同时向 worker 授予 `codebase-design`，但 reviewer 只获得各自只读 review skill。

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
