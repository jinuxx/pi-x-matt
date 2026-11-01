# Implement dispatch lifecycle

此契约由 dispatcher 的宿主状态强制执行，不以 task 中“用户已授权”等文字为依据。初次派发提供完整三项 `laneTasks`，follow-up 只需实际执行 lane 的 task，角色隔离不变。默认交付要求双轴 `PASS`；唯一额外出口是下述用户真实确认的 `acceptRisk`，它不改写 PASS/FAIL。修复完成与正式评审通过是两个独立边界。

## 限定授权

每次 `matt-tdd` 都提供相同的 `implementation`：

```json
{
  "ticket": ".x-matt/work/feature/ticket.md",
  "scope": "已批准的行为、既有行为与架构边界；修复期间保持不变",
  "allowedFiles": ["src/parser.ts", "test/parser.test.ts"],
  "diagnosticFiles": ["test/parser.test.ts"],
  "diagnosticCommands": ["npm test -- parser.test.ts"]
}
```

`ticket` 必须是精确的 active 仓库相对路径；direct slice 使用稳定的 `slice:<id>`，但不能代替上游真实 handoff。宿主读取 ticket hash；不接收模型提供的授权、hash 或证据文件路径。`allowedFiles` 是精确文件清单，不是目录/glob。`diagnosticFiles` 可选，必须是 `allowedFiles` 的精确子集，且只能列测试/fixture 路径，不得把生产源码列入；测试/fixture 路径按最小命名规则识别：任一路径目录段恰为 `test`、`tests`、`__tests__`、`fixture` 或 `fixtures`，或文件名匹配 `*.test.*` / `*.spec.*`；未命中一律 fail closed，不读取文件内容、不探测测试框架、不提供配置项。它只为宿主隔离诊断区授予添加/替换文件的权限，不授予原工作区写权限，缺省时范围规范化对象保持 v0.2.27 形状。`diagnosticCommands` 是获批的本地、非破坏性、无敏感数据命令；不允许生产访问或外部写入。授权确认会展示隔离诊断文件清单。

用户显式 `/skill:matt-implement` 产生一次 invocation intent，只能绑定第一个限定范围；缺少该记录时，用 TUI/RPC 确认一次具体范围和连续修复。后续同一 ticket/内容 hash/项目/branch/HEAD 且范围已被当前 grant 覆盖的派发不重复入口确认。同 ticket 增加 `allowedFiles` 或替换 `diagnosticFiles`/`diagnosticCommands` 属于新的授权信封，必须重新确认一次；确认后信封被替换而同一修复谱系保留：ticket、`scope`、宿主读取的 ticket hash、项目与 branch/HEAD 必须不变，旧 `allowedFiles` 必须全部保留（只增不减），授权 invocationId 变化不切断之前的 dispatch。把相对的 `.venv/bin/python` 改为项目内绝对解释器路径同样是 `diagnosticCommands` 替换，必须由用户显式确认新命令；确认后仍保留同一修复谱系，宿主不会自行发现或替换解释器。宿主以非模型上下文 custom entry 保存真实输入/确认结果；reload 仅从当前 session branch 的这些记录恢复，不扫描其他分支或相信 prose。

授权最长 24 小时；授权对话最多等待 5 分钟，可取消。取消、失效、缺少可靠记录或无 UI 时 fail closed。新 ticket、实质范围扩张、架构选择或破坏性操作仍须新决定；不得以改写 `scope` 绕过根因门禁。新 session/fork 不继承授权；tree navigation 撤销。已经运行的 child 用 `/subagents-stop` 停止。

## 批量授权（matt-implement-spec）

只有 `matt-tdd` 接受可选的顶层 `batch`：

```json
{
  "batch": {
    "spec": ".x-matt/work/feature/spec.md",
    "fixedPoint": "<原始完整 commit SHA>",
    "tickets": [
      {
        "ticket": ".x-matt/work/feature/issues/01-parser.md",
        "scope": "本票批准的行为与架构边界",
        "allowedFiles": ["src/parser.ts", "test/parser.test.ts"],
        "diagnosticFiles": ["test/parser.test.ts"],
        "diagnosticCommands": ["npm test -- parser.test.ts"]
      }
    ]
  }
}
```

