# Context Pack & Evidence Pack

父会话传递精简、直接可用的上下文，让子代理直奔主题、避免重复扫描全仓。

## Implementation Context Pack（传给 `matt-tdd`）

在 `task` 中按需包含以下要点即可（无需手工算文件 hash 或猜测完整写入清单）：

- **目标与验收**：ticket 全文或准确验收清单、非目标边界。
- **测试切入点**：从哪个公开入口测、预期行为、哪些低价值机械映射可省略。
- **关键文件指针**：相关源码、测试与一层直接调用者的路径及核心 symbol。
- **聚焦命令**：RED/GREEN 单测命令及已知环境/工具链前缀（如 `JAVA_HOME`、离线参数 `mvn -o` 等），避免子代理重复探测环境；全量测试由父会话收尾执行。
- **隐私边界**：将隐私边界同步交给 worker 与 reviewer：业务项目的 `.x-matt/` 与个人 `.pi/` 仅本地保存，不把工具/模型/会话信息写进业务代码或提交。

## Review Evidence Pack（`matt-code-review` 自动采集）

调用 `matt-code-review` 并传入 `reviewScope` 时，宿主在启动 reviewer 前自动采集一份只读 `review.md`：

- `reviewScope: { kind: "worktree" }`：采集当前工作区 `HEAD` diff、变更文件清单及 untracked 文本全文。
- `reviewScope: { kind: "committed", fixedPoint: "<ref>" }`：纯从 Git 对象库采集 `F..HEAD` 的提交范围，不混入未提交的工作区改动。

两轴 reviewer 共享同一份 Pack；`laneTasks.standards` 附适用工程规范，`laneTasks.spec` 附验收标准/parent spec。
