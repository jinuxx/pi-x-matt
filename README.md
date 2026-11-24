# pi-x-matt

`pi-x-matt` 将 [mattpocock/skills](https://github.com/mattpocock/skills) 的工程方法论移植为纯 Pi Agent + `pi-subagents` 的轻量项目级能力。

v0.3.0 回归“**确定性测试做门禁，LLM Review 做建议，人类始终拥有最终拍板权**”的简洁架构：

- **12 个交互式 parent**（留在父会话）：`matt-setup`、`matt-archive`、`matt-grilling`、`matt-domain-modeling`、`matt-grill-with-docs`、`matt-wayfinder`、`matt-to-spec`、`matt-to-tickets`、`matt-implement`、`matt-implement-spec`、`matt-diagnosing-bugs`、`matt-improve-codebase-architecture`。
- **6 个执行型 parent**（经 `pi_matt_dispatch` 走角色隔离 subagent）：`matt-tdd`（单写者 + 可选确定性 `verifyCommands`）、`matt-code-review`（双轴建议型只读评审）、`matt-research`、`matt-prototype`、`architecture-scan`、`architecture-design`。

## 安装与配置

要求 Pi `1.2.0+`、Node.js `22.19.0+`，配套固定 `pi-subagents@0.90.0`：

```bash
pi install -l npm:pi-subagents@0.90.0
pi install -l git:github.com/jinuxx/pi-x-matt@v0.3.1
```

若要保持最小加载（不加载 `pi-subagents` 自带 skills/prompts/builtin agents），在目标项目 `.pi/settings.json` 中使用：

```json
{
  "packages": [
    {
      "source": "npm:pi-subagents@0.90.0",
      "autoload": false,
      "extensions": ["+bundle/index.js"],
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

升级 extension 或 `lib/*.mjs` 后请完整重启 Pi 并恢复会话；仅修改 `SKILL.md` 时使用 `/reload`。

建议在用户级 `~/.pi/agent/extensions/subagent/config.json` 中配置 `"autoResume": false`（避免重启后意外重放）与 `"disabledFeatures": ["session-sharing"]`（禁用 Gist 分享）。

## 提示中的测试术语

- **测试切入点**：用哪个公开入口来验证行为（例如通过公开 API/命令验证，而不直接检查内部实现）。
- **可替换点**：不改调用方就能替换依赖的位置（例如将远程存储替换为内存实现）。

## 架构与角色隔离

系统分为三个清晰边界：

1. **父会话 skills**（`.pi/skills/`）：负责需求澄清、规格/拆票、编排决策、验证与提交。
2. **四个只做一件事的 leaf agents**（`.pi/agents/`，均设置 `inheritSkills: false`、`maxSubagentDepth: 0`）：

| Agent | 权限 | 用途 |
| --- | --- | --- |
| `matt-worker` | 读写与命令（优先 `apply_patch`，回退 `edit`/`write` + `bash`） | `matt-tdd`、`matt-prototype`、`architecture-scan` |
| `matt-reviewer` | 本地只读 + `git_read`（50 次取证预算） | `matt-code-review` 的 Standards / Spec 两轴 |
| `matt-reader` | 本地只读 | 代码库探索与 `architecture-design` 三方案比较 |
| `matt-researcher` | `read`、`web_search`、`web_fetch` | `matt-research` |

3. **私有 leaf skills**（`skillpacks/leaf/`）：只由对应 agent 的 `skillPath` 加载，不污染父会话 catalog。

### 为子代理指定模型

本插件不接管模型选择；按需在 `<项目>/.pi/settings.json` 或 `~/.pi/agent/settings.json` 的 `subagents.agentOverrides` 中为 `matt-worker`、`matt-reviewer`、`matt-researcher`、`matt-reader` 配置 `model` / `thinking`，修改后 `/reload` 并用 `/subagents-models` 核对。

## 核心工作流

### 1. 需求澄清 → 规格 → 拆票 → 实现

- 首次使用在父会话运行 `/skill:matt-setup`，配置本地 `.x-matt/` tracker、领域文档布局与本机 Git exclude。
- `matt-grill-with-docs` 澄清需求后，小改动经确认可直接衔接 `matt-implement`；多流程或跨会话需求可平滑衔接 `matt-to-spec` → `matt-to-tickets` → `matt-implement-spec`。
- 跨会话大型模糊规划使用 `matt-wayfinder`；难复现 bug 使用 `matt-diagnosing-bugs`；架构梳理使用 `matt-improve-codebase-architecture`。

### 2. 单票实现与批次实现

- **`matt-implement`**：调用 `pi_matt_dispatch({ workflow: "matt-tdd", task, verifyCommands })`。
  - 在受信任项目内直接执行，不重复弹出写者确认框。
  - 默认只跑单写者 TDD + 确定性 `verifyCommands`，**不自动发起每票 code review**。
  - 若需续修，可传 `resumeRunId` 续跑原 `matt-worker`，也可省略该参数随时开 fresh writer 或在父会话直接修正。
  - 核对 `git diff --stat` 与测试通过后，提交到当前分支并在本地把 ticket 写为 `resolved`（附 `Implementation commit: <SHA>`）。
- **`matt-implement-spec`**：在父会话按 `Blocked by` 顺序逐票执行 `matt-implement`，全部完成后跑全量测试并调用一次 committed `matt-code-review` 做整批建议型评审。

### 3. 建议型双轴 Code Review

```json
{
  "workflow": "matt-code-review",
  "task": "评审背景与目标",
  "reviewScope": { "kind": "worktree" },
  "laneTasks": {
    "standards": "适用工程规范与隐私/安全边界",
    "spec": "ticket 或 parent spec 验收条款"
  }
}
```

- 支持 `reviewScope: { kind: "worktree" }`（当前工作区变更）与 `{ kind: "committed", fixedPoint: "<ref>" }`（纯 Git 对象范围 `F..HEAD`），由宿主自动生成一份共享 Evidence Pack 供两轴复用。
- 两轴评审为**建议型（Advisory）**：`PASS`、`ISSUES`、`NO_EVIDENCE` 均正常结算返回结构化报告，不会抛错锁死流程；由用户与父会话决定修复哪些 P0/P1、忽略哪些 P2。
- 某轴若遇 429 或网络故障，直接传 `lanes: ["standards"]`（或 `["spec"]`）重跑该轴即可。

### 4. 控制命令

- `/matt-reset`：一键清除当前卡住的活跃派发跟踪与队列状态（已在运行的子代理用 `/subagents-stop` 停止）。

## 本地隐私与归档边界

- 业务项目按 [业务项目隐私契约](.pi/skills/matt-setup/privacy.md) 通过本机 `.git/info/exclude` 排除整个 `.x-matt/` 与个人 `.pi/`，不修改团队 `.gitignore` 或 `AGENTS.md`，本地入口写在 `.pi/APPEND_SYSTEM.md`。插件源码仓库本身为例外，只排除整个 `.x-matt/`，`.pi/` 作为 package 源码保持跟踪。
- 提交前检查 staged diff 与提交信息，不夹带私有路径或自动 AI 归因。
- 已完成 feature 由用户显式运行 `/skill:matt-archive <feature-slug>` 本地移入 `.x-matt/work/shipped/`（不创建提交）；所有 skills 默认把 `shipped/` 视为不存在。

## 维护者命令

```bash
npm run registry       # 生成 config/skill-registry.json
npm run registry -- --check
npm run drift          # 检查 vendored 上游漂移
npm run test           # 运行测试套件
npm run check          # test + registry freshness + upstream drift
npm run pack:check     # 检查发布包文件清单
```