`spec`/`ticket` 必须是精确 active 仓库相对路径，不得指向 `.x-matt/work/shipped/`；`fixedPoint` 必须是存在且属于当前批准 starting HEAD ancestry 的原始完整 SHA。宿主自己读取 spec/tickets、Parent、`Blocked by` 与内容摘要；模型提供的 hash、tree、commit、授权或额外字段一律拒绝。每张 ticket 的 Parent 必须精确等于该 spec，Type 必须为 `ticket`，status 只能是 `ready-for-agent` 或 `resolved`；blocker 必须是真实 active ticket，自依赖、循环和未完成依赖 fail closed。已经 `resolved` 的启动 blocker 按批准 starting HEAD 的 ancestry 核验其完整 `Implementation commit`，不要求读取 archived 历史，也不创建 tracker artifact。首次工作区必须干净（ignored 本地 tracker 不计入）。

提交 `batch` 必须触发一次真实 TUI/RPC 确认，展示 spec、原始 fixed point、每个声明 ticket 的 `scope`、完整 `allowedFiles` 与诊断清单；确认最长 24 小时、等待最多 5 分钟且可取消。`matt-implement` invocation intent、`matt-implement-spec` invocation 或 `batch` 元数据本身都不构成授权；无 UI 且没有当前 session branch 可恢复的有效 batch capability 时拒绝。可信 batch 记录以独立 custom entry 保存，不与单票 grant 混用；`/skill:matt-implement-spec` 作为 batch 入口不撤销该 capability，其他 skill、tree navigation、new session/fork、取消或过期撤销，queued work 不得启动。

对每张声明的串行 ticket，宿主先重读 spec/tickets 并核验内容、Parent、edges、固定基线和 `Blocked by` 图未漂移，再从可信 batch capability 签发或复用新的 HEAD-bound 单票 grant，不重复 UI。当前 `implementation` 信封必须等于批准条目；undeclared ticket、额外文件/命令、语义变化、Parent/type/status/active path 不合法时拒绝，并提示提交新的显式 batch 确认。同票 repair/review/recovery/reconsider 即使省略 `batch` 也继承宿主 batch binding；只增 `allowedFiles` 或替换诊断清单仍需既有单票重新确认，batch 计划本身不扩张。已有 initial 派发后重新 batch 确认或 invocation 都不能重开 initial 或清空 findings/计数。

batch-bound 证据采集额外在受信任 collector 中生成 candidate tree 证明：宿主使用 OS temp 的 `GIT_INDEX_FILE`、临时 `GIT_OBJECT_DIRECTORY`，把原 object store 作为只读 alternate，只把本次已审项目路径 stage 到隔离 index 并 `write-tree`；真实 index、HEAD、object store 与工作区不被写入。tree、采集时 HEAD 与 Review Evidence snapshot 通过 collector stdout 和 workflow emit 绑定到宿主记录，至少包含完整双轴 `PASS` 与 `implement.status=COMPLETE` 才算 terminal candidate。

进入下一票前，宿主必须对前一票核验：真实 commit 只有一个 parent 且等于 candidate 采集时的 HEAD；commit tree 等于 candidate tree（因此内容、文件类型、可执行位和新文件都绑定）；commit 位于原始 fixed point ancestry；当前 HEAD 正好是该 commit，没有额外/无关提交、amend、merge 或 history switch；工作区干净；tracker 为 `resolved` 且 `Implementation commit` 精确等于该 commit。伪造 Comments、仅 branch 名称相同、部分 candidate、未 review 的 commit 或无法安全核验的 prerequisite 都停止，不接受“父会话说已提交”。全部 tickets 达到核验终态后才允许整份 spec 的 committed 双轴评审；不自动归档、改 spec 状态、push、开 PR 或合并。

风险接受的 batch 候选也必须匹配原宿主 candidate tree、parent 与 snapshot；tracker 除 `Status: resolved`、`Implementation commit` 外还必须在 `## Comments` 记录 `Risk acceptance: <acceptRisk 返回的 dispatchId>`。缺失/不匹配的风险收据不能推进下一票；普通 batch 确认本身不接受任何风险。

## 修复而非重新实现

