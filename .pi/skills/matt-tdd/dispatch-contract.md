# Implement dispatch lifecycle

此契约由 dispatcher 的宿主状态强制执行，不以 task 中“用户已授权”等文字为依据。完整三项 `laneTasks` 的角色隔离和最终双轴 `PASS` gate 不变；修复完成与正式评审通过是两个独立边界。

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

用户显式 `/skill:matt-implement` 产生一次 invocation intent，只能绑定第一个限定范围；缺少该记录时，用 TUI/RPC 确认一次具体范围和连续修复。后续同一 ticket/内容 hash/项目/branch/HEAD 且范围已被当前 grant 覆盖的派发不重复入口确认。同 ticket 增加 `allowedFiles` 或替换 `diagnosticFiles`/`diagnosticCommands` 属于新的授权信封，必须重新确认一次；确认后信封被替换而同一修复谱系保留：ticket、`scope`、宿主读取的 ticket hash、项目与 branch/HEAD 必须不变，旧 `allowedFiles` 必须全部保留（只增不减），授权 invocationId 变化不切断之前的 dispatch。宿主以非模型上下文 custom entry 保存真实输入/确认结果；reload 仅从当前 session branch 的这些记录恢复，不扫描其他分支或相信 prose。

授权最长 24 小时；授权对话最多等待 5 分钟，可取消。取消、失效、缺少可靠记录或无 UI 时 fail closed。新 ticket、实质范围扩张、架构选择或破坏性操作仍须新决定；不得以改写 `scope` 绕过根因门禁。新 session/fork 不继承授权；tree navigation 撤销。已经运行的 child 用 `/subagents-stop` 停止。

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

finding 引用为 `<axis>:<id>`；必须覆盖全部真实阻断项，不能重复、遗漏或通过改名清除已有根因计数。相同文件并不自动代表相同根因。父会话只合并根因，不合并 Standards/Spec verdict；无证据或越轴的报告属于 review contract failure，需要修复评审，而不是派发 writer。

`previousDispatchId` 必须指向同一 session、canonical 项目与 ticket 的最近一次未取消派发；宿主不按授权 invocationId 过滤修复历史。重新确认后的修复使用最新 `implementation` 信封：可在保留全部旧 `allowedFiles` 的前提下增加文件，也可替换 `diagnosticFiles`/`diagnosticCommands`（仍须通过原有测试路径与子集校验）。ticket、`scope` 文本、宿主读取的 ticket hash、项目与 branch/HEAD 必须与旧派发完全一致；移除旧文件、收窄范围、ticket 内容/行为变化、快照漂移或引用非最新 `dispatchId` 时 fail closed。已有派发后新的 initial 同样被拒绝，不能借重新授权清空基线、计数或已获批 findings。

`repair` 只运行 writer 和证据采集，不自动启动 reviewer。宿主从最近完成结果选择 `agent=matt-worker`、`resumability.state=resumable` 的精确 runId，以 retained resume 延续原模型、工具、skills/schema 和上下文；不会用父会话提供的 runId 替换。不可恢复、结果不完整或修复执行失败时停止，不暗中换 fresh writer。仍提供完整三项 laneTasks，但此次只执行 implement。

宿主将最新候选 `snapshotId` 与本次调度基线绑定；每次修复都必须从精确候选开始，且不能越过 `allowedFiles`。同时保存最近一次正式评审的来源，计算从该已审快照到本次候选的**累计修复增量**，保留两端内容/hash、原获批 finding IDs 与根因契约，不只计算最后一次补丁。正式复审仍不重新裁决未变化且无依赖影响的已审内容。

修复成功返回 `reviewPending=true`，结果只有 implement lane，并发布 `pi-x-matt.review-pending`。`state=complete` 仅表示本次修复结束，不是 TDD 全流程通过，不授权提交。父会话核对逐项 findings、真实 diff 和聚焦验证证据；仍有证据支持的同范围下一步时，可引用最新 dispatchId 再次 repair。原 findings、根因 ID 与计数跨修复保留，不因未评审而清零，不通过拆轮绕过诊断；不重复实现已完成的 slices 或人为制造旧 RED。

候选准备好后，显式送审：

```json
{"review": {"dispatchId": "<最新已完成 repair 的 dispatchId>"}}
```

仍使用 `workflow=matt-tdd`、最新 `implementation` 信封（同 ticket 可含新增文件或替换后的诊断清单）和完整三项 laneTasks；重新确认不重置待审候选、计数或原 findings。宿主只启动 fresh Standards/Spec，复用最近 implement 结果和只读 Evidence Pack，不重跑 writer、不重复采集；必须确认候选快照未漂移且证据完整。结果保留 implement 并加入本次两轴结果，只有二者 PASS 才能进入最终验证。repair/review/recovery 互斥；尚无待审修复时不接受 review，待审修复也不能借 recovery 跳过正式送审。

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

宿主只执行范围内预先批准的精确命令，最多 30 秒；必须退出码为 1 且出现目标失败文本。成功命令、环境失败、超时或其他症状不能解锁。保存命令、退出码与输出 hash，不把原始日志/敏感数据复制进事件。结论仍由父会话据真实证据判断；这个检查不宣称自动证明根因。没有可用 repro/权限时停止，而非继续第三轮补丁。

