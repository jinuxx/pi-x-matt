# pi-x-matt

`pi-x-matt` 将 [mattpocock/skills](https://github.com/mattpocock/skills) 中的方法论移植为纯 Pi Agent + pi-subagents 的项目级能力。它不提供 Claude Code、Codex 或其他 agent harness 的运行时兼容层。

当前已实现两个纵向切片：`research` 与双轴 `code-review`。目标是验证父会话编排、私有 leaf skill、最小工具权限、异步子代理、结构化输出和可追溯评审结果，再扩展 `tdd`。

## 架构

系统分为三个边界：

1. **父会话 skill**：位于 `.pi/skills/`，负责识别任务、保留 HITL 决策、调用项目 dispatcher 和综合结果。
2. **leaf agent**：位于 `.pi/agents/`，只完成一次明确委派。所有 agent 都设置 `inheritSkills: false`、私有 `skillPath` 和 `maxSubagentDepth: 0`，且工具列表不包含 `subagent`。
3. **私有 leaf skill**：位于 `skillpacks/leaf/`，不会进入父会话的 Pi skill catalog，只能由 agent 的 `skillPath` 解析，并由每次 launch 精确选择。

运行链路按 workflow 模式分为单 lane 和并行 lane：

```text
用户任务
  → 父会话读取 .pi/skills/<workflow>/SKILL.md
  → pi_matt_dispatch 校验 registry 与 workflow digest
  → 计算每个 lane 的 leaf 闭包
  → 通过 pi-subagents RPC 异步启动一个或多个 fresh reviewer/researcher
  → 子代理读取私有 leaf skill 并按结构化 schema 返回结果
  → 父会话核验并综合结果
```

`research` 使用单 lane；`code-review` 使用相互独立的 `standards` 与 `spec` 两个 reviewer lane。

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
| `reader` | 本地只读 | 后续代码库探索 |
| `researcher` | `read`、`web_search`、`web_fetch` | 当前 research 切片 |
| `reviewer` | 本地只读 | `code-review` 的 Standards/Spec 双 lane |
| `worker` | 单写者工具集 | 后续 TDD 实现 |

`researcher` 依赖父环境中已经注册的 `web_search` 与 `web_fetch` provider。显式 allowlist 不会自动加载 provider；若工具未注册，pi-subagents 应在 child 启动阶段失败，而不是生成无来源回答。

## Registry 与代码边界

每个 Pi-native `SKILL.md` 的标准 `metadata` 保存以下移植信息：

- `pi-scope`：`parent` 或 `leaf`
- `pi-class`：当前为 `orchestration` 或 `executor`
- `pi-agent`：唯一允许接收其 leaf 闭包的 agent
- `pi-dispatch`：当前由父 workflow 的 `workflow.json` 定义 `single` 或 `parallel`；leaf skill 为 `none`
- `pi-depends-on`：逗号分隔的 leaf 依赖
- `pi-upstream-path` / `pi-upstream-sha`：上游来源

运行：

```bash
npm run registry       # 生成 config/skill-registry.json
npm run registry -- --check
npm run drift          # 检查 vendored 上游是否影响已移植 skill
npm run check          # 聚焦测试
```

生成器会拒绝重复名、保留名、未知 agent、缺失依赖、依赖环、父依赖、跨 agent 依赖、错误 scope 和 SHA 漂移。parent workflow 还必须定义有效的 lane、`outputSchema`、正数 `timeoutMs` 与 `turnBudget`；registry 同时记录 port 与上游源文件的 SHA-256。

项目 extension `.pi/extensions/pi-matt-dispatch/index.ts` 是规范调度入口。它在每次 dispatch 时重新验证 registry 中所有 port 的 source digest，计算 leaf 闭包并校验 agent 绑定，然后通过 pi-subagents 的进程内 RPC 发起异步 run。不存在的 workflow、过期 registry、错误 scope、跨 agent skill 或不支持的 dispatch mode 都会 fail closed。

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
传给 `pi_matt_dispatch`。调度是异步的；父会话不应轮询等待，完成后由 pi-subagents 自动回传。

## 已验证行为

- Research 单 lane 异步冒烟：成功加载私有 `research-executor`，调用 `web_search`/`web_fetch` 并生成 artifact。
- Code Review 并行冒烟：`standards` 与 `spec` 两个 reviewer 均以 fresh context 完成，分别生成结构化输出 artifact，且未修改项目文件。



上游快照位于 `vendor/mattpocock-skills/`，固定 commit 记录于 `vendor/UPSTREAM_SHA`。vendor 不在 Pi skill discovery 或 agent `skillPath` 中，但它是可追踪的项目源文件，并非路径级安全沙箱。

上游使用 MIT License，原文保留在 `vendor/mattpocock-skills/LICENSE`；归属说明见 `NOTICE.md`。

## 下一阶段

当前刻意不实现万能 router、动态多写者、自动导入全部 skills 或跨 harness 兼容。后续顺序：

1. `code-review`：父会话编排 Standards/Spec 两个独立 reviewer lane。
2. `tdd`：展开 `codebase-design` 依赖，使用唯一 worker 执行 red-green-refactor。
3. `tdd`：展开 `codebase-design` 依赖，使用唯一 worker 执行 red-green-refactor。