保存工具返回的 `dispatchId`。只要同一 session/project/ticket 已有未取消派发（不按当前授权 invocationId 过滤），就不能再次发送无 `repair/review/recovery` 的初始实现；重新确认授权、显式重新 invocation 或替换诊断清单都不能把谱系重置为 initial。只有排队后未启动即被取消的派发不构成该阻断。任何运行中或接受状态不明的 writer 都阻止同项目再次派发。workflow 在 writer 前执行宿主原子 claim；同一脚本被上游 autoResume 重放也会在 writer 前停止，不依赖改动全局 autoResume 配置。

两个 reviewer 完成限定检查后一次返回全部有证据的阻断项，不因首个 finding 提前结束。父会话一次收集两轴全部 findings，按真实共享根因分组，保留两个轴各自 verdict。只要仍在已批准的连续修复范围内，报告后直接聚焦修复，不再次询问相同范围。只有新增决定/权限/范围时才询问一次。

```json
{
  "repair": {
    "previousDispatchId": "<最近一次宿主 dispatchId>",
    "groups": [{
      "id": "validation-order",
      "findingIds": ["spec:F1", "standards:F2"],
      "contract": "共享校验路径的准确契约",
      "preserve": ["必须保持的既有行为"],
      "validationOrder": "原始输入检查 -> 归一化 -> 解析 -> 业务约束",
      "callPath": ["public API -> shared validator -> parser"],
      "examples": ["必要正例、反例与回归，按行为等价类选择，不限制必要测试数量"]
    }]
  }
}
```

finding 引用为 `<axis>:<id>`；必须覆盖全部真实阻断项，不能重复、遗漏或通过改名清除已有根因计数。只有相同 `rootCauseId` 延续根因身份，`relatedFindingIds` 是因果关联，不把不同根因强制合组；同根因改名错误列出期望 group IDs。相同文件并不自动代表相同根因。父会话只合并根因，不合并 Standards/Spec verdict；无证据或越轴的报告属于 review contract failure，需要修复评审，而不是派发 writer。

`previousDispatchId` 必须指向同一 session、canonical 项目与 ticket 的最近一次未取消派发；宿主不按授权 invocationId 过滤修复历史。重新确认后的修复使用最新 `implementation` 信封：可在保留全部旧 `allowedFiles` 的前提下增加文件，也可替换 `diagnosticFiles`/`diagnosticCommands`（仍须通过原有测试路径与子集校验）。ticket、`scope` 文本、宿主读取的 ticket hash、项目与 branch/HEAD 必须与旧派发完全一致；移除旧文件、收窄范围、ticket 内容/行为变化、快照漂移或引用非最新 `dispatchId` 时 fail closed。已有派发后新的 initial 同样被拒绝，不能借重新授权清空基线、计数或已获批 findings。

`repair` 只运行 writer 和证据采集，不自动启动 reviewer。宿主从最近完成结果选择 `agent=matt-worker`、`resumability.state=resumable` 的精确 runId，以 retained resume 延续原模型、工具、skills/schema 和上下文；不会用父会话提供的 runId 替换。不可恢复、结果不完整或修复执行失败时停止，不暗中换 fresh writer。只需 `laneTasks.implement`，不为未运行的轴填写占位文本。

宿主将最新候选 `snapshotId` 与本次调度基线绑定；每次修复都必须从精确候选开始，且不能越过 `allowedFiles`。同时保存最近一次正式评审的来源，计算从该已审快照到本次候选的**累计修复增量**，保留两端内容/hash、原获批 finding IDs 与根因契约，不只计算最后一次补丁。正式复审仍不重新裁决未变化且无依赖影响的已审内容。

修复成功返回 `reviewPending=true`，结果只有 implement lane，并发布 `pi-x-matt.review-pending`。`state=complete` 仅表示本次修复结束，不是 TDD 全流程通过，不授权提交。父会话核对逐项 findings、真实 diff 和聚焦验证证据；仍有证据支持的同范围下一步时，可引用最新 dispatchId 再次 repair。原 findings、根因 ID 与计数跨修复保留，不因未评审而清零，不通过拆轮绕过诊断；不重复实现已完成的 slices 或人为制造旧 RED。

候选准备好后，显式送审：

```json
{"review": {"dispatchId": "<最新已完成 repair 的 dispatchId>"}}
```