若 `testFiles` 提供内联复现内容，父流程必须在提交前完成脱敏并只使用合成或已脱敏 fixture；凭据只经环境变量传入，不写入测试、fixture 或输出。宿主先严格确认原工作区仍等于最近已审 `snapshotId`，并重算 pack 的实际 head/cwd/manifest/diff 绑定：必须匹配宿主记录的 `snapshotId`、`diffSha256` 与实际项目/Git root，内容/hash 被改写即拒绝。随后在自己的 OS temp 目录中从该已审状态重建完整项目：HEAD 中未变化源码，加上已审未提交的 tracked/untracked/删除/重命名变更；只把内联内容写入 `diagnosticFiles` 中的精确路径。随后在隔离区的项目根执行同一个已批准命令，仍要求退出码 1 与目标失败文本。原工作区、HEAD 与 index 不变；运行前后各校验一次原快照，漂移则禁止 writer 入队。GREEN、其他症状、超时、取消、缺少运行前提以及隔离区生产源码/未获批文件变化，都不能作为可信诊断；任何命令结局都复核原快照并清理自有临时区，原始错误与漂移/清理错误保持因果链。宿主把原 dispatchId、已审 snapshotId、范围 hash、根因 IDs、命令、退出码、输出 hash 与测试 path/内容 sha256 记录到 `repair.diagnosis.isolation`，并继续同一个 repair；内联正文只在该次临时区使用，长期 repair 证据与 implement lane handoff 不含原文。该隔离是本机故障隔离，不是安全 sandbox：不联网安装依赖，不复制个人 ignored 资料，也不把原源码路径链接进隔离区。隔离区不含原 `.git`、submodule 内容或未复制的依赖；依赖这些前提的命令按缺少运行前提失败，而不是伪装成目标 RED。该门禁不自动识别任意 secret/PII，也不能从会话记录中抹去已经提交的工具输入。未提供 `testFiles` 时保留原路径：直接在项目根执行已批准命令。

隔离区的非诊断文件指纹同时包含内容与权限；失败子进程输出不进入持久化 trace，仅保留退出状态、信号和输出摘要。准备失败且清理也失败时，两者错误都保留，不用清理错误覆盖原始原因。

“原测试 GREEN、补测试后 RED”是本路径要支持的场景，不是强制先 GREEN 的新增门禁；原已能复现的目标 RED 同样有效。宿主仍只接受获批命令真实产生的目标失败，worker 后续必须独立完成自己的 RED→GREEN。

## 增量 findings

每个 finding 除 severity/title/evidence/locations/recommendation 外，还必须有：

- `id`、稳定 `rootCauseId`；
- `basis: {kind: acceptance|standard|safety|integrity, reference: 精确条款或安全/完整性要求}`；
- `expected`、`actual` 和可复现步骤或真实代码路径证据；
- `classification: original|regression|independent`；
- `relatedFindingIds`：原问题/修复回归引用此前获批的 axis-prefixed ID，独立问题可为空；
- `affectedBy`：有一层依赖影响时，列出引发影响的本轮变化路径，并在 evidence 解释真实影响链，否则为空。

Spec 只以 acceptance 为依据；Standards 以 standard/safety/integrity 为依据。非阻断建议留 notes。未变化且无依赖影响、非原 finding 的普通新意见不能阻断增量交付；新证实的安全/完整性问题即使位于未变化文件也可阻断。无证据或越轴报告不能仅凭 P0/P1/P2 成为有效缺陷；宿主标记为评审契约失败，保留原报告，不擅自改成 PASS。

## 局部恢复与耗时

实现已 COMPLETE、快照/授权仍有效，但某 reviewer 执行失败、结果缺失或 NO_EVIDENCE 时，可传：

```json
{"recovery": {"dispatchId": "<最近 dispatchId>", "lanes": ["spec"]}}
```

仍提供完整三项 laneTasks。宿主只启动所选失败 reviewer，复用已完成 implement、原 Evidence Pack 和另一轴有效结论；不重新实现、不重新取证，不替换有效 FAIL。执行恢复最多一次；已发生 settlement 的失败不能再叠加恢复，显式恢复不追加 settlement。

宿主检测到的报告契约错误（未知/不同轴 `relatedFindingIds`、缺少 approved predecessor 等）单独标记为 `contractError` 并保留原报告，不归一化为 PASS/FAIL，也不静默删除非法引用。此类 lane 仍通过同一 `recovery` 接口纠正，但每个候选快照对每个轴最多两次 report correction，与一次 execution recovery 分开计数；reload、重新确认或 correction 不重置。达到上限后停止，不提供自动 PASS 或无限重试。若无效报告来自 reconsideration 决定，correction 保持同一 challenged target 集合；只有全部决定合法后才重新计算 effective result。有效 FAIL 不能走 recovery/correction，只能 reconsider 或按 effective findings 修复。

阶段记录保存在宿主 session custom entries，并通过 `pi-matt:dispatch-phase` 事件通知：authorization、admission（单次 writer claim）、evidence、diagnosis、queue、rpc、reconcile、execution、settlement、workflow。运行中的 keyed child/settlement 由原生 lifecycle 事件报告；不要求模型轮询。完整运行 trace 与 deadline 以原生 status.json/events.jsonl 为准，模型按 completion 读取最终结果。

授权等待不计入 lane timeout；RPC acknowledgement 最多 10 秒；证据 host step 最多 2 分钟；worker 20 分钟、并行 reviewer 各 15 分钟；每个符合条件的 settlement 最多 5 分钟，两个 settlement 可能串行。15 分钟是单 lane 的执行范围，不是完整 TDD 或恢复的总耗时；不能由总耗时直接认定模型卡顿或超时失效。

RPC 回应丢失属于 acceptance unknown：保留 requestId，使用一次 `status id=rpc-spawn-<requestId>` 对账，不自动重新 spawn；未找到/已过期也不能证明未启动。超时与 settlement 的原始结果、恢复错误均保留在 `recoveryHistory` 与 gate 前快照，不只留下最后的 `fetch failed`。
