# pi-x-matt

`pi-x-matt` 将 [mattpocock/skills](https://github.com/mattpocock/skills) 中的方法论移植为纯 Pi Agent + pi-subagents 的项目级能力。它不提供 Claude Code、Codex 或其他 agent harness 的运行时兼容层。

当前已实现三个纵向切片：`research`、双轴 `code-review` 与分阶段 `tdd`。它们验证了父会话编排、私有 leaf skill、最小工具权限、异步子代理、结构化输出、唯一写者和 fresh reviewer 复核。

## 架构

系统分为三个边界：

1. **父会话 skill**：位于 `.pi/skills/`，负责识别任务、保留 HITL 决策、调用项目 dispatcher 和综合结果。
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

`research` 使用单 lane；`code-review` 使用相互独立的 `standards` 与 `spec` 两个 reviewer lane；`tdd` 先由唯一 `worker` 执行 red→green，再由两个 fresh reviewer 并行复核。pipeline gate 会在 worker 未返回 `COMPLETE` 或缺少非空 TDD 证据时阻止 review stage 启动，并在任一 reviewer 未返回 `PASS` 时让整个 workflow 失败。

## pi-subagents 最小加载

`.pi/settings.json` 使用 Pi package filter，只加载 `pi-subagents` 的 extension：

```json
{
  "packages": [
    {
      "source": "npm:pi-subagents",
      "extensions": ["+index.ts"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ],
  "subagents": {
    "disableBuiltins": true
  }
}
```

因此项目不会加载包内 `pi-subagents`/`council-mode` skills、prompt templates 或 builtin agents。项目只暴露四个自定义 agent：

| Agent | 权限 | 当前用途 |
| --- | --- | --- |
| `reader` | 本地只读 | 代码库探索 |
| `researcher` | `read`、`web_search`、`web_fetch` | `research` |
| `reviewer` | 本地只读 | `code-review` 与 `tdd` 的 Standards/Spec lanes |
| `worker` | 单写者工具集 | `tdd` 的 red→green 实现 |

`researcher` 依赖父环境中已经注册的 `web_search` 与 `web_fetch` provider。显式 allowlist 不会自动加载 provider；若工具未注册，pi-subagents 应在 child 启动阶段失败，而不是生成无来源回答。

## Registry 与代码边界

每个 Pi-native `SKILL.md` 的标准 `metadata` 保存以下移植信息：

- `pi-scope`：`parent` 或 `leaf`
- `pi-class`：parent 必须为 `orchestration`；leaf 必须为 `executor` 或 `reviewer`
- `pi-agent`：唯一允许接收其 leaf 闭包的 agent
- `pi-dispatch`：由父 workflow 的 `workflow.json` 定义 `single`、`parallel` 或 `pipeline`；leaf skill 为 `none`
- `pi-depends-on`：逗号分隔的 leaf 依赖
- `pi-upstream-path` / `pi-upstream-sha`：上游来源

运行：

```bash
npm run registry       # 生成 config/skill-registry.json
npm run registry -- --check
npm run drift          # 检查 vendored 上游是否影响已移植 skill
npm run test           # 聚焦测试
npm run check          # 测试 + registry freshness + upstream drift
```

生成器会拒绝重复名、保留名、未知 agent、缺失依赖、依赖环、父依赖、跨 agent 依赖、错误 scope/class/dispatch 和 SHA 漂移。parent workflow 还必须定义有效的 lane、封闭 object `outputSchema`、正数 `timeoutMs` 与 `turnBudget`。pipeline 的 stage 必须从 1 连续编号，lane gate 必须引用 schema 中声明的 enum 值；后续 stage 会收到前序 `structuredOutput` 作为可核验的过程证据。registry 同时记录 port 与上游源文件的 SHA-256。

项目 extension `.pi/extensions/pi-matt-dispatch/index.ts` 是规范调度入口。它在每次 dispatch 时重新验证 registry 中所有 port 的 source/workflow digest 和项目内路径，计算 leaf 闭包并校验 agent 绑定，然后通过 pi-subagents 的进程内 RPC 发起异步 run。普通 prose output 被禁用；workflowScript 会核对每个 stage 的结果数量、lane key 与运行时 schema 捕获的 `structuredOutput`，缺失、错序或 gate 不满足时整个 workflow fail closed。不存在的 workflow、过期 registry、错误 scope、跨 agent skill 或不支持的 dispatch mode 同样会被拒绝。

工具 allowlist 是真实的能力边界；SKILL.md 中的文字不是沙箱。直接调用底层 `subagent` 仍是管理员级逃生口，因此本项目的父 skills 统一要求使用 `pi_matt_dispatch`。

## 当前使用方式

在本目录启动或 reload Pi，使 `.pi/settings.json`、project agents、skills 和 extension 生效：

```text
/reload
```

随后可以直接提出需要外部一手资料的问题，或提出需要评审的固定范围代码变化。父会话匹配对应 skill 后，应调用：

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

- Research 单 lane 异步冒烟：成功加载私有 `research-executor`，调用 `web_search`/`web_fetch` 并生成 artifact。
- Code Review 并行冒烟：`standards` 与 `spec` 两个 reviewer 均以 fresh context 完成，分别生成结构化结果，且未修改项目文件。
- TDD pipeline 真实冒烟：worker 加载 `codebase-design` + `tdd-executor`，取得一轮真实 RED/GREEN；随后两个 fresh reviewer 只读复核。registry、依赖闭包、唯一写者、lane gate、stage 顺序与前序证据传递另有聚焦测试覆盖。

## 上游与许可证

上游快照位于 `vendor/mattpocock-skills/`，固定 commit 记录于 `vendor/UPSTREAM_SHA`。vendor 不在 Pi skill discovery 或 agent `skillPath` 中，但它是可追踪的项目源文件，并非路径级安全沙箱。

上游使用 MIT License，原文保留在 `vendor/mattpocock-skills/LICENSE`；归属说明见 `NOTICE.md`。

## 当前边界

当前刻意不实现万能 router、动态多写者、自动导入全部 skills 或跨 harness 兼容。TDD 遵循上游方法：refactor 不混入 red→green 循环；fresh review 发现需要重构时，由父会话取得授权后再启动下一次受限实现。