仍使用 `workflow=matt-tdd`、最新 `implementation` 信封（同 ticket 可含新增文件或替换后的诊断清单）和 `laneTasks.standards` / `laneTasks.spec`；重新确认不重置待审候选、计数或原 findings。宿主只启动 fresh Standards/Spec，复用最近 implement 结果和只读 Evidence Pack，不重跑 writer、不重复采集；必须确认候选快照未漂移且证据完整。结果保留 implement 并加入本次两轴结果，默认二者 PASS 才能进入最终验证。repair/review/recovery 互斥；尚无待审修复时不接受 review，待审修复也不能借 recovery 跳过正式送审。

父会话不能凭 prose 抹掉有效 FAIL。若认为某条已记录的有效 blocking finding 与已确认验收/标准冲突，使用唯一的结构化复核路径：

```json
{
  "reconsider": {
    "dispatchId": "<最新正式 review 或 reconsider dispatchId>",
    "findings": [
      { "findingId": "spec:F1", "reason": "与已确认 AC1 冲突", "evidence": "ticket AC1 原文或标准条款" }
    ]
  }
}
```

`reconsider` 与 `repair`/`review`/`recovery` 互斥，必须引用同 ticket 最新宿主 dispatch。`findingId` 必须带轴前缀且指向当前有效 blocking finding，reason 与 evidence 均非空，ID 不得重复；未知、已撤回或轴前缀与 finding 不匹配的 ID 直接拒绝。宿主只选择受影响的 axis/axes，复用最近完成的 implement 结果和同一 Evidence Pack，不启动 writer、不重采证据、不运行未受影响轴；待审/未完成 repair、快照或引用漂移时拒绝。每个候选快照对每个轴最多一次 reconsider，可通过 reload、重新确认或 report correction 保留；新 writer 候选可建立新预算，但不会重置根因修复计数或原评审基线。

fresh 只读 reviewer 对每个 challenge 只返回一个决定，不重报 verdict/findings：

```json
{
  "axis": "spec",
  "decisions": [
    { "findingId": "spec:F1", "decision": "uphold|withdraw", "justification": "独立判断", "evidence": "复核依据" }
  ]
}
```

宿主校验决定数量、轴与目标集合完全一致后才合并：未 challenge 的 findings 逐字保留，另一轴逐字保留，只有 reviewer 明确 `withdraw` 的 finding 消失；任一 `uphold` 或未撤回 blocker 使 effective verdict 仍为 `FAIL`，不能当执行失败，也不能绕过最终双轴 `PASS` gate。原报告、全部决定与 effective verdict 保存在宿主结果及 `reconsiderationHistory`，不覆盖原始证据。后续 `repair` 必须使用 effective remaining findings，并继续引用最新可恢复 writer，而不是 reconsider 前的 source。

合法的 reconsider 决定完成后返回 `state=complete` 与 `pi-x-matt.reconsideration-complete`：`reviewPassed` 表示 effective 双轴是否均 PASS，`remainingFindingIds` 列出仍然阻断的有效 IDs。这只说明复核动作已完成，不代表实现交付通过；任一 upheld/未挑战 blocker 仍为 FAIL，禁止提交或推进 batch。非法决定、缺失结果或执行失败仍失败，不能用“决定成功”掩盖它们。

## 根因未收敛

同一根因完成两次修复后仍需继续，第三次 writer 前触发 `DIAGNOSIS_REQUIRED`，无论两次修复之间是否正式送审；评审确认的修复相关回归立即触发。网络失败、缺失结果与授权等待不算根因修复轮次。阈值只触发诊断，不自动放行，不限制测试数量。诊断绑定最近候选快照；“已审 snapshot”在连续待审修复中指宿主已采集的最新修复候选，不表示 reviewer 已批准。

在父会话执行 [diagnosing-bugs 的受限修复诊断](../matt-diagnosing-bugs/SKILL.md)：只使用当前 Pack、原始失败、共享路径和必要的一层依赖。最小化原始 repro，解释不变量、校验/归一化顺序和预测，不重新设计模块、不重新创建 ticket、不重新发起 implement invocation。

完成后在相同 `repair` 中附带：

```json
{
  "diagnosis": {
    "rootCauseIds": ["validation-order"],
    "explanation": "能解释全部相关失败的当前根因",
    "prediction": "可证伪预测与已观测结果",
    "command": "npm test -- parser.test.ts",
    "expectedFailure": "能识别原始症状的精确失败文本",
    "testFiles": [{ "path": "test/parser.test.ts", "content": "内联复现测试或 fixture 内容" }]
  }
}
```

