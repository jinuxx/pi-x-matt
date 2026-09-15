# Changelog

## 0.2.10

- `matt-tdd` 的运行时确认改为来源感知：本 session 由用户 `/skill:matt-implement` 显式发起时直接放行；模型自行走到 TDD 时才要求确认，无 UI 或取消仍 fail closed。

## 0.2.9

- 在 grilling 确认 shared understanding 后强制交还控制权，由用户显式选择 `matt-to-spec`、单 slice `matt-implement` 或暂停；`pi_matt_dispatch` 在 `matt-tdd` 入队前增加 TUI/RPC 用户确认，无 UI 或取消时 fail closed。
- 将 `matt-tdd` 收口为 `matt-implement` 的内部、禁止 model invocation 的执行 parent；缺少 baseline/spec/ticket 时禁止父会话手写规划 artifact 解阻。
- Local Markdown spec/ticket 新增 `Source session` 追踪，并要求 spec 的 `Reference Inputs` 脱敏保留后续工作依赖、不能安全压缩的用户事实、说明、样例与约束，不限定具体项目或材料类型。

## 0.2.8

- 将 `mattpocock/skills` 上游快照从 `6654f6b` 同步到 `3cca18b`。
- 同步 `link-skills.sh` 对 `misc/` 技能目录的排除规则；本次上游没有修改已移植的 `SKILL.md`。

## 0.2.7

- 强制 Spec reviewer 先读取当前 ticket 与 parent spec、提取验收行为，再访问 diff、FFF 或实现文件。
- 增加 `reviewKind=worktree|committed|files` 契约，区分工作区、已提交范围和指定文件评审。
- 明确 tracked、untracked、deleted 与 rename 的逐文件证据语义，禁止用 `ref...HEAD` 作为工作区唯一证据。

## 0.2.6

- 为 Standards 与 Spec reviewer 增加逐文件证据边界、一级依赖限制和路径限定搜索，禁止目录级或全项目扫描。
- 为 `matt-reviewer` 增加只读工具预算，并要求证据不足时快速返回 `NO_EVIDENCE`，继续保持 PASS-only gate。
- 在 standalone review 与 TDD review 任务中要求具体 changed files、标准/spec 路径和 module/package 搜索边界。

## 0.2.5

- 将 TDD worker 限制为 RED/GREEN 聚焦测试与相关回归，完整测试套件和最终验证改由父会话执行。
- 增加测试价值判断，避免为重复覆盖、低风险机械变更和无意义边缘情况新增独立测试，同时保留显式验收与高风险行为的测试要求。

## 0.2.4

- 为本地代码读取、评审和实现子代理开放 `fffind` 与 `ffgrep`。
- 为唯一写者 `matt-worker` 开放 `apply_patch`，并将其声明为 mutation tool。
- 在安装说明中列明 FFF 与 Codex minimal tools provider。

## 0.2.3

- 在 workflow lane 缺少合法结构化输出时优先报告子代理的 timeout、provider error、termination、turn budget 等真实失败原因。
- 明确 `git_read` 的 `diff-files` action 也必须提供 `ref`。

## 0.2.2

- 在 `matt-setup` 中内置 canonical Local Markdown Wayfinding 路径、字段和模板，并在写后拒绝不兼容的 `Claim:` 与 decision ticket 路径。
- 从 Pi 提供的 skill location 定位 package registry，区分 registry metadata 与 package resource 暴露。
- 统一 Wayfinder decision ticket 的 `Type:` 短名称与 `matt-*` resolver 名称。

## 0.2.1

- 取消 `pi-subagents` 的版本绑定，由目标项目安装当前可用版本。

## 0.2.0

- 将 tracker、领域上下文、ADR、spec、tickets 与 Wayfinder 文档统一收口到 `.x-matt/`。

## 0.1.0

- 首次发布 Pi-native Matt Pocock 工程工作流。
- 提供 `matt-*` parent skills、受限 agents、结构化 dispatcher，并依赖 project-local `pi-subagents` runtime。
- 支持项目级 Git package 安装，并将 package 校验根与目标代码库根分离。
