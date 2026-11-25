# Changelog

## 0.3.3

- **修正工作流结果读取规范**：移除 `matt-tdd/results.md` 中“优先读取 `*_output.md`”的指引（避免与 `matt-research` 等 skill 的结构化结果要求冲突或漏读 `hostVerification`），改为明确禁止把原始 `*_output.md` 当作结构化结果、禁止整文件 `read` `status.json`，并提供单行 `node -e` 权威摘要抽取命令。
- **强化中间通知覆盖指令**：在 `matt-tdd/results.md` 与 `pi_matt_dispatch` 提示中显式覆盖 `pi-subagents` 附加在 `Status: workflow still running` 通知末尾的 `Parent action`，要求不调用工具、简短回应并等待最终 `workflow` 完成通知。
- **补齐续跑评审起点的 Git 边界处理**：`matt-implement-spec` 续跑按 Git 祖先历史上最早 `Implementation commit` 的第一父提交（`<commit>^1`）确定默认起点，对根提交无父提交或历史分叉场景保留通俗中文澄清兜底。

## 0.3.2

- **放宽 `matt-tdd` 超时并减少重编译项目过度切片**：将 `matt-tdd` 的 `implement` lane 超时从 20 分钟调整为 35 分钟（`2100000ms`）；在 `tdd-executor` 中明确禁止额外的代码破坏/变异探针，并允许在 Maven/Gradle/Cargo/C++ 等重编译项目中按完整行为切片组织 RED→GREEN；在 Context Pack 中引导携带已知工具链/环境参数（如 `JAVA_HOME`、`mvn -o`）。
- **消除超时增量通知提前唤醒与 `status.json` 截断误报**：在 `matt-tdd/results.md` 与 `pi_matt_dispatch` 提示中要求静待最终 `workflow` 完成通知，避免 `implement` 超时且 `implement-settlement` 仍在运行时的提前介入；明确优先读取 `*_output.md` 并按需抽取 `status.json` 摘要字段，避免全文读取超长 `status.json` 被截断。
- **优化续跑体验与日志去重**：`matt-implement-spec` 续跑时自动以最早已解决票的 `Implementation commit^` 作为默认评审起点并禁止向用户抛出 `fixedPoint` 等内部字段名；`dispatch-service.mjs` 对重复的 `subagent:child-status` 阶段事件去重。

## 0.3.1

- **移除多余二次确认弹窗**：删除 `lib/dispatch-authorization.mjs` 的 `ctx.ui.confirm` 写者弹窗与 `/matt-revoke` 命令，信任边界直接对齐 Pi 原生 `ctx.isProjectTrusted()`，消除“刚触发 implement 又弹窗授权”及多票切换 `verifyCommands` 反复弹窗的摩擦；保留 `/matt-reset` 与单写者并发防重。
- **精简 4 处 skill 重复确认**：`matt-implement-spec` 列出计划后直接推进不重复停下询问；`matt-setup` 将 4 轮分段确认合并为写入前一次确认；`matt-prototype` 问题明确时直接构建、构建失败自动修正；`matt-diagnosing-bugs` 验证已选假设时可直接加临时 `[DEBUG-<id>]` 探针并在修复前清理。

## 0.3.0

- **彻底减负重构（Breaking）**：移除过度防御的跨轮状态机与 12 种特化恢复通道（`batch-authorization`、`diagnostic-workspace`、`repair-contract`、`review-contract`、`final-validation`、`risk-acceptance`、`writer-scope`、`scoped-writer`），将运行时核心重写为轻量 `dispatch-service.mjs` 与精简版 `dispatcher-core.mjs`。
- **简化 `pi_matt_dispatch` 接口**：从 14 个互斥控制块精简为 7 个正交参数（`workflow`、`task`、`laneTasks`、`lanes`、`resumeRunId`、`verifyCommands`、`reviewScope`）；新增 `/matt-reset` 一键清理卡住状态。
- **解耦 TDD 与 Code Review**：`matt-tdd` 改为纯单写者 `single` lane（默认只跑确定性 `verifyCommands`，不再每票自动触发双轴评审）；支持随时传 `resumeRunId` 续跑或直接开 fresh writer，彻底消除自锁。
- **建议型（Advisory）双轴评审**：`matt-code-review` 移除硬性 `verdict === PASS` gate，简化 findings schema（5 字段），支持 `reviewScope: { kind: "worktree" | "committed" }` 与 `lanes` 单轴重跑，由用户与父会话决定修复或忽略。
- **回归标准 `matt-worker` 与轻量会话授权**：取消写前路径猜测与受控写工具限制，恢复完整 `apply_patch`/`edit`/`write`/`bash`；写授权改为同会话同项目一次确认，调用其他 `/skill` 不再静默撤销授权。
- **打通前置需求链**：`matt-grill-with-docs`、`matt-to-spec`、`matt-to-tickets` 经用户确认后可直接衔接下一阶段，取消强制停机手敲命令壁垒，同时完整保留 `.x-matt/` 与个人 `.pi/` 本地隐私边界及 `shipped/` 默认不可见规则。

## 0.2.53

- 新单票和 `matt-implement-spec` 批次先核实源码/测试目录，再一次批准每票的窄目录或精确文件。目录内新文件无需逐个授权。越界写入前暂停；只确认当前票新增范围，原 writer 用剩余预算继续，其他票不继承。既有精确清单不自动升级，验收、候选提交核验与整批集成评审门禁不变。
- 取消扩围保留原授权，等待用户回复不扣执行预算。受控 writer 沿用原模型和思考档，在原项目环境运行获批原命令；验证改动 Git 候选或索引时阻止交付。批次超时续跑仍只补验证和报告。

## 0.2.52