宿主只执行范围内预先批准的精确命令，最多 30 秒；必须退出码为 1 且出现目标失败文本。成功命令、环境失败、超时或其他症状不能解锁。保存命令、退出码与输出 hash，不把原始日志/敏感数据复制进事件。失败按真实退出状态归因：127 表示命令或解释器不存在（隔离区缺少相对 `.venv` 时常见），126 表示不可执行，其他非 1 退出保留为命令失败；退出 1 但不含目标文本按症状不匹配处理，并提示检查解释器与依赖。持久化只记录退出状态、信号与输出 sha256，不含原始子进程输出；不根据任意 ImportError 猜测环境失败。结论仍由父会话据真实证据判断；这个检查不宣称自动证明根因。没有可用 repro/权限时停止，而非继续第三轮补丁。

若 `testFiles` 提供内联复现内容，父流程必须在提交前完成脱敏并只使用合成或已脱敏 fixture；凭据只经环境变量传入，不写入测试、fixture 或输出。宿主先严格确认原工作区仍等于最近已审 `snapshotId`，并重算 pack 的实际 head/cwd/manifest/diff 绑定：必须匹配宿主记录的 `snapshotId`、`diffSha256` 与实际项目/Git root，内容/hash 被改写即拒绝。随后在自己的 OS temp 目录中从该已审状态重建完整项目：HEAD 中未变化源码，加上已审未提交的 tracked/untracked/删除/重命名变更；只把内联内容写入 `diagnosticFiles` 中的精确路径。随后在隔离区的项目根执行同一个已批准命令，仍要求退出码 1 与目标失败文本。原工作区、HEAD 与 index 不变；运行前后各校验一次原快照，漂移则禁止 writer 入队。GREEN、其他症状、超时、取消、缺少运行前提以及隔离区生产源码/未获批文件变化，都不能作为可信诊断；任何命令结局都复核原快照并清理自有临时区，原始错误与漂移/清理错误保持因果链。宿主把原 dispatchId、已审 snapshotId、范围 hash、根因 IDs、命令、退出码、输出 hash 与测试 path/内容 sha256 记录到 `repair.diagnosis.isolation`，并继续同一个 repair；内联正文只在该次临时区使用，长期 repair 证据与 implement lane handoff 不含原文。该隔离是本机故障隔离，不是安全 sandbox：不联网安装依赖，不复制个人 ignored 资料，也不把原源码路径链接进隔离区。隔离区不含原 `.git`、submodule 内容或未复制的依赖；依赖这些前提的命令按缺少运行前提失败，而不是伪装成目标 RED。隔离区同样不包含被忽略的 `.venv` 等依赖目录，因此相对的 `.venv/bin/python` 会以 127 失败。需要虚拟环境依赖时，由用户显式批准使用项目绝对解释器路径的命令，例如 `/absolute/project/.venv/bin/python -B -m pytest -p no:cacheprovider tests/repro.py`；路径含空格时必须按 shell 规则引用。`-B` 阻止 Python 写入未获批的 `__pycache__`，`-p no:cacheprovider` 阻止 pytest 写入缓存。解释器与依赖本身并非 OS 强制只读；宿主不自动发现或替换解释器、不改写命令、不安装依赖、不挂载或复制 `.venv`、不链接回原源码，也不提供 `diagnosticEnv`/`pythonPath` 字段。该门禁不自动识别任意 secret/PII，也不能从会话记录中抹去已经提交的工具输入。未提供 `testFiles` 时保留原路径：直接在项目根执行已批准命令。

隔离区的非诊断文件指纹同时包含内容与权限；失败子进程输出不进入持久化 trace，仅保留退出状态、信号和输出摘要。错误信息给出可操作原因（127/126/其他退出/症状不匹配）与退出状态，原始输出仍不进入持久化 trace。准备失败且清理也失败时，两者错误都保留，不用清理错误覆盖原始原因。

“原测试 GREEN、补测试后 RED”是本路径要支持的场景，不是强制先 GREEN 的新增门禁；原已能复现的目标 RED 同样有效。宿主仍只接受获批命令真实产生的目标失败，worker 后续必须独立完成自己的 RED→GREEN。

