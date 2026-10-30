# Changelog

## Unreleased

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