- 修复 [#10](https://github.com/jinuxx/pi-x-matt/issues/10)：单票首次 writer 超时且具备可信快照时，可自动续跑同一 writer 20 分钟，在原授权范围内继续未完成的代码和测试；再次超时才须确认第二次续跑。越界或漂移时保留候选并停止，不恢复未封存的旧单票；批次规则不变。

## 0.2.51

- 修复 [#7](https://github.com/jinuxx/pi-x-matt/issues/7)：批次首次 writer 超时且 settlement 返回 `BLOCKED` 时，宿主核验原候选并自动续跑同一 writer 20 分钟；再次超时才须确认第二次续跑。原失败记录与交付门禁保留，候选漂移或缺证时停止。

## 0.2.50

- 将 project-local runtime 与 bundled library 同步到 `pi-subagents@0.90.0`。上游未弃用本插件使用的公开接口；继续使用 named resource、RPC 和结构化结果，不加旧接口回退或重复的生命周期监听。
- 已结束 workflow 可被上游回收；宿主报告缺失证据的 run ID 与路径，阻止缺证恢复。完成通知先于 `status.json` 终态落盘时同样不结算，不新增轮询或重派。
- 文档推荐用上游 `disabledFeatures` 的 `session-sharing` 关闭 Gist 分享，不自动修改全局配置。

## 0.2.49

- 同步 Matt Skills 上游 `abeeaf9`，采用严格 YAML frontmatter 校验，并从实验性 `software-factory` 吸收“先确定性检查、限制修复循环”的做法。未引入其调度体系。
- 新实现按风险确定交付门禁：普通票通过绑定候选的宿主检查后不启动 reviewer；高风险票独立双轴复核，初审后最多修复一次。批次普通票不逐票重复跑完整测试，全部票完成后统一做集成检查和一次独立评审。
- 旧信封未声明 `delivery` 时仍按原双轴规则。批次授权、精确提交校验、tracker 和隐私边界不变。需要完整重启 Pi 才能载入 runtime 更新。

## 0.2.48

- 修复 [#6](https://github.com/jinuxx/pi-x-matt/issues/6)：并发刷新同一派发时，宿主只在首次封存失败快照后提示一次 `blockedRecovery`。提示不再推断测试是否启动。
- 恢复提示与 writer 结算进度在 TUI/RPC 即时显示，不排入父会话；恢复入队后不会再收到旧派发的恢复指令。授权、快照校验和评审门禁不变。

## 0.2.47

- 将 project-local runtime 与 bundled library 同步升级到 `pi-subagents@0.89.2`。此次上游未移除本插件使用的公开接口；继续使用 named resource、结构化结果和现有最小权限，不新增旧接口回退。
- 为 workflow lane 使用固定的原生 `label`，在 Fleet 与会话标题中区分 writer、双轴 reviewer 和恢复步骤，不从任务正文取标题。
- 直接采用上游的工具替换早失败、adapter v7 `openUi: false` 缓存匹配和失联 runner 终态对账。确认 runner 已退出仍不等于已观测退出；不触发自动重派或绕过交付门禁。

## 0.2.46

- 显式运行 `/skill:matt-implement` 后，已确认范围内的常规测试方案直接执行；新签发并已绑定范围的单票授权不再因时间经过而过期。
- 新批次只需确认一次精确计划，不按时间过期；原生命令和本地文件不再替代确认。`/matt-revoke` 作废旧确认，并可阻止 RPC 已交接但尚未取得启动权的 writer。
- 评审前命令先核对候选范围；本地计划的最终验证必须对当前候选通过才能推进。预批命令触发续修时不重复确认，风险接受不能豁免失败的宿主校验。
- worker 仍不是沙箱；仅在受信任的仓库和命令范围内运行。

## 0.2.45

- 修复 [#5 的后续反馈](https://github.com/jinuxx/pi-x-matt/issues/5#issuecomment-7033822370)：已修复的最终验证通过且候选再次双 PASS 后，同一票可经用户确认登记另一条失败命令；尚未解决的命令不得替换。
- 保留已登记命令及失败证据，全部通过才重新送审，同一票仍最多续修两次。兼容 v0.2.44 已保存的单命令验证回执。

## 0.2.44

- 修复 [#5](https://github.com/jinuxx/pi-x-matt/issues/5)：批次当前票双 PASS 后，父会话可用 `finalValidationRepair` 申请确认一条最终验证命令。宿主确认本票基线通过、未漂移的候选真实失败后，只续跑原 writer，不伪造 reviewer finding。
- 证实回归后旧 PASS 不再放行。新候选必须通过同一命令、fresh 双轴复审及原有 commit/tree/parent 和 tracker 核验；派发取消、证据漂移或 writer 不可用不会解锁当前票。

## 0.2.43

- 修复 v0.2.42 发布后的 CI 失败：README 安装和更新命令的 tag 由测试与 `package.json` 的版本比对，不再依赖硬编码的旧版本。
- 运行时行为不变，包含 [#4](https://github.com/jinuxx/pi-x-matt/issues/4) 的 `blockedRecovery` 修复。

## 0.2.42

- 修复 [#4](https://github.com/jinuxx/pi-x-matt/issues/4)：批次当前票首次因外部环境无法启动聚焦测试时，可在环境修复后用 `blockedRecovery: {dispatchId}` 经用户确认续跑同一 writer 一次，不重发 initial。
- 保留测试草稿、原失败及 TDD 基线；缺少失败快照、原 writer 不可恢复或证据漂移时拒绝续跑。未启动的测试不算 RED，宿主检查、双轴评审和批次交付门禁不变。
- 升级后完整重启 Pi。旧版本未保存失败快照的派发不补认；本版以自动化回归验证恢复与拒绝路径，未复跑原 Maven 场景。

## 0.2.41

- 将 project-local runtime 与 bundled `pi-subagents` 同步固定到 `0.88.1`；核对六项补丁及公开接口，Pi/Node 下限、bundle 入口、RPC/named resource 与双轴 gate 不变，不误删仍有效的 `disableBuiltins` 等配置。
- 移除 workflow child 已不存在的 `timedOut` 字段兼容和错误文本超时猜测；settlement 与通知只依据公共 `terminalOutcome.reason === "timeout"`，错误引用超时文字或预算耗尽不再误启恢复。
- 修复共享 agent 对 pi-fff 模式的隐含依赖：`matt-reader`/`matt-reviewer`/`matt-worker` 原先显式声明 `ffgrep`、`fffind`，而这两个名称只在 pi-fff 非 `override` 模式注册；声明了子进程里不存在的工具，child 会在 `agent_start` 抛出工具诊断而失败（运行时源码如此，并非 0.88.1 新行为）。本机 pi-fff 在上次真实冒烟之后切到 `override`，按源码推断这条链路会因此失败；该失败未用真实 child 复现，待完整重启后的冒烟确认。现统一声明在所有模式下都存在的 `grep`/`find`，reviewer budget 与 grilling 指引同步；`ff` 名称并非上游弃用，仍可经个人 override 追加（须同步 `toolBudget.block`），不自动改动个人配置。
- 直接采用原生的 fleet 对话框让位、compaction 唤醒与终态竞态修复，不新增轮询/唤醒/兜底；四个 leaf 保持显式 tools，researcher 保持精确 MCP selectors，不把 ambient MCP 修复变成权限继承，也不把 `subagent_launch` task 改写宣称为 RPC 审批。
- 新增四项回归，升级前确认失败、适配后通过：旧超时字段/文本不得触发 settlement 或通知、结果先于终态落盘保持运行中、required child extension 提供的 MCP server 与精确工具选择。原生 sandbox/权限回归使用 mock child/model 与 PID liveness，不替代真实模型、实际 runner 退出观测或 TUI 验证。
- 完整重启 Pi 后，`0.88.1` + Pi `1.5.2` 的真实冒烟通过：Research 与双轴 Review 正/负例共 5 个 fresh child，模型与 override 映射一致，无 settlement 或自动重试，仓库在运行前后未变。Review 正例两轴 PASS；负例两轴分别命中预置缺陷（各 1 项授权绕过与 2 项金额计算，均 P1），workflow 按 gate 失败且不发布 `workflow.value`，完整报告仍可从最后一个阶段快照读取。Research 走 Exa 精确选择器（`read` 加两个 `mcp__exa__` 工具，无额外 MCP 工具）。
- 该冒烟同时以真实 child 验证了 `grep`/`find` 修复：本机 pi-fff 处于 `override` 模式，reviewer 子会话注册到的是 `grep`/`find` 并成功启动。`matt-reader` 只被 `architecture-design` 使用，需要用户先确认设计问题，本轮未实跑；`matt-worker` 的 TDD writer/repair 链同样未实跑，两者的契约回归仍只使用 mock 结果。

## 0.2.40

- 修复完整候选因信封越界而丢失证据：collector 在拒绝前保存只读 `review.md/json`，结构化记录 `envelopeViolation` 与未声明路径；覆盖普通文件及仅暂存区越界，不启动 reviewer。
- 新增显式 `recollect: {dispatchId}`：复用已有单票重新确认，只允许增加 `allowedFiles`，随后仅运行 collector，不重跑 writer、宿主校验命令或 reviewer；成功仍待显式 `review`。
- 恢复绑定最新派发、原候选/index/Pack 与基线，保留已完成 writer、宿主校验证据、repair findings/计数和 batch binding；未确认、缺证、漂移、宿主校验失败及其他执行失败仍拒绝，不改变 batch candidate tree、commit parent/tree 和 tracker 门禁。
- 文档明确 `allowedFiles` 是权限清单，条目可尚不存在，未使用的声明不构成改动承诺；越界错误列出路径和恢复指引，不再以原始 `ENOENT` 收场。
- 本地 281 项测试、registry freshness 与 31 个移植来源的 upstream drift 检查通过；包含原生受限 runtime 中无 child session 的仅重采集回归，模型结果使用 mock，未在反馈的业务项目端到端复跑。
- 升级后须完整退出并重启 Pi，再恢复原会话，仅 `/reload` 不够。旧版本已经丢失 Pack 的失败无法自动补认当前工作区，需保留原实现与失败证据，由用户另行决定。

## 0.2.39

- 测试提示统一使用“测试切入点”，架构中表示依赖替换位置的术语改为“可替换点”；补充直白解释，保留既有协议字段及上游原文。
- 新增术语回归，检查活动 skills、任务前缀和相关说明不再使用含糊的英文术语，并确认原有结果字段与门禁保持兼容；不改变运行逻辑、权限或依赖。
- 全套首轮 271 项通过；余下 1 项旧 tag 断言同步后，26 项 registry 测试复验全过。registry freshness、31 个移植来源的 upstream drift 与打包检查通过；未在业务项目实跑。

## 0.2.38

- 修复大于 4 KiB 的 TDD 证据回执被 stdout 预览截断：完整回执保存在宿主只读文件，超过单帧时用精确授权的只读命令读取有界帧，核对顺序、长度与同一结果摘要后才启动 reviewer；保留全部 candidate 和 changedPaths，不提高上游预览限制。最多 24 帧，超限或损坏直接停止，不裁剪证据。
- 旧派发若 writer 已合法 COMPLETE、collector 成功且仅回执 JSON 解析失败，可显式 `review`：宿主核验原授权、最新谱系、完整 Pack/Markdown、HEAD/工作区/index 与 batch tree 绑定，只启动两轴 reviewer，不重跑 writer 或 collector；缺证、漂移和其他失败仍停止。
- 271 项测试、registry freshness、31 个移植来源的 upstream drift 与打包检查通过；原生兼容回归使用真实 sandbox、host command 与精确命令授权，模型 child 使用 mock，未在业务项目复跑。升级后须完整重启 Pi 并恢复原会话，仅 `/reload` 不够。

## 0.2.37

- 修正 finding 交代校验：即使获批 findings 已全部覆盖，只要存在重复、未知 ID 或其他无效记录，`accounting.ok` 仍为 `false`，与既有契约保持一致。
- 送审准入同步识别无效交代记录，原 writer 可恢复时拒绝绕过该失败；保留原 writer 不可恢复时的既有送审出口，不改 batch、命令执行时机或恢复规则。
- 264 项测试、registry freshness、31 个移植来源的 upstream drift 与打包检查通过；兼容测试使用 mock child，本次未在业务项目复跑。
- 补充完整覆盖混入无效记录的单元回归与送审准入回归；`.mjs` 更新后须完整重启 Pi 并恢复原会话，仅 `/reload` 不够。

## 0.2.36

- 新增宿主确定性校验，把可机械检出的问题拦在双轴评审之前：`implementation.preReviewCommands` 可选声明最多 6 条本地命令（共享 10 分钟预算、须在基线通过且不写工作区），随授权信封一并确认，并在每次 writer（初次实现/repair/writerRecovery）返回 `COMPLETE` 后、任何 reviewer 之前由宿主原样执行；implement task 事先列出这些命令。
- 校验未通过且 writer 可恢复时，宿主在同一 workflow 内 resume 同一 writer 纠正一次（最多 10 分钟）并复检，结果记入 `implement.hostVerification`，工具 receipt 只带不含命令输出的 `verification` 摘要；`review` 在 repair 候选校验仍失败时被宿主拒绝并说明失败命令或未交代的 finding，须继续同范围 repair，初次实现即使双 PASS 也不可交付。
- 唯一放行出口是用户重新确认一份不含该命令的信封（`waived="pre-review-command-withdrawn"`），父会话不得自行删减；batch `resultsValid` 同样要求该票校验通过。
- 新增 repair 的 `findingResolutions`：writer 须对每个获批 finding 恰好交代一行（`findingId`/`cycleTest`/`evidence`），宿主在评审前核对完整性并写入 reviewer 证据；它是自述交代，不是已修复的证据，也不改变双轴 gate。
- 诊断门提前：修复经正式评审后，验收/安全/完整性类 finding 仍以原问题或同一 `rootCauseId` 复发时，下一次 writer 前即触发 `DIAGNOSIS_REQUIRED`，相关回归立即触发；纯工程规范类（`basis.kind=standard`）复发仍按两轮计数，连续两次未评审的 repair 不触发该规则。
- 263 项测试、registry freshness、31 个移植来源的 upstream drift 与打包检查通过，包含用已安装 `pi-subagents` 0.88.0 真实校验器与 sandbox 执行生成脚本的兼容用例；child 使用 mock 结果，未在真实 Pi 会话端到端跑过带 `preReviewCommands` 的 ticket，也未在业务项目复跑。
- 已知边界：该门只拦得住获批命令能检出的问题，宿主不预先验证基线是否绿灯，写文件的命令会被判为漂移且不触发纠正，命令失败输出的尾部会进入纠正 task 与 reviewer 证据，因此不要声明会打印敏感信息的命令；`findingResolutions` 只核对完整性，不核对真实性。
- extension 与 `.mjs` 更新后须完整重启 Pi 并恢复原会话，仅 `/reload` 不够；固定旧 tag 的项目需按 README 用 `pi install -l` 切换版本。

## 0.2.35

- 新增显式 `writerRecovery: {dispatchId}`，解除最新失败 repair 无法延续原 writer 的宿主死锁：只允许可恢复且无结构化结果的失败 repair 恢复一次，绑定 partial 快照并保留原失败、修复契约/计数与累计评审基线；不换 fresh writer、不追加 settlement，成功仍待正式双轴 review。
- 增加并发准入与首次失败快照的原子保护，启动前重读实时 branch/ticket；额外绑定 index 内容并拒绝越界暂存、无法证明的旧 staged 基线、ignored 获批文件及多余 reviewer task，保留私人文件不强制跟踪。
- 246 项测试、registry freshness、31 个移植来源的 upstream drift 与打包检查通过，包含原生 sandbox 的 retained writer 恢复契约；child 使用 mock 结果，未验证目标业务项目的真实 writer 恢复。
- 修正固定 Git tag 的升级指引：需切换项目 package source 到新 tag，并完整重启 Pi、恢复原会话；只对旧 ref 执行 update 或仅 `/reload` 不足。

## 0.2.34

- 将 project-local runtime 与 bundled `pi-subagents` 同步固定到 `0.88.0`，包含 `undici@8.12.4` 安全修复；核验 Pi/Node 下限仍为 `1.2.0`/`22.19.0`，最小加载入口仍为 `+bundle/index.js`。
- 核对 0.85–0.88 的更新与废弃边界：保留现有 RPC、named resource/host grant、封闭 schema、双轴 gate 和事件订阅，不把新增 `subagent_launch` 审批误称为覆盖 RPC，不引入自动换模型、drain 或绕过受限进程的 fallback。
- 四个 leaf 显式设置 `inheritGlobalContext: false`，避免 0.87.0 新增的全局继承默认值改变既有上下文边界；仍允许用户逐 agent override。原生 agent discovery 回归覆盖该默认值开启时的行为及精确 MCP 工具选择。
- retained writer 不可恢复时保留上游原因（例如 `missing recovery descriptor`）；补充 0.85.0 前启动 run 不可恢复的升级说明，禁止借重建 descriptor、`reuseFrom` 或 fresh writer 绕过原修复谱系。
- 同步 0.88.0 的执行预算语义：supervisor decision/interview 与 intercom ask 等待不计入 child timeout，通知不再把 300 秒结算预算描述为 wall-clock 上限。输出长度截断仍按执行失败处理，回归确认不解析 partial output、不自动结算或启动后续阶段。
- README 增加逐版本适用性与 MCP 检索工具 override 指引；完整重启并 reload 后，0.88.0 + Pi 1.5.2 的真实 Research 与双轴 Review 正/负例冒烟通过：共 5 个 fresh child，Exa search/fetch、结构化结果、模型映射、并行执行与失败结果保留均核验，无 writer、settlement 或自动重试，仓库在子代理运行前后未变化。TDD writer/repair 链本轮未实跑。
- 230 项测试、registry freshness、31 个移植来源的 upstream drift 与打包检查通过；sandbox 契约覆盖已安装的 0.88.0 受限进程，child 使用 mock 结果，不冒称真实模型验证。

## 0.2.33

- 将 project-local runtime 与 bundled `pi-subagents` 同步固定到 `0.84.0`；Pi/Node 下限仍为 `1.2.0`/`22.19.0`，最小加载入口仍为 `+bundle/index.js`。
- 该版本修复 workflow 脚本可越过 sandbox 访问 Pi 进程的安全问题（GHSA-6v8j-6w28-2w8r）：脚本现在运行在独立 realm，无法设置 `Error.prepareStackTrace`，`import()` 在运行前即被拒绝。本 package 生成的脚本不使用这些能力，dispatcher、sandbox 与 gate 契约保持不变。
- 后台 run 的过期清理恢复生效；受限 agent 因 provider 未加载而失败时会指明 provider 与加载方式，不影响现有四个 `matt-*` agent。
- 228 项测试、registry 与 upstream drift 检查通过，覆盖已安装 `0.84.0` 的脚本 sandbox、bundled resource 注册、stage 结果契约与 committed review 采集。
- 修正随版本演进漂移的子结果契约：workflow 子结果只带 `terminalOutcome: { state, reason }`，不再有 `timedOut`/`turnBudgetExceeded`/`processSignal`/`exitCode`。超时结算恢复与 settlement 状态改按 `terminalOutcome.reason === "timeout"` 判定，文本匹配放宽到 receipt 包裹后的形态；失败诊断改报 `budget_exhausted`、`interrupted`、`detached`。
- 移除 `matt-reviewer` 的 `completionGuard: false`：该字段自 `0.70.1` 起已被上游删除，agent 文件不做未知键校验，因此长期只是静默无效配置。
- 真实子代理冒烟最近一次记录仍基于 `0.83.1`；本次升级后需完整重启 Pi 再重跑，仅 `/reload` 不足。

## 0.2.32

- 新增显式 `acceptRisk`：仅全部剩余 finding 为普通 Standards P2 且 Spec PASS 时，经真实用户对精确候选重新确认后成为 `accepted-risk` 终态。保留原 FAIL、原始结果与确认收据，不豁免验收、安全、数据完整性或 P0/P1，不按轮数自动降级；batch 仍核验精确 candidate/commit/tree/parent，并要求 tracker 写回风险收据，最终整份 committed 评审不继承单票风险接受。
- 修复根因分组把因果关联误当同根因：只按稳定 rootCauseId 续组，拒绝改名时列出期望 group IDs；回归仍须诊断。跨轴 task 自动补充 finding 来源与修复契约/保留行为摘要，不传另一轴 basis，移除只准同轴引用的矛盾提示。
- committed `matt-code-review` 支持一次失败轴 recovery，复用原 F/H 与完整 Pack/另一轴结果，校验 HEAD 和 JSON/Markdown 摘要，不重采、不重跑 writer 或有效 verdict。follow-up 仅需实际执行 lane 的 task，不再填写无关占位。
- 隔离诊断默认禁用 Python bytecode 与 pytest cache，不忽略任意目录或改写批准命令；专用新复现路径可提前同时列入 allowedFiles/diagnosticFiles，保留精确命令授权，不引入任意命令模板。通知区分供应商/网络故障与真实评审 FAIL，明确 writer settlement 状态与 partial 变更处置，不盲目自动重试。
- 228 项测试、registry、upstream drift 与打包检查通过；覆盖风险确认/候选漂移、batch 精确提交与风险收据写回、reload 后原 Pack 单轴恢复及原生 sandbox。未复跑反馈中的业务场景；升级后须完整重启 Pi，仅 `/reload` 不够。

## 0.2.31

- 修复 review location 行区间解析，并保留文件名内的冒号；误判错误包含有界的位置/变更路径提示。finding ID 统一为单一轴前缀身份，兼容裸 ID、本轴前缀及旧重复前缀，拒绝别名重复；未知修复 ID 列出有效集合。
- 旧宿主以 `review-evidence` 拒绝的完整报告，可在同候选和原 recovery 入口通过当前契约重校验；保留原报告、根因及纠错计数，不运行模型、不重新采证、不重置预算，仍非法或 schema/执行失败的报告不能豁免。
- reconsider 的决定结算与交付 gate 分离：合法 uphold/withdraw 返回动作完成及 `reviewPassed`/`remainingFindingIds`，仍有 blocker 时保持 effective FAIL，禁止提交或推进 batch；非法决定继续失败。
- 支持有真实变化影响证据、引用宿主已批准 ID 的跨轴 regression 因果关联；不混用两轴依据或裁决，回归仍触发诊断。scope 拒绝指出变化字段而不回显原始文案，保留精确授权边界。
- Spec `NO_EVIDENCE` 增加可执行补证提示：整份 spec 评审需向 `laneTasks.spec` 提供完整 active parent spec 与聚合 acceptance matrix 或可读原始来源，Git 对象 Pack 不代替规格。同步 parent/leaf、结果读取契约与回归覆盖。
- 214 项测试、registry、upstream drift 与打包检查通过；覆盖旧候选纠错 2/2 后重校验、reload 与原 writer 续链，以及原生 sandbox 的 uphold/withdraw 结算。未复跑反馈中的业务项目，不将回归测试表述为该业务场景的端到端通过；升级后须完整重启 Pi 并恢复原会话。

## 0.2.30

- 新增有界 finding 复核：对有证据争议的有效阻断项显式 `reconsider`，每个候选每轴最多一次，只运行受影响轴的 fresh reviewer，不重跑 writer、不重采证据；未挑战或被维持的 finding 继续阻断，最终双轴 PASS 门禁不变。
- 报告契约错误通过 `recovery` 单独纠正，每个候选每轴最多两次，与执行失败恢复分别计数；reload 或重新授权不重置预算，有效 FAIL 不得借报告纠错清除。
- 完善隔离诊断的虚拟环境说明与失败归因：允许显式批准项目绝对解释器命令，不复制或自动发现 `.venv`；区分命令不存在、不可执行、其他退出与目标症状不匹配，持久化仅保留退出状态和输出摘要。
- `matt-implement-spec` 新增有界批量授权：一次真实 TUI/RPC 确认冻结 parent spec、串行 tickets、精确文件与诊断信封，最长 24 小时；每票须匹配宿主捕获的双 PASS 候选及提交父节点，并完成一致的本地 tracker 写回，才推进下一票。未声明票、范围变化或候选漂移均停止，不自动扩权。
- `matt-code-review` 新增 `reviewScope: {kind: "committed", fixedPoint}`：宿主解析并固定 F/H、验证 ancestry，在两个 reviewer 前一次自动采集仅含已提交 Git 对象的共享 Evidence Pack，不混入 staged、worktree、untracked 或项目外内容；省略参数时保留原手动证据入口。
- committed collector 支持精确文件内容、变更与对象库路径；拒绝 partial/promisor clone 和不支持的二进制证据，采集不完整时不启动 reviewer。README、流程契约、registry 与回归测试同步。
- 功能实现经 Standards/Spec 双 PASS；重启后的只读采证冒烟通过，确认未混入本地配置改动且未改变 HEAD/工作区。extension 与 `.mjs` 更新后仍须完整重启 Pi，仅 `/reload` 不够。

## 0.2.29

- 修复同票重新授权后 repair/review/recovery 断链：宿主按 session、canonical project 与 ticket 查找最近未取消派发，不再按当前授权 invocationId 隔断历史。保留 ticket 内容、行为、branch/HEAD 与候选快照校验；新增文件或替换诊断清单仍须重新确认，旧 allowedFiles 不得移除。
- 跨授权延续原 writer、累计评审基线、findings、根因计数和 reviewer recovery 额度；新授权不能重开 initial 绕过已有谱系或诊断门禁。补充拒绝授权、reload、快照漂移、累计修复与局部恢复回归。
- 143 项测试及 registry/drift 检查通过，Standards/Spec 双轴均为 PASS。重启 Pi 并恢复原会话后，实际宿主负向探针确认能跨授权找到原 dispatch，并仍拒绝对非待审状态重复送审；不将该探针表述为新的真实 repair 实跑。
- 修正升级说明：extension 或 `.mjs` 模块变化后需完整重启 Pi，单独 `/reload` 不能保证清除已缓存模块。

## 0.2.28

- `matt-tdd` 解耦修复与正式送审：`repair` 只 resume 最近可恢复 writer、运行聚焦验证并采集候选快照，父会话核对证据后选择继续修复或显式 `review`；后者只运行 fresh Standards/Spec，不重跑 writer 或重复取证。多次修复累计到最近正式评审基线，保留授权、精确范围、原 findings、根因计数与诊断门禁；待审成功不授权提交，不可恢复时停止而非暗中换 fresh writer。
- Standards/Spec 完成限定范围检查后一次报告全部有证据的阻断项，移除发现首个问题即提前 FAIL 的指令；同步 parent/leaf、流程契约、registry 与针对连续修复、独立送审、候选漂移及原生 sandbox 的回归测试。
- 新增手动 `matt-implement-spec` interaction parent：仅对已有 Local Markdown spec/tickets 在当前分支按依赖 frontier 串行应用 `matt-implement`，每票独立 TDD、授权、完整验证、双轴复核、提交与本地状态写回；失败暂停，不创建 worktree、不扩展 dispatcher 的单写者约束。
- 全部 tickets 达到核验终态后，从原始 fixed point 到 HEAD 做一次整份 spec committed 双轴评审；续跑复核原始基线与实现提交 ancestry，不重复已完成票。最终 review 失败不自动开修复票或循环重评，不 push/PR，不改 parent spec 或自动归档。package manifest、registry、README 与授权/注册回归同步。
- 上游快照从 `mattpocock/skills` `3cca18b`（v1.2.3）同步到 `a496f55`（v1.3.2），`vendor/UPSTREAM_SHA`、全部 `pi-upstream-sha` 与生成 registry 一并更新；30 个已移植来源的 drift 检查通过。
- 跟随上游 v1.3.0 的领域文档重命名：`.x-matt/context/` 下的 `CONTEXT.md` 改为 `GLOSSARY.md`、`CONTEXT-MAP.md` 改为 `GLOSSARY-MAP.md`；domain-modeling、grill-with-docs、improve-codebase-architecture、to-spec、archive、setup、tdd、diagnosing-bugs、architecture 设计 lane、`.x-matt/agents/domain.md` 与 `issue-tracker.md`、README 与测试断言同步。
- `matt-setup` 检测 legacy `CONTEXT.md` / `CONTEXT-MAP.md`：列出精确路径、取得批准后用普通 `mv` 迁移（这些文件不被 Git 跟踪），未迁移则报告未配置；`.x-matt/agents/domain.md` 允许只读旧名但必须提示迁移，不并行维护两套名称。
- `matt-code-review`：改为强制搜索仓库标准文件（存在 `CODING_STANDARDS.md` / `CONTRIBUTING.md` 时必须在列），issue 引用经 `.x-matt/agents/issue-tracker.md` 取回而非猜测 CLI，两轴在一次 dispatch 中一起发出并前台聚合报告。
- `matt-tdd` 与 `tdd-executor`：每个候选 seam 附一行“抓到什么/漏掉什么”；forced RED 必须对 pristine 副本 `diff` 证明 mutation 真正落地，否则不算 RED。
- `matt-wayfinder`：real tracker 的 map/child 只带 `wayfinder:*` label、不打 triage label；第一遍创建取得真实 identifier，第二遍才写 blocking edges 与交叉引用，禁止占位符。
- `matt-to-tickets`：源是既有 parent spec issue 时把 ticket 建成它的 sub-issue；blocker 已用 native edges 表达时正文省略 `## Blocked by`，仅在 tracker 缺少原生关系时保留备用记录。
- `matt-grilling` 的问题措辞让“确认推荐项”等于回答“是”；`matt-implement` 收到 ticket reference 时先取回并陈述标题，有歧义先询问。
- `matt-setup`：GitHub/GitLab remote 必须以 `gh repo view` / `glab repo view` 可打印项目为完成定义；缺少 canonical label 时只给出用户需执行的创建命令，不代执行远端写操作，未创建保持未配置。
- TDD 新增可选 `implementation.diagnosticFiles`（`allowedFiles` 的精确子集）与 `repair.diagnosis.testFiles`；缺省时保持 v0.2.27 的范围对象形状，既有 grant/reload/repair 不受影响，授权确认会展示隔离诊断文件权限。
- 需要内联复现测试时，宿主先严格确认原工作区等于最近已审 `snapshotId`，再在自己的 OS temp 区从 HEAD 与已审未提交变更（含删除/重命名）重建项目，只写入获批诊断文件并执行原批准命令；退出码 1、目标失败文本、原快照前后不变且隔离区生产文件未变，才继续同一个 repair。GREEN、其他症状、超时、取消、快照漂移与越权改动均 fail closed。
- 诊断证据绑定原 dispatchId、已审 snapshotId/范围 hash、根因 IDs、命令、退出码、输出 hash 与测试 path/内容 hash；成功、失败与取消都清理宿主临时区，不联网安装依赖、不复制个人 ignored 资料，也不把该本机故障隔离称为安全 sandbox。无 `testFiles` 时保留原项目根诊断路径；30 秒、授权、repair lineage、唯一 writer 与 gate 不变。
- 内联诊断正文只在宿主 owned 临时区用于取得 RED；`repair.diagnosis.isolation` 与 implement lane handoff 仅保存准确 path 与内容 sha256，不再复制原文。父流程必须在提交 `testFiles` 前脱敏并只用合成/已脱敏 fixture；凭据只经环境变量，不写入测试/fixture/输出。不新增自动 DLP/redactor，也不承诺识别任意 secret/PII 或从会话记录抹去已提交的工具输入。
- 隔离诊断失败时不向持久化 trace 复制子进程输出，保留退出状态与输出摘要；非诊断文件的权限变化也被拒绝。准备失败与清理失败同时保留因果；不增加“原测试必须先 GREEN”门禁，原已失败的复现仍可使用。
- README、Dispatch Lifecycle、diagnosing-bugs skill 与生成 registry 同步更新；138/138 测试、registry、upstream drift 与打包检查通过。新增修复/送审流程已通过原生 sandbox 契约验证，尚未做真实模型返工链路实跑。

## 0.2.27

- Implement 授权改为 invocation/ticket/hash/项目/branch/HEAD/精确范围绑定的宿主记录；运行时确认可复用，reload 从当前 session branch 恢复。取消/过期/无可信来源仍 fail closed，保留新范围与架构/破坏性决定确认。
- 修复任务采用结构化根因契约与宿主轮次记录；同根因两次未解或相关回归先受限诊断，第三轮补丁不能机械启动。必要测试数量不设上限。
- Evidence Pack 增加前后 snapshotId、获批 finding 集合、宿主计算的真实增量与内容/hash；review finding 增加依据、预期/实际、根因及回归分类。无影响的已审内容不重审，真实新安全/完整性风险不隐藏，双轴 PASS 条件不变。
- 授权/证据/入队/RPC/执行/结算分别记录时间与状态，通过事件通知而非模型轮询；丢失 RPC 回应按原 requestId 对账，禁止盲目重派发。超时与 settlement 再失败均保留原始因果链。
- 在授权/快照有效时，仅允许一次失败 reviewer 的显式局部恢复，复用已完成实现、证据和有效另一轴；不替换有效 FAIL，不叠加已有 settlement 恢复。writer 前增加宿主原子 claim，阻止上游 autoResume 重放同一脚本重复实现，不修改用户全局配置。
- Registry 加载统一由生成器校验源文件并与磁盘缓存逐字比较，删除重复读取、hash 检查与缓存路径解析；篡改、过期、跨 agent 授权与路径限制仍 fail closed。
- Dispatch 拆分授权前输入准备与授权后脚本构建，TDD 不再重复生成脚本；保留角色隔离、修复契约、局部恢复、gate 与超时结算语义。
- 合并 ticket 路径范围判断和证据采集的重复 Git 命令，移除不可达条件；用授权拒绝、延迟启动及修复轴隔离的行为测试替代重复源码字符串断言，同步 README。
- 110/110 测试、registry、upstream drift 与打包检查通过；Standards/Spec 独立复核均为 PASS。保留全部现有工作流，个人 settings 不纳入提交或安装包。

## 0.2.26

- Dispatcher 在每阶段 gate 校验前通过 runtime `emit(...)` 发布完整累积结果到 `status.json → workflow.emits`；两个 reviewer 同时不通过时仍保留两轴全部 findings，workflow 继续 fail closed。
- 同步父流程读取契约：成功仍读取 `workflow.value`，失败读取最后一个带版本与 workflow 标识的阶段快照；区分复核结论不通过、实现 `BLOCKED` 与执行失败/结果缺失/schema 无效，不从预览、prose、receipt 或旧 transcript 拼装结果，不新增实现重跑。
- 增加真实 sandbox 与原子落盘读取回归，覆盖全 PASS、任一 reviewer `FAIL`/`NO_EVIDENCE`、双轴同时失败和 implement 早停；package filter 测试不再禁止合法的本地 `agentOverrides` 配置。
- `0.83.1` + Pi `1.4.0` 重启后的真实双 reviewer 负例冒烟通过：workflow 保持失败且无 `workflow.value`，实际阶段快照完整保留 Standards 1 项、Spec 2 项 findings，schema 均有效，无自动重跑或仓库改动。
- 89/89 测试、registry、drift 与发布包检查通过；个人 settings 与模型覆盖配置不纳入提交或安装包。

## 0.2.25

- 将 project-local runtime 与 bundled `pi-subagents` 同步固定到 `0.83.1`，最小加载入口改为 `+bundle/index.js`；Pi/Node 下限仍为 `1.2.0`/`22.19.0`，bundled `undici` 升为 `8.12.3`。
- 兼容测试从新的 public bundle export 定位 package root，再加载发布物中的脚本 sandbox、resource resolver 与 notification formatter；保留公共 bundled API 注册、一次性 TDD resource 与 fail-closed gate 的契约验证。
- 正常结束却漏交 `structured_output` 由新版 runtime 在原 session/timeout 内补交一次，dispatcher 不再重复恢复；超时且没有结构化结果时仍保留单次 settlement-only resume。增加聚焦回归覆盖重复恢复拒绝与超时恢复。
- README 说明新版默认自动续跑及其用户级 `autoResume: false` 配置位置，不把全局选项误写入 project settings；package 安装本身不改用户级配置。升级后必须完整重启 Pi。
- 84/84 测试、registry 与 drift 检查通过；实际 npm tarball 已核验新版 bundle 入口、workflow worker 与许可证齐全，不包含项目缓存或用户级配置。
- `0.83.1` + Pi `1.4.0` 重启并重新配置模型后的真实 Research 单 lane 冒烟通过：workflow `state=complete`、lane `ok=true`、fresh context；已从 runtime 与 child session 核验实际模型匹配 researcher override，`web_search`/`web_fetch`/`structured_output` 各成功调用一次，完整结构化结果有效且无额外结算恢复。

## 0.2.24

- `matt-worker` 现在声明写文件优先使用 `apply_patch`，该工具在目标环境不可用时退回 `edit` 或 `write` 完成同一改动。
- README 不再指定 `apply_patch` 的提供方，也不再要求安装特定 provider 包；只声明工具用法与回退，目标项目自行提供或允许回退即可。

## 0.2.23

- 将 project-local runtime 与 bundled `pi-subagents` 同步固定到 `0.80.0`，Pi host peer 下限同步为 `>=1.2.0`；Node 下限仍为 `22.19.0`。升级 runtime 后必须退出并重新启动 Pi。
- 已核对新版的 `spawn` RPC、scripted-workflow sandbox 与 `workflow-resources` 公共注册 API，现有 dispatcher 无需改动。内置 `parallel/tasks/chain` 的逐子任务 `cwd/model` 和可选 `enableSlashCommands` 不改变现有项目配置、模型选择与权限边界。
- completion notice 直接唤醒空闲父会话，不再额外插入唤醒消息；完整结构化结果仍从通知指向的持久化 JSON 读取。0.79.2 起未送达 notice 的重启重放与 child `APPEND_SYSTEM.md` 隔离随新版生效；本项目 child 继续通过 agent prompt、显式 task/skill 与 `inheritProjectContext` 接收指令。
- 离线契约测试针对已安装 `0.80.0` 运行，83/83 测试、registry、drift 与打包检查通过。升级并重启后的 `0.80.0` + Pi `1.4.0` 真实 Research 单 lane 冒烟通过：workflow `state=complete`、lane `ok=true`、fresh context，已核实 `web_search`/`web_fetch`/`structured_output` 实际调用成功，并从完整 `workflow.value` 读取有效结构化结果。

## 0.2.22

- 业务项目默认把整个 `.x-matt/` 与整个 `.pi/` 加入本机 Git exclude（两条整目录规则），不再只保护 `.x-matt/work/`：tracker、agent 契约、glossary、ADR、research、原型、settings、Pi package/extension/skill 声明与本地入口都只在本机保存。业务自己的 `package.json`、构建配置与锁文件明确不在忽略范围。
- 入口从团队 `AGENTS.md` 改为本地 `.pi/APPEND_SYSTEM.md`；setup 不再向共享 AGENTS/README 写工具说明。若新建 project APPEND 会遮蔽全局同名文件，setup 停止并要求先明确保留/合并方式。
- 提交链路增加内容级检查：除私有路径外，还检查复制进业务文件的 session ID、harness/model/工具说明、AI attribution 或工具生成的 `Co-authored-by`；提交后核对真实 commit 与 trailer，hook 追加归因时停止、不 push，不伪造作者、不关闭团队 hook。
- 新增 `matt-setup/privacy.md` 隐私契约并随包分发：作用范围、真实 package root 例外、整目录 exclude 与迁移、本地入口规则、提交检查、模型/第三方/hook 的能力边界；明确不承诺消除历史或“绝对无痕”。
- `.pi` 共享例外需要改变规则形态（Git 不能在已排除父目录内用 `!` 回包含）并由用户显式批准、记录清单，核验改为双向（个人条目仍忽略且未跟踪；批准条目 `check-ignore` 不匹配且可跟踪）。
- 源码维护例外只排除整个 `.x-matt/`，`.pi/` 作为 package 源码保持跟踪；新增需分发的契约文件才允许逐路径 `git add -f`，并要求 force-add 集合与完整 staged manifest 收敛。原型回到本机 `prototype/<slug>` 分支，禁止 push/PR/merge/rebase 进共享历史。
- 新增 `test/privacy-contract.test.mjs` 契约测试与真实 Git 回归（整目录忽略、业务文件仍可暂存、`.pi` 细规则共享）；83/83 测试通过，最终两轮 Standards/Spec 双轴复核均为 `PASS`。

## 0.2.21

- Local Markdown tracker 统一仅在本机维护：spec、implementation/decision tickets、map 与归档不再被 Git 跟踪或随实现提交。`matt-setup` 配置本机 Git exclude，支持 nested project 与 linked worktree，不修改团队 `.gitignore`；本仓库已有 tracker 仅取消索引跟踪，保留磁盘文件，不重写历史。
- `matt-implement` 在代码提交成功后才本地写回 `resolved` 与完整 `Implementation commit`；blocker 解锁必须核验实现提交属于当前 `HEAD` ancestry。本地写回失败保留代码提交并报告待修复，不重复实现或提交。
- `matt-archive` 保留用户显式触发、资格与内容核验，但只做本地移动和 metadata 改写，不再创建归档提交；失败恢复本地原文与路径。
- 同步 canonical 状态词表、setup 写后核验与旧项目迁移说明：只允许核验后回填真实实现 SHA，保留原完成摘要；缺证时不解锁、不归档。已有项目需更新插件后重新运行 `matt-setup`，取消跟踪的索引删除需一次迁移提交落地。
- 增加状态/迁移契约测试与真实 linked-worktree 回归；77/77 测试通过，最终完善增量的 Standards/Spec 双轴复核均为 `PASS`。

## 0.2.20

- 将 project-local runtime 与 bundled `pi-subagents` 同步固定到 npm latest `0.79.1`。
- 0.79.x 未移除或收紧本 package 依赖的契约：`workflow-resources` 注册 API 与 `spawn` RPC 参数不变，`scripted-workflow` sandbox 未改动；`reuseFrom`、`workflowChildren.launches`、异步状态 `agent`/`model`/`thinking` 与 inspect `resolvedModel` 均为增量字段。RPC 侧只把 run 归属判定改为 `ownsRun`/`ownerSessionIds`，同 session 的 dispatch 行为不变。
- 0.79.1 起，未启用委派的 session 不再每次请求下发 `bg_wait` 与 `subagent_supervisor` 定义；本 package 走 `pi_matt_dispatch` → `spawn` RPC，不依赖这两个工具声明。
- 运行时下限未变：`engines` 与 bundled dependency 版本一致（`undici@8.10.2` → Node `22.19.0`），`@earendil-works/pi-coding-agent` peer 仍为 `*`。
- 契约测试已针对已安装的 `0.79.1` 运行；真实子代理冒烟最近一次记录仍是 `0.78.0`，尚未在 0.79.1 上重跑。

## 0.2.19

- 加强 TDD 测试价值判断：`matt-implement`/`matt-tdd` 要求参数化案例按独立行为、字段映射和共享校验等价类选取，同一等价类只保留一个代表输入，默认不生成字段×状态×错误值全排列；`tdd-executor` 不自行扩张未批准的用例矩阵，也不靠循环或表格压低报告案例数；`review-standards` 只在缺少独立行为、分支/状态转换、权限或数据完整性保护时报告测试缺口。安全、状态、完整性与真实缺陷回归仍必须保留，且不设任意案例数上限。
- `matt-tdd` 的 Acceptance matrix 增加代表输入、预计展开次数与昂贵准备成本记录项。
- README 新增“为子代理指定模型”：记录 pi-subagents settings 的配置位置、`agentOverrides`/`defaultModel` 分层示例与解析优先级，并说明 `/subagents-models` 校验方式。

## 0.2.18

- 修正 `pi_matt_dispatch` 的 `workflow` 参数示例：dispatcher 按 registry skill key 查表，示例从不可用的 `research` 改为 `matt-research`，避免照抄示例时得到 `Unknown Pi-native workflow`。
- README 记录 0.78.0 + Pi 1.2.0 重启后实跑的真实子代理冒烟（`matt-research` 单 lane，`state=complete`、lane `ok=true`），并把上游 CI clean-install 覆盖同步为 Pi `0.86.1`/`1.0.0`/`1.2.0`。

## 0.2.17

- 将 project-local runtime 与 bundled `pi-subagents` 同步固定到 npm latest `0.78.0`。该版本修复了 Pi 1.2.0 下后台子代理无法启动的问题（不再无条件要求已被 Pi 1.2.0 移除的 `@earendil-works/chord`），并让父代理被 `Esc` 停止后不再被后续 completion 唤醒。
- `src/extension/rpc.js` 与 `src/api/workflow-resources.js` 的契约面与 0.77.0 完全一致；`scripted-workflow.js` 仅调整 sandbox 的 Promise proxy 与停止提示文案，completion Preview 加完整 JSON 路径的契约不变，因此 dispatcher 与结果读取契约无需改动。

## 0.2.16

- 将 project-local runtime 与 bundled `pi-subagents` 同步固定到 npm latest `0.77.0`；npm extension filter 使用 `index.js`，Node 最低版本同步为 `22.19.0`，升级 runtime 后要求重启 Pi。
- Dispatcher 使用新 RPC `script` 参数，同步 TDD resource resolver 与 named workflow 参数拆分；所有 lane 必须 `ok === true`，不能以失败后保留的 `structuredOutput` 通过 gate。
- 六个执行型 parent 共用完整结构化结果读取契约：Preview 可能被截断，需读取通知指向的 retention-managed `status.json` 的完整 `workflow.value`；不得用 prose、`outputReference` 或 receipt 重建结果。
- 增加已安装 runtime 的离线兼容测试，覆盖发布入口、脚本 sandbox、失败 stage、resource 注册与结构化 completion 截断。

## 0.2.15

- 新增用户显式触发的 `matt-archive` interaction parent：核验 terminal tickets、当前分支提交与持久知识后，将 parent spec 标记为 `shipped`，整体移入 `.x-matt/work/shipped/` 并创建独立提交。
- 所有相关 Local Markdown 入口默认跳过 shipped 内容；仅允许同会话点名后的单对象历史只读，`matt-implement` 与本地 ticket checker 对 archived 路径 fail closed。

## 0.2.14

- `matt-worker` 改为消费结构化 Implementation Context Pack，从精确 manifest/change points 开始，仅在上下文不一致时定向扩展一层依赖，不再因 fresh context 重扫模块。
- `matt-tdd` 在 implement gate 后通过受信任的 named workflow host step 独立生成只读 Review Evidence Pack，完整记录 combined diff、untracked 内容/hash、rename/deletion、固定点与调度前状态；采集失败或基线漂移时不启动 reviewer。
- Standards/Spec reviewer 改为独立判断共享真实证据而非重复取证，分别只接收适用规范或验收矩阵；`matt-code-review` 同样强制完整 lane-specific tasks，工具 hard budget 保持不变。
- TDD 命令证据增加 phase、真实 exit code 与可空 test count，并明确区分 worker-reported 过程记录和独立 Git/父会话验证。

## 0.2.13

- `matt-implement` 复用 `matt-tdd` 内置的 fresh Standards/Spec 双轴结果作为最终评审，不再对同一 worktree 默认追加重复的 standalone code review。
- 同一轮 review findings 合并后只请求一次授权；获批修复使用聚焦 `matt-tdd`，只复核修复增量、原 finding 与必要的一层依赖。
- 明确只有有证据的验收、标准、正确性、安全、数据完整性或必需测试问题阻断提交；非阻断建议保留在 notes。

## 0.2.12

- 移除 `matt-reviewer` 会催促提前收尾的 soft 工具预算，只保留 hard 50 的只读工具上限，避免复杂 diff 复核在完成取证前过早结束，同时保留失控保护。
- 按角色延长 workflow lane：worker 20 分钟、reviewer 15 分钟、reader/researcher 10 分钟；settlement-only resume 延长到 5 分钟。

## 0.2.11

- 为 dispatcher 增加 per-lane 完整任务替换；`matt-tdd` 强制提供 implement/standards/spec 三项，隔离 report-only 恢复指令与 reviewer，并在 reviewer 前缀中拒绝 implement schema、禁止 diff 和旧 transcript 替代取证等冲突指令。
- retained child 因 timeout 或遗漏 `structured_output` 失败时，自动追加一次只结算的 resume；恢复结果仍按原 gate fail closed。
- 移除 pi-subagents 0.68.0 已取消的 `turnBudget` workflow 配置与 registry 校验。

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