## 增量 findings

每个 finding 除 severity/title/evidence/locations/recommendation 外，还必须有：

- `id`、稳定 `rootCauseId`；`id` 可为裸 ID 或本轴前缀形式，宿主统一为单一 `<axis>:<id>` 身份，别名重复或错误轴前缀被拒绝；
- `basis: {kind: acceptance|standard|safety|integrity, reference: 精确条款或安全/完整性要求}`；
- `expected`、`actual` 和可复现步骤或真实代码路径证据；
- `classification: original|regression|independent`；
- `relatedFindingIds`：原问题/同轴复发引用此前获批的本轴 ID；`regression` 可引用宿主提供的另一轴 causal predecessor ID，但必须证明变化位置或 `affectedBy` 的因果影响，不能借此引用另一轴验收或标准；独立问题可为空；
- `affectedBy`：有一层依赖影响时，列出引发影响的本轮变化路径，并在 evidence 解释真实影响链，否则为空。

Spec 只以 acceptance 为依据；Standards 以 standard/safety/integrity 为依据。非阻断建议留 notes。未变化且无依赖影响、非原 finding 的普通新意见不能阻断增量交付；新证实的安全/完整性问题即使位于未变化文件也可阻断。无证据或越轴报告不能仅凭 P0/P1/P2 成为有效缺陷；宿主标记为评审契约失败，保留原报告，不擅自改成 PASS。

`locations` 支持 `path:line`、`path:line:column` 与 `path:start-end`，只剥离末尾位置后缀，不截断文件名内的冒号。增量位置不匹配时，错误给出该 finding 的 locations 与有界 changedPaths 样本。修复引用未知 ID 时列出当前有效 ID；scope/identity 不匹配时指出差异字段而不回显原始 scope 内容。`scope` 在去除首尾空白后仍按原批准文本比较，不能借“改写说明”扩权。

## 显式风险接受与收尾

仅在正式评审结果完整有效、Spec PASS，且所有剩余 finding 都是 Standards 的 `severity=P2` / `basis.kind=standard` 时，可请求：

```json
{"acceptRisk":{"dispatchId":"<最新 dispatchId>","findingIds":["standards:F1"],"reason":"接受理由","evidence":"风险与缓解依据"}}
```

适用于 `matt-tdd` 或有宿主 committed Pack 的 `matt-code-review`；不得附其他 follow-up，省略 `laneTasks`，TDD 仍提供原 `implementation`。须精确列出全部剩余 IDs；宿主逐项展示 finding、候选与理由，重新取得一次真实 TUI/RPC 用户确认，普通实现/batch 授权、配置、返修次数或 task prose 均不能代替。无 UI、取消、过期或确认期间候选/权限漂移均不记录接受。验收、安全、数据完整性、P0/P1、缺证据或无效报告永不适用。

返回 `state=accepted-risk`、`deliveryEligible=true`、`reviewPassed=false` 与宿主收据；不运行模型或重新采证。原 FAIL、原始结果与确认事实保留，终态不能再次 repair/review/recovery，也不能把同一接受复用到新候选。父会话仍须通过完整验证、精确提交，并在本地 tracker Comments 保留风险说明、`Risk acceptance: <dispatchId>` 与完整 `Implementation commit`。完成报告必须明确“带已知风险交付”，不得称双 PASS。整份 spec 最终 committed 评审不继承单票豁免，若仍有符合条件的 P2，须对该完整范围重新明确确认。

已在门禁之外提交、导致 HEAD/候选漂移的旧票不能借此追认成 PASS 或修改历史。保留失败与真实提交，重新明确已提交评审范围。`failed` 本身不永久禁止 repair：有效 FAIL 且候选/谱系未变时仍可修复。

## 局部恢复与耗时

实现已 COMPLETE、快照/授权仍有效，但某 reviewer 执行失败、结果缺失或 NO_EVIDENCE 时，可传：

```json
{"recovery": {"dispatchId": "<最近 dispatchId>", "lanes": ["spec"]}}
```

只提供所选 reviewer 的 laneTasks。宿主只启动所选失败 reviewer，复用已完成 implement、原 Evidence Pack 和另一轴有效结论；不重新实现、不重新取证，不替换有效 FAIL。执行恢复最多一次；已发生 settlement 的失败不能再叠加恢复，显式恢复不追加 settlement。`reconsider` 同样只需受挑战轴的 task。

