# pi-x-matt

`pi-x-matt` 将 [mattpocock/skills](https://github.com/mattpocock/skills) 中的方法论移植为纯 Pi Agent + pi-subagents 的项目级能力。它不提供 Claude Code、Codex 或其他 agent harness 的运行时兼容层。

当前已实现 tracker 配置、交互式需求到实现链、多会话 wayfinding、完成规格归档、throwaway prototype、hard-bug 诊断与 architecture deepening survey，以及 11 个交互式 parent：`matt-setup`、`matt-archive`、`matt-grilling`、`matt-domain-modeling`、`matt-grill-with-docs`、`matt-wayfinder`、`matt-to-spec`、`matt-to-tickets`、`matt-implement`、`matt-diagnosing-bugs`、`matt-improve-codebase-architecture`；另有 6 个执行型 parent：`matt-research`、`matt-prototype`、`architecture-scan`、`architecture-design`、双轴 `matt-code-review` 与分阶段 `matt-tdd`。交互式 parent 在父会话中保留 HITL 决策，不通过后台 workflow 运行；执行型 parent 使用 pi-subagents lanes，其中 `matt-prototype` 与 architecture workflows 的用户选择仍留在父会话。

## 安装

要求已安装 Pi 1.2.0 或更高版本、Node.js 22.19.0 或更高版本，以及提供 named workflow resource/host step 的 pi-subagents runtime。当前按 `pi-subagents@0.80.0` 验证，项目 runtime 与 bundled library 均固定该版本；不再支持旧 `workflowScript` RPC 的 0.69 runtime。0.80.0 将 Pi 支持下限提升到 `1.2.0`（`@earendil-works/pi-ai` peer 为 `>=1.2.0`），本 package 的 Pi host peer 同步为 `>=1.2.0`；Pi `0.86.1`/`1.0.0` 不再受支持。Node `22.19.0` 下限来自 bundled `undici@8.10.2` 的 `engines`，也与 Pi 自身要求一致。在目标代码库中先安装与项目绑定的子代理运行时和工具 provider，再安装本 package：

```bash
pi install -l npm:@ff-labs/pi-fff
pi install -l npm:@xl0/pi-lovely-codex
pi install -l npm:pi-subagents@0.80.0
pi install -l git:github.com/jinuxx/pi-x-matt@v0.2.23
```

`@ff-labs/pi-fff` 为本地代码子代理提供 `fffind` 与 `ffgrep`；`@xl0/pi-lovely-codex` 为 `matt-worker` 提供 `apply_patch`。

安装或升级 pi-subagents 后退出并重新启动 Pi；已运行的进程可能缓存旧模块，不能只依赖 `/reload`。未改变 runtime 版本、只修改本 package 的 skills/dispatcher 时，可使用：

```text
/reload
```

首次使用时手动运行 `matt-setup`，在父会话中选择 issue tracker（Local Markdown、GitHub 或 GitLab）并确认项目文档契约。package manifest 会自动加载 dispatcher、`matt-*` skills 和 `matt-*` agents；`pi-subagents` 作为 project-local 前置 package 加载。若目标项目已有 `pi-subagents`，不要再添加第二个 `pi-subagents` extension 路径，以免重复注册工具。若要保持最小加载，可把 `.pi/settings.json` 中的 `npm:pi-subagents` 字符串改为：

```json
{
  "source": "npm:pi-subagents@0.80.0",
  "autoload": false,
  "extensions": ["+index.js"],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

不要把这份 object 与同一 package 的另一个 entry 并存。

Pi package 使用独立 module root，不能从另一个已安装 package 直接解析 imports。因此本 package 固定 bundle `pi-subagents@0.80.0`，只导入其 `workflow-resources` 公共注册 API；该 library copy 不会自动加载 pi-subagents extension、agents、skills 或 prompts。上面的独立 project-local runtime 仍必须保留。npm 发布包入口是 `index.js`，不是 source checkout 的 `index.ts`；最小加载过滤必须与发布包 manifest 一致。

本地开发安装依赖使用 `npm install --omit=peer --ignore-scripts --no-package-lock`，避免安装 Pi 已提供的 SDK/TypeBox 副本；它们仍由运行中的 Pi 提供，`npm ls --omit=peer pi-subagents` 可检查 bundled 版本。

安装包拥有 Pi package 的系统访问能力：`matt-worker` 可以在用户批准的范围内修改目标仓库，`matt-researcher` 可以访问配置的 web provider。安装前请审阅 source，升级时使用固定 tag：

```bash
pi update git:github.com/jinuxx/pi-x-matt@v0.2.23
```

## 架构

系统分为三个边界：

1. **父会话 skill**：位于 `.pi/skills/`，负责识别任务、保留 HITL 决策、调用项目 dispatcher 和综合结果。交互式 parent（`matt-setup`、`matt-archive`、`matt-grilling`、`matt-domain-modeling`、`matt-grill-with-docs`、`matt-wayfinder`、`matt-to-spec`、`matt-to-tickets`、`matt-implement`、`matt-diagnosing-bugs`、`matt-improve-codebase-architecture`）留在当前会话中，直接使用用户问答和受限调查；执行型 parent（`matt-research`、`matt-prototype`、`architecture-scan`、`architecture-design`、`matt-code-review`、`matt-tdd`）通过 registry workflow 调度子代理。
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

`matt-research`、`matt-prototype` 与 `architecture-scan` 使用单 lane；`architecture-design` 使用 minimal/flexible/common-caller 三个 fresh 只读 lane；`matt-prototype` 只把 artifact 构建交给唯一 `matt-worker`，`architecture-scan` 的 worker 只写 OS temp report；`matt-code-review` 使用相互独立的 `standards` 与 `spec` reviewer lanes；`matt-tdd` 先由唯一 `matt-worker` 执行 red→green，再由两个 fresh reviewer 并行复核。`matt-setup`、`matt-archive`、`matt-grilling`、`matt-domain-modeling`、`matt-grill-with-docs`、`matt-wayfinder`、`matt-to-spec`、`matt-to-tickets`、`matt-implement`、`matt-diagnosing-bugs` 和 `matt-improve-codebase-architecture` 是 `dispatch: none` 的 interaction parent：interaction parent 本身不定义 `workflow.json`，可以在父会话中调用执行型 workflow。`matt-archive` 不调用 workflow，只在用户给出准确 feature slug 后执行本地归档 gate 与文件移动，不创建提交。`matt-improve-codebase-architecture` 先调用 `architecture-scan` 生成 temp report，用户选择 candidate 并 grilling 后，只有明确需要 alternative interfaces 才调用 `architecture-design`；它不修改生产代码。`matt-implement` 仍在父会话中调用 `matt-tdd` 和 `matt-code-review`，负责单 ticket 的实现、验证、review 与代码提交。

## pi-subagents 最小加载

`.pi/settings.json` 使用 Pi package delta filter，只加载 `pi-subagents` 的 extension。`autoload: false` 会在用户级已安装同一 package 时复用该安装并应用项目过滤，避免用户级与项目级两个绝对路径各自注册 RPC bridge；若用户级未安装，则仍从项目安装中显式加载该 extension：

```json
{
  "packages": [
    {
      "source": "npm:pi-subagents@0.80.0",
      "autoload": false,
      "extensions": ["+index.js"],
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

因此本地开发配置不会加载包内 `pi-subagents`/`council-mode` skills、prompt templates 或 builtin agents。package manifest 只加载本 package 的 dispatcher，并只暴露四个 `matt-*` 自定义 agents；reviewer 默认继承用户当前模型，不要求 DeepSeek provider（可按角色覆盖，见[为子代理指定模型](#为子代理指定模型)）。`pi-subagents` 由上面的 project-local package 配置提供：

| Agent | 权限 | 当前用途 |
| --- | --- | --- |
| `matt-reader` | 本地只读 | 代码库探索与 `architecture-design` 三方案 lanes |
| `matt-researcher` | `read`、`web_search`、`web_fetch` | `matt-research` |
| `matt-reviewer` | 本地只读 | `matt-code-review` 与 `matt-tdd` 的 Standards/Spec lanes |
| `matt-worker` | 单写者工具集 | `matt-tdd` 实现、`matt-prototype` artifact 与 OS temp architecture report |

`matt-researcher` 依赖父环境中已经注册的 `web_search` 与 `web_fetch` provider。显式 allowlist 不会自动加载 provider；若工具未注册，pi-subagents 应在 child 启动阶段失败，而不是生成无来源回答。

## 为子代理指定模型

pi-x-matt 不参与选模型：dispatcher 下发的 lane item 只包含 `key/agent/task/context/skill/timeoutMs/outputSchema/output`，没有 `model`。0.80.0 为内置 `parallel/tasks/chain` 新增的逐子任务 `cwd/model` 不改变本 package 的 scripted workflow；所有 child 仍使用目标项目 root，模型仍由 pi-subagents 的解析链决定，配置写在 **pi-subagents 的 settings**，而不是 package 文件里：

```text
<项目>/.pi/settings.json      ← 优先
~/.pi/agent/settings.json     ← 兜底
```

四个 agent 没有 `package:` frontmatter，因此名称固定为 `matt-worker`、`matt-reviewer`、`matt-researcher`、`matt-reader`。按角色钉模型时在同一 `subagents` 块里写 `agentOverrides`；下例的模型 id 只是分层示意，实际取值以本机 registry 为准：

```json
{
  "subagents": {
    "agentOverrides": {
      "matt-worker": { "model": "<provider>/<workhorse-model>", "thinking": "max" },
      "matt-reviewer": { "model": "<provider>/<reasoning-model>", "thinking": "high" },
      "matt-researcher": { "model": "<provider>/<fast-model>" },
      "matt-reader": { "model": "<provider>/<fast-model>", "thinking": "low" }
    }
  }
}
```

`agentOverrides` 是逐字段替换：只写 `model` 或 `thinking` 时，其余定义（tools、skillPath、默认 context、toolBudget）仍取自 `.pi/agents/*.md` 的 frontmatter。也可以只用 `subagents.defaultModel` / `subagents.defaultThinking` 统一兜底，它只填补没有自己 `model` 的 agent。角色需要随父会话 provider 变化时用 `subagents.agentOverridesByProvider.<provider>.<name>` 分层；`subagents.modelScope` 只做拦截，不做选择。

解析优先级（强 → 弱）：单次 launch 覆盖 → `agentOverridesByProvider` → `agentOverrides.<name>.model` → agent frontmatter `model` → `subagents.defaultModel` → 父会话模型。`model: "inherit"` 表示显式跟随父会话模型。单次 launch 可用 `/run <agent>[model=<provider>/<model>:<thinking>]`。

每次 launch 只解析一个模型：provider、鉴权、配额、限流（含 HTTP 429）、流与空响应错误会直接返回，不会自动换模型重试，需要父会话显式重发。

修改 settings 后需要 `/reload`，再用 `/subagents-models`（或 `/subagents-models matt-worker`）核对实时映射，因为磁盘配置与运行中进程可能不一致。完整说明见已安装的 `pi-subagents/docs/models.md`。

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

生成器会拒绝重复名、保留名、未知 agent、缺失依赖、依赖环、父依赖、跨 agent 依赖、错误 scope/class/dispatch、越出 vendored upstream 根目录的来源路径和 SHA 漂移。执行型 parent workflow 还必须定义有效的 lane、封闭 object `outputSchema` 与正数 `timeoutMs`；每个 workflow 至多包含一个 `acceptanceRole: writer` lane。interaction parent 必须没有 `workflow.json`，且只能依赖其他 interaction parent。pipeline 的 stage 必须从 1 连续编号；任何模式的 lane gate 都必须引用 schema 中声明的 enum 值，`matt-code-review` 与 `matt-tdd` 的 reviewer verdict 均由 gate 强制为 `PASS`；后续 stage 会收到前序 `structuredOutput` 作为可核验的过程证据。

项目 extension `.pi/extensions/pi-matt-dispatch/index.ts` 是规范调度入口。它在每次 dispatch 时重新验证 registry 中所有 port 的 source/workflow digest 和项目内路径，计算 leaf 闭包并校验 agent 绑定；`laneTasks` 可为指定 lane 提供完整任务替换；`matt-tdd` 强制同时提供 implement/standards/spec 三项，`matt-code-review` 强制提供 standards/spec 两项，避免实现、恢复指令或轴专属证据跨角色泄漏。工具调用把已验证 plan 放入内存队列，TDD 另保存调度前 Git 快照；随后在 `turn_end` 的有效 extension context 中通过 pi-subagents 进程内 RPC 发起异步 run。TDD 使用 session-scoped trusted workflow resource，只授予包内 collector 的固定命令；其他 workflow 继续使用无 host 权限的原始脚本。缺少结构化结果的 timeout 或正常漏调用会在 retained child 可恢复时自动追加一次只结算、不继续工作的 structured-output resume。`matt-tdd` 只在无法确认本次实现由用户显式发起时才要求 TUI/RPC 授权：本 session 以 `/skill:matt-implement` 启动时直接放行，模型自行进入 TDD 时才要求确认；取消或 print/JSON mode 没有 UI 时 fail closed，不会排队 workflow。普通 prose output 被禁用；生成的 workflow script 会核对每个 stage 的结果数量、lane key 与运行时 schema 捕获的 `structuredOutput`，在 `ok !== true`、缺失、错序或 gate 不满足时让整个 workflow fail closed。不存在的 workflow、过期 registry、错误 scope、跨 agent skill 或不支持的 dispatch mode 同样会被拒绝。

工具 allowlist 是真实的能力边界；SKILL.md 中的文字不是沙箱。直接调用底层 `subagent` 仍是管理员级逃生口，因此本项目的父 skills 统一要求使用 `pi_matt_dispatch`。

## 当前使用方式

在目标代码库启动或 reload Pi，使项目级 package、`matt-*` agents、skills 和 extension 生效：

```text
/reload
```

首次使用发布链前运行 `matt-setup`，业务项目使用仅本地 Local Markdown，由用户确认 label mapping、领域布局与隐私迁移 draft；它只写本地 `.x-matt/`、`.pi/APPEND_SYSTEM.md` 入口和 Git exclude，不向团队 AGENTS/README 添加工具说明，不会创建远端 issue 或 label。Matt 管理的项目文档统一采用：

```text
.x-matt/
├── agents/   # tracker、label 和 domain 契约
├── context/  # CONTEXT.md、CONTEXT-MAP.md 与多 context glossary
├── adr/      # single-context ADR；多 context 时按子目录分组
└── work/     # active Local Markdown spec/tickets/map/decisions；shipped/ 是唯一归档子目录
```

未完成 setup 时，`matt-to-spec` 与 `matt-to-tickets` 保持 fail closed。本仓库当前已配置 Local Markdown tracker，active spec 与 tickets 写入 `.x-matt/work/<feature-slug>/`；parent spec 使用 `spec-ready`，可实现 ticket 使用 `ready-for-agent`。tracker 只在本机维护，不被 Git 跟踪、不暂存、不提交；完成后由 `matt-implement` 先提交代码，再在本地把 ticket 写为 `resolved`，Comments 记录 `Implementation commit: <完整 commit SHA>` 与验证/review 摘要。提交失败不写完成状态；本地写回失败则报告“代码已提交、tracker 待修复”，不重复提交。全部 tickets 为 `resolved` / `out-of-scope`、Comments 中相关实现提交已在当前 branch、持久知识已沉淀后，用户可在独立步骤显式运行 `matt-archive <feature-slug>`：它把 parent 改为 `shipped`，整体移动到 `.x-matt/work/shipped/<feature-slug>/`，改写 Parent/Blocked by 路径，仅本地归档，不创建提交；`matt-implement` 不得代做归档。

**业务项目排除的是整个 `.x-matt/` 和个人 `.pi/`，不是仅 work/。** 包括 tracker、agent 契约、glossary、ADR、research、原型、settings、Pi package/extension/skill 声明、工具/harness 配置及本地入口；业务自己的 `package.json`、构建配置和锁文件不在其中。`matt-setup` 通过 `git rev-parse --git-path info/exclude` 与 `--show-prefix` 配置本机规则（根项目为 `/.x-matt/`、`/.pi/`），支持 nested project 与 linked worktree，不修改团队 `.gitignore`。规则不匹配或个人资料仍被跟踪时停止；ignored 文件按准确路径读取，不能用 Git-aware 搜索或 diff 缺失推断不存在。

入口使用 Pi 原生 `.pi/APPEND_SYSTEM.md`，保留已有本地内容，不用 AGENTS override 遮蔽团队指令。若新建 project APPEND 会遮蔽全局同名文件，setup 会停止并要求先明确保留/合并方式。提交前检查完整 staged manifest、内容和最终提交信息，不自动附加 AI attribution、工具生成的 co-author、session、私有路径或模型/harness 说明；提交后若 hook 追加归因则停止、不 push，不伪造作者或绕过团队策略。完整规则见[业务项目隐私契约](.pi/skills/matt-setup/privacy.md)。

已有项目重新运行 `matt-setup` 迁移整个个人 AI 资料范围，而不是只迁移 tracker。先展示准确清单：个人 tracked 文件经授权后仅取消索引跟踪、保留磁盘文件；旧 AGENTS/README 的个人入口 block 经批准后移入本地文件，团队原文不动。不能自动取消跟踪团队 `.pi/` 配置，也不重写历史。取消跟踪产生的索引删除需先作为一次迁移提交落地，再继续 implement/archive；此删除记录不删除本机文件。本机 exclude 不随 clone 传播，新 clone/worktree 需重新核验；本地资料需自行备份。实现追溯使用本地 Comments 的真实 commit SHA；blocker 必须核验该实现提交属于当前 `HEAD` ancestry，不能用其他 branch 的完成状态解锁。

**插件源码仓库是例外**：只有目标 cwd 的真实路径等于已加载 package root 时，才保留 `.pi/` 与既有契约的版本控制；不能靠相同目录名或 package name 启用例外。本仓库只排除整个 `.x-matt/`，`.pi/` 作为 package 源码保持跟踪；已 tracked 契约不受忽略影响，新增需要分发的契约文件须显式 `git add -f`。这不意味着业务项目也能提交这些资料。忽略规则不能消除已有 Git 历史，也不能保证手动操作、第三方扩展、hook 或远端服务“绝对无痕”。

旧项目迁移时，既有 `resolved` implementation ticket 若缺少 `Implementation commit`，只能核验真实实现提交与该 ticket 对应且属于当前 `HEAD` ancestry 后，在本地 Comments 追加完整 SHA 与核验依据，保留原有完成摘要；仅修改 ticket 状态的提交不算实现证据，不按状态或时间猜测。无法核验时保留现有状态，parent spec（如有）保持 `spec-ready`，报告待补证；对应 blocker 不得解锁，feature 不得归档。不伪造完成记录，不自动重做实现。

所有 skills 默认把 `.x-matt/work/shipped/` 视为不存在：feature 枚举、Wayfinder frontier、`matt-to-spec` / `matt-to-tickets` 输入、`matt-implement` 入口与 `matt-code-review` Spec 轴都跳过归档内容，找不到 active spec 时返回“无可用 spec”，不回退到 shipped。只有用户在同一会话明确点名某个归档标题或路径时，才可只读对应对象作为历史依据；授权不允许重开 ticket、改状态、生成新 ticket、进入 frontier/implement 或成为 Spec 轴。

需求尚未明确时，使用 `matt-grill-with-docs`。它会在当前父会话中分轮询问 decision tree；事实由代码库或 `matt-research` 调查，用户决定保留为用户决定；新术语即时写入 `.x-matt/context/CONTEXT.md`，符合三项 gate 的决定在用户同意后写入 `.x-matt/adr/`。shared understanding 确认后必须停止并把控制权交还给用户，由用户显式选择 `/skill:matt-to-spec`、一个 `/skill:matt-implement` 单 slice 或暂停；不得在同一连续流程中直接确认测试 seam 或启动 TDD。greenfield、多业务流程、多个 seam、部署/迁移、跨 session，或依赖用户提供且不能安全压缩的事实、说明、样例与约束的工作默认进入 spec → tickets；这些材料不限于任何项目或技术格式。目标可命名但路线仍有 fog、明显需要多个 session 时，手动进入 `matt-wayfinder`。

讨论无法回答一个明确的状态/逻辑或 UI 设计问题时，使用 model-invoked `matt-prototype`。父会话先确认唯一 question 与 logic/UI branch，再由单 worker 构建：logic 是可双击的单文件 HTML；UI 是真实页面上下文中通过 `?variant=` 切换的 3–5 个结构差异方案。用户本人给出 verdict 后，artifact 只提交到本机 `prototype/<slug>` 分支，禁止 push、PR、merge 或 rebase 进共享分支；原 branch 只接收可核验 context pointer，生产实现仍进入 `matt-to-spec`/`matt-implement`。

`matt-wayfinder` 先让用户确认整张 map 的 Destination，再 breadth-first 创建问题型 decision tickets、真实 blockers 与 `Not yet specified` fog。每个后续 session 先 claim frontier，再最多解决一张 HITL ticket；相互独立的 research tickets 是唯一并行例外。prototype ticket 调用上述 workflow，并在取得本地 prototype 分支 context pointer（不 push）与用户 verdict 后才 resolve。Local Markdown 的 map 位于 `.x-matt/work/<effort>/map.md`，decision tickets 位于独立 `decisions/`，不会和 implementation `issues/` 冲突。地图只有在所有决定 resolved/out-of-scope 且 fog 清空后才标记 cleared，并交给 `matt-to-spec`；不得从 decision map 直接进入实现。

需求已经在当前会话中确认，或已有 cleared Wayfinder map 时，使用 `matt-to-spec`。它不会重新访谈，而是先让用户确认最高测试 seam，再按当前会话或 linked decision answers、代码库、`.x-matt/context/`、`.x-matt/adr/` 和明确提供的 research note 综合规格；用户提供且后续工作依赖、不能安全压缩的事实、说明、样例与约束，脱敏后忠实写入 `Reference Inputs`，不以 SQL、API 或其他特定技术材料为限，Local Markdown 同时记录 `Source session: pi:<PI_SESSION_ID>`。只有配置了 `.x-matt/agents/issue-tracker.md`、用户确认 spec 且发布结果可核验时才发布 parent spec；Local Markdown 使用 `spec-ready`，remote tracker 使用 `ready-for-agent` 时必须让外部 runner 排除 parent spec，避免绕过 tickets 整体实现。随后使用 `matt-to-tickets`，先让用户批准 tracer-bullet breakdown 和 blocking edges，再按 tracker 配置发布 tickets。每次使用 `matt-implement` 只实现一个已确认 ticket，依次执行带内置双轴复核的 `matt-tdd` 和父会话完整验证，全部通过后提交当前 branch；缺少规划 artifact 时 implement/TDD 不得手写 `.x-matt/work/` 解阻。当前没有实现批量 ticket 或 push/PR 的自动化。

具体 hard bug、间歇性失败或性能回归无法直接定位时，使用 model-invoked 的 `matt-diagnosing-bugs`。它在任何理论之前强制建立一个已实际运行的 red-capable command，随后最小化 repro、让用户检查 3–4 个可证伪假设、用单变量 probe 确认根因并清理 `[DEBUG-<id>]` instrumentation。存在正确 regression seam 时，它把根因、循环命令和 seam 作为当前会话单 slice 交给 `matt-implement`；没有正确 seam 时停止并给出可供手动 `matt-improve-codebase-architecture` 固定 scope 的架构 finding，不写浅层测试或直接 refactor。

周期性 architecture upkeep、build 前 seam 评估或诊断确认缺少正确 seam 时，手动运行 `matt-improve-codebase-architecture`。它按用户方向或近期 hot paths 限定 scope，调用 `architecture-scan` 在 OS temp 生成 deletion-test report；用户可以只保留报告，或选择一个 candidate 进入 `matt-grilling`/`matt-domain-modeling`。需要比较 interface 时再调用三个只读 `architecture-design` lanes。最终只产生可进入 `matt-to-spec` 的决定，不修改生产代码。

```json
{
  "workflow": "matt-research",
  "task": "明确问题、时间边界、必需来源、输出格式与停止条件"
}
```

代码评审使用 `workflow: "matt-code-review"`。父会话声明 `reviewKind=worktree|committed|files`，优先提供 Review Evidence Pack：fixed point/current HEAD、状态、完整 manifest、完整 combined diff、新文件全文/hash、deleted/rename old/new 和注明来源的测试记录。Standards lane 只接收适用工程规范与安全/正确性边界；Spec lane 只接收 ticket acceptance matrix 和 parent spec 相关条款。独立评审指独立判断，不是重复发现上下文；已内联内容无需再次 `read`。没有 Pack 的 standalone review 按精确 allowlist 取证，允许一次完整、未截断的 combined diff，仅截断或需要深入检查时按文件补读；`worktree` 禁止以 `ref...HEAD` 替代当前工作区，`files` 不调用 Git。默认只读 manifest，仅在截断、symbol 不明、一层依赖待核验、hash 不符或安全/数据完整性风险时，说明缺口后定向扩展一层，不递归、不扫描整个 module。证据不足返回 `NO_EVIDENCE`。`matt-reviewer` 只保留 hard 50 的只读工具预算，不通过提高上限掩盖重复扫描。

TDD 调度前，父会话按 [Context Pack 契约](.pi/skills/matt-tdd/context-packs.md) 提供 Implementation Context Pack：ticket/parent/blocker 核验、acceptance matrix、适用条款、known code map、expected change points、固定点/文件 hash、精确 manifest 与命令分层。源码通常给路径和 symbol，不全文内联；worker 从必须读取文件开始，只有 symbol 缺失、调用关系不一致或 Pack 与工作区不符时才定向搜索一次、一层。dispatcher 在入队前保存真实基线，implement gate 通过后由受信任的 `pi-x-matt.tdd` named resource 执行固定 collector 命令，在 OS temp 生成只读 Review Evidence Pack，再启动两个 fresh reviewer。采集失败或基线漂移会停止工作流，不回退到原始脚本执行 host 命令。测试 phase/exitCode/testCount/outcome 仍标为 worker-reported，不冒充独立验证；父会话最终检查 Pack 新鲜度并运行最终验证。

执行型 workflow 按角色保留运行余量：worker lane 为 20 分钟，reviewer lane 为 15 分钟，reader/researcher lane 为 10 分钟；timeout 或漏交结构化结果后的 settlement-only resume 为 5 分钟。预算只限制单个 lane，不替代任务范围、最小验证和 fail-closed gate。

TDD 使用内部 `workflow: "matt-tdd"`，该 skill 对 model invocation 隐藏，只能在 `matt-implement` 已核验 ticket/direct-slice handoff 后调度，不能从 grilling 或普通功能请求自动进入。该 workflow 只在用户于本 session 以 `/skill:matt-implement` 显式发起时直接放行；模型自行请求时，dispatcher 会在入队前要求用户确认当前确实要实现一个已核验 ticket 或已批准 direct slice，取消或无 UI 时不会启动。调度前必须由用户确认公开 seam、待验证行为和测试价值判断：显式验收、缺陷回归、业务规则、状态分支、权限/数据完整性与公开 contract 必须测试；不为重复现有覆盖、无分支且无业务语义并可由编译/typecheck/现有 contract test 直接保障的低风险简单变更、框架自身行为、不可达或规格排除的假设性边缘情况机械新增独立测试，紧密相关的简单字段可以合并到一个行为级测试。task 还要包含固定基线、既有工作区变化、允许范围、RED/GREEN 最小命令、worker 相关回归命令、`reviewKind=worktree`、标准文件具体路径、当前 ticket/parent spec 路径、reviewer 初始证据边界和 module/package 搜索边界。完整测试套件、全量 build 与最终验证不下发给 worker，由父会话在 TDD workflow 完成后运行一次。`tdd-executor` 的依赖闭包会同时向 worker 授予 `codebase-design`，但 reviewer 只获得各自只读 review skill。

`matt-implement` 默认把 `matt-tdd` 中两个 fresh Standards/Spec reviewer 的 `PASS` 作为最终双轴复核，不再对同一 worktree 自动追加一轮 `matt-code-review`。只有用户明确要求、TDD reviewer 证据无效、TDD 后业务文件继续变化，或实现并非来自完整 `matt-tdd` 时，才启动 standalone code review。review finding 会按同一轮合并请求一次授权；获批修复使用聚焦 `matt-tdd`，只复核修复增量、原 finding 与必要的一层依赖，不重新裁决未变化且已通过的文件。

把 task 传给 `pi_matt_dispatch`。调度是异步的；父会话不应轮询等待，完成后由 pi-subagents 自动回传。RPC 使用 inline `script`，TDD 使用 named `workflow`，两者不能同时发送。每条 lane 必须 `ok === true`，失败后保留的结构化结果不能通过 gate 或启动后续 stage。

父会话按 [Workflow Result Reading](.pi/skills/matt-tdd/results.md) 读取每个 lane 的 `structuredOutput`：completion/targeted status 的 Preview 有界且可能被截断，必须读取通知指向的 retention-managed `status.json` 中完整 `workflow.value`；不解析普通 `output`、`outputReference`，也不把 receipt 元数据当作完整结果。

## 已验证行为

以下冒烟分两类：升级到 0.80.0 并重启 Pi 后实跑的真实子代理冒烟，以及旧版开发阶段的手工运行。仓库内可复现的是 registry、dispatcher、权限与 gate，以及针对已安装 `0.80.0` 的脚本 sandbox、resource 注册和 completion 截断契约测试；后者只注入 mock child 结果，不调用模型。0.80.0 直接由 completion notice 唤醒空闲父会话，不再额外插入唤醒消息；完整结果仍按通知中的路径读取，不能将 Preview 当作完整结果。

- Research 单 lane 异步冒烟（0.80.0 + Pi 1.4.0，重启后实跑）：workflow `state=complete`、research lane `ok=true`、`resolvedContext=fresh`；真实 child 加载私有 `research-executor`，已从 child session 核实 `web_search`、`web_fetch` 与 `structured_output` 均实际调用成功。异步完成通知已返回，父会话从 `status.json` 的完整 `workflow.value` 核验了两项 findings、官方来源与空 gaps。
- Code Review 并行冒烟：`standards` 与 `spec` 两个 reviewer 均以 fresh context 完成，分别生成结构化结果，且未修改项目文件。
- TDD pipeline 真实冒烟：worker 加载 `codebase-design` + `tdd-executor`，取得一轮真实 RED/GREEN；随后两个 fresh reviewer 只读复核。registry、依赖闭包、唯一写者、lane gate、stage 顺序与前序证据传递另有聚焦测试覆盖。

## 上游与许可证

上游快照位于 `vendor/mattpocock-skills/`，固定 commit 记录于 `vendor/UPSTREAM_SHA`。vendor 不在 Pi skill discovery 或 agent `skillPath` 中，但它是可追踪的项目源文件，并非路径级安全沙箱。

上游使用 MIT License，原文保留在 `vendor/mattpocock-skills/LICENSE`；归属说明见 `NOTICE.md`。

## 当前边界

当前刻意不实现万能 router、动态多写者、自动导入全部 skills 或跨 harness 兼容。TDD 遵循上游方法：refactor 不混入 red→green 循环；fresh review 发现需要重构时，由父会话取得授权后再启动下一次受限实现。