committed `matt-code-review` 也可用同一 `recovery` 入口，引用该评审链最新宿主 dispatch，省略 `reviewScope` 与 implementation。宿主复用原 F/H 和 Pack，核对 HEAD、项目与 JSON/Markdown 摘要，只重跑失败轴一次，不重新采集、不运行另一轴或 writer。手动 worktree/files 路径没有宿主固定 Pack，不提供此恢复保证。额度耗尽与网络失败在 receipt 中分别标记为 `provider-limit` / `infrastructure`，与有效 `review-fail` 分开；不自动盲重试，应先解决额度/环境问题。

诊断可使用新的专用测试文件，只需预先把该精确路径同时列入 `allowedFiles` 与 `diagnosticFiles`，并不要求它已经存在。优先这样做，而不是覆盖既有测试。initial/batch 中预声明可用的精确诊断命令；同票同命令在当前 grant 内复用，不按每次诊断重新确认，不接受可任意展开的命令模板。隔离诊断默认设置 `PYTHONDONTWRITEBYTECODE=1`、追加 `PYTEST_ADDOPTS=-p no:cacheprovider`，避免 Python/pytest 自写缓存；不忽略任意缓存目录、不改写批准命令，未授权修改仍阻断。原项目直跑路径不改变环境。

宿主检测到的报告契约错误（未知前驱、不符合上述因果例外的跨轴引用、缺少 approved predecessor 等）单独标记为 `contractError` 并保留原报告，不归一化为 PASS/FAIL，也不静默删除非法引用。此类 lane 仍通过同一 `recovery` 接口纠正，但每个候选快照对每个轴最多两次 report correction，与一次 execution recovery 分开计数；reload、重新确认或 correction 不重置。达到上限后停止，不提供自动 PASS 或无限重试；只有下述旧宿主报告重校验可在不消耗额度的情况下恢复本已合法的报告。若无效报告来自 reconsideration 决定，correction 保持同一 challenged target 集合；只有全部决定合法后才重新计算 effective result。有效 FAIL 不能走 recovery/correction，只能 reconsider 或按 effective findings 修复。

阶段记录保存在宿主 session custom entries，并通过 `pi-matt:dispatch-phase` 事件通知：authorization、admission（单次 writer claim）、evidence、diagnosis、queue、rpc、reconcile、execution、settlement、workflow。运行中的 keyed child/settlement 由原生 lifecycle 事件报告；不要求模型轮询。完整运行 trace 与 deadline 以原生 status.json/events.jsonl 为准，模型按 completion 读取最终结果。

升级后，对旧宿主以 `review-evidence` 拒绝的完整报告，可继续调用原 `recovery: {dispatchId, lanes}`。宿主先核验当前授权、最新 dispatch、候选快照与 Pack，再用当前契约原地重校验所选原报告。只有完整通过当前契约的报告才恢复为其真实 verdict，保留 `revalidationHistory` 与原报告，并发出 `pi-x-matt.report-revalidated`；不运行 reviewer/writer、不重新采证，也不消耗或重置原有计数。因此因旧位置解析错误耗尽两次纠错的候选仍可恢复。仍不合法的报告继续受原预算约束；结构/schema/执行失败不适用此路径，不能降级接受或豁免。恢复后的真实 FAIL 仍须修复，双 PASS 前不得提交或推进 batch。

授权等待不计入 lane timeout；RPC acknowledgement 最多 10 秒；证据 host step 最多 2 分钟；worker 20 分钟、并行 reviewer 各 15 分钟；每个符合条件的 settlement 最多 5 分钟，两个 settlement 可能串行。15 分钟是单 lane 的执行范围，不是完整 TDD 或恢复的总耗时；不能由总耗时直接认定模型卡顿或超时失效。

RPC 回应丢失属于 acceptance unknown：保留 requestId，使用一次 `status id=rpc-spawn-<requestId>` 对账，不自动重新 spawn；未找到/已过期也不能证明未启动。超时与 settlement 的原始结果、恢复错误均保留在 `recoveryHistory` 与 gate 前快照，不只留下最后的 `fetch failed`。
