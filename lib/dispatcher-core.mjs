import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildRegistry, serializeRegistry } from "../scripts/generate-registry.mjs";
import { adjudicateReviewDecisions, canonicalFindingId, validateReviewResult, withSpecEvidenceHint } from "./review-contract.mjs";

const reconsiderationSchema = axis => ({
  type: "object",
  properties: {
    axis: { type: "string", enum: [axis] },
    decisions: {
      type: "array", minItems: 1,
      items: {
        type: "object",
        properties: {
          findingId: { type: "string", minLength: 1 },
          decision: { type: "string", enum: ["uphold", "withdraw"] },
          justification: { type: "string", minLength: 1 },
          evidence: { type: "string", minLength: 1 },
        },
        required: ["findingId", "decision", "justification", "evidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["axis", "decisions"],
  additionalProperties: false,
});

export const PRE_REVIEW_HOST_TIMEOUT_MS = 660000;
export const CORRECTION_TIMEOUT_MS = 600000;
const CORRECTION_TASK = [
  "宿主校验纠正（同一 writer、同一授权范围内的一次有界纠正）。",
  "宿主在你返回 COMPLETE 后做了确定性校验，下列项目未通过：accounting 是逐条 finding 交代的完整性，preReview 是已获批评审前命令的真实退出状态与输出尾部。",
  "只修复这些校验指出的问题：不扩大范围、不新增未获批文件、不顺手重构、不修改测试来迁就失败。可以运行 preReview 中列出的获批命令来复现和确认。",
  "完成后重新调用 structured_output，严格匹配原 schema，返回覆盖本次派发全部工作的完整累计结果（保留此前 cycles/commands 并追加本次的）；修复派发必须为每个 approvedFindingIds 提供一条 findingResolutions。",
  "若失败与本次改动无关、需要范围外文件或需要决定，不要硬改：以 BLOCKED 如实说明。",
  "宿主校验结果：\n",
].join(" ");
const HOST_FAILURE_REVIEW_NOTE = "\n\n宿主确定性校验未通过（见前序阶段结果的 hostVerification：宿主实测的获批评审前命令退出状态与输出尾部，" +
  "不是 worker 自述）。这是独立证据：除非 Pack 证据表明失败与本次变更无关，Standards 轴须把它报告为 basis.kind=integrity 的阻断 finding" +
  "（reference 写失败命令）；Spec 轴仅在它证明某条验收行为未满足时报告。无论评审结论如何，该候选在宿主校验通过前不可交付。";
const RESOLUTION_REVIEW_NOTE = "\n\nfindingResolutions 是 writer 对上一轮每条获批 finding 的自述交代（宿主只校验了逐条覆盖与 cycle 引用的一致性）。" +
  "逐条对照 Pack 中的真实变更核验，它不是已修复的证据；交代与真实变更不符时按原 finding ID 报告复发。";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Inlined into the workflow script: completeness and consistency of the writer's accounting, never the truth of a fix. */
export function verifyFindingResolutions(result, approvedFindingIds) {
  const output = result?.structuredOutput ?? {};
  const tests = new Set((output.cycles ?? []).map(cycle => cycle.test));
  const resolved = new Set(), invalid = [];
  for (const row of Array.isArray(output.findingResolutions) ? output.findingResolutions : []) {
    const matches = approvedFindingIds.filter(id => id === row?.findingId || id.slice(id.indexOf(":") + 1) === row?.findingId);
    const reason = matches.length !== 1 ? (matches.length ? "ambiguous finding id" : "unknown finding id")
      : resolved.has(matches[0]) ? "duplicate finding id"
      : typeof row.evidence !== "string" || !row.evidence.trim() ? "missing evidence"
      : row.cycleTest !== null && !tests.has(row.cycleTest) ? "unknown cycle test" : null;
    if (reason) invalid.push({ findingId: String(row?.findingId), reason });
    else resolved.add(matches[0]);
  }
  const unresolvedFindingIds = approvedFindingIds.filter(id => !resolved.has(id));
  return { approvedFindingIds, resolvedFindingIds: [...resolved], unresolvedFindingIds, invalid,
    ok: unresolvedFindingIds.length === 0 && invalid.length === 0 };
}

export async function findProjectRoot(cwd) {
  let current = resolve(cwd);
  while (true) {
    try {
      await readFile(resolve(current, ".pi", "settings.json"), "utf8");
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) throw new Error("pi-matt-dispatch requires a project .pi/settings.json");
      current = parent;
    }
  }
}

export async function loadCurrentRegistry(packageRoot) {
  const registryPath = resolve(packageRoot, "config", "skill-registry.json");
  const raw = await readFile(registryPath, "utf8");
  // Validate sources once; never follow paths or execute routing from the on-disk cache.
  const registry = await buildRegistry(packageRoot);
  if (raw !== serializeRegistry(registry)) {
    throw new Error("config/skill-registry.json is not the current generated registry; run npm run registry");
  }

  return registry;
}

export function resolveLeafClosure(registry, workflowName, lane) {
  const resolved = [];
  const visited = new Set();
  const visiting = new Set();

  function visit(name) {
    if (visiting.has(name)) throw new Error(`Skill dependency cycle at '${name}'`);
    if (visited.has(name)) return;
    const entry = registry.skills[name];
    if (!entry) throw new Error(`Workflow '${workflowName}' has missing dependency '${name}'`);
    if (entry.scope !== "leaf") throw new Error(`Workflow dependency '${name}' is not a leaf skill`);
    if (entry.agent !== lane.agent) {
      throw new Error(`Workflow '${workflowName}' lane '${lane.key}' cannot grant '${name}' to agent '${lane.agent}'`);
    }

    visiting.add(name);
    for (const dependency of entry.dependsOn) visit(dependency);
    visiting.delete(name);
    visited.add(name);
    resolved.push(entry);
  }

  for (const skillName of lane.skills) visit(skillName);
  return resolved;
}

function assertRuntimeWorkflow(workflow) {
  const definition = workflow.workflow;
  if (!definition || definition.mode !== workflow.dispatch) {
    throw new Error(`Workflow '${workflow.name}' has an invalid generated routing definition`);
  }
  if (!Array.isArray(definition.lanes) || definition.lanes.length === 0) {
    throw new Error(`Workflow '${workflow.name}' has no lanes`);
  }
  if (definition.mode === "single" && definition.lanes.length !== 1) {
    throw new Error(`Workflow '${workflow.name}' single mode requires exactly one lane`);
  }
  if (definition.mode === "parallel" && definition.lanes.length < 2) {
    throw new Error(`Workflow '${workflow.name}' parallel mode requires at least two lanes`);
  }
  if (definition.mode === "pipeline" && definition.lanes.length < 2) {
    throw new Error(`Workflow '${workflow.name}' pipeline mode requires at least two lanes`);
  }
  if (definition.mode !== "single" && definition.mode !== "parallel" && definition.mode !== "pipeline") {
    throw new Error(`Workflow '${workflow.name}' has unsupported mode '${definition.mode}'`);
  }

  const keys = new Set();
  for (const lane of definition.lanes) {
    if (!isObject(lane) || typeof lane.key !== "string" || !lane.key) {
      throw new Error(`Workflow '${workflow.name}' has an invalid lane`);
    }
    if (lane.key.endsWith("-settlement")) {
      throw new Error(`Workflow '${workflow.name}' lane '${lane.key}' uses reserved settlement suffix`);
    }
    if (keys.has(lane.key)) throw new Error(`Workflow '${workflow.name}' has duplicate lane '${lane.key}'`);
    keys.add(lane.key);
    if (typeof lane.agent !== "string" || !Array.isArray(lane.skills) || lane.skills.length === 0) {
      throw new Error(`Workflow '${workflow.name}' lane '${lane.key}' has invalid routing`);
    }
    if (!Number.isInteger(lane.timeoutMs) || lane.timeoutMs <= 0) {
      throw new Error(`Workflow '${workflow.name}' lane '${lane.key}' has invalid timeoutMs`);
    }
    if (lane.turnBudget !== undefined) {
      throw new Error(`Workflow '${workflow.name}' lane '${lane.key}' uses unsupported turnBudget`);
    }
    if (!isObject(lane.outputSchema) || lane.outputSchema.type !== "object") {
      throw new Error(`Workflow '${workflow.name}' lane '${lane.key}' has invalid outputSchema`);
    }
    if (definition.mode === "pipeline") {
      if (!Number.isInteger(lane.stage) || lane.stage <= 0) {
        throw new Error(`Workflow '${workflow.name}' lane '${lane.key}' has invalid stage`);
      }
    } else if (lane.stage !== undefined) {
      throw new Error(`Workflow '${workflow.name}' lane '${lane.key}' cannot define pipeline stage routing`);
    }
    if (lane.gate !== undefined) {
      const gatedProperty = lane.outputSchema.properties?.[lane.gate?.field];
      if (
        !isObject(lane.gate) ||
        typeof lane.gate.field !== "string" ||
        !lane.gate.field ||
        typeof lane.gate.equals !== "string" ||
        !isObject(gatedProperty) ||
        !Array.isArray(gatedProperty.enum) ||
        !gatedProperty.enum.includes(lane.gate.equals) ||
        (lane.gate.nonEmpty !== undefined && (
          !Array.isArray(lane.gate.nonEmpty) ||
          lane.gate.nonEmpty.length === 0 ||
          lane.gate.nonEmpty.some((name) => typeof name !== "string" || lane.outputSchema.properties?.[name]?.type !== "array") ||
          new Set(lane.gate.nonEmpty).size !== lane.gate.nonEmpty.length
        ))
      ) {
        throw new Error(`Workflow '${workflow.name}' lane '${lane.key}' has invalid gate`);
      }
    }
  }

  if (definition.mode === "pipeline") {
    const stages = [...new Set(definition.lanes.map((lane) => lane.stage))].sort((a, b) => a - b);
    if (stages.length < 2 || stages.some((stage, index) => stage !== index + 1)) {
      throw new Error(`Workflow '${workflow.name}' has invalid pipeline stages`);
    }
  }
}

/** Validate caller input and resolve leaf grants before authorization or evidence collection. */
export function prepareDispatchRequest(registry, workflow, task, targetProjectRoot, laneTasks = {}, requiredLaneKeys) {
  if (workflow.scope !== "parent" || workflow.class !== "orchestration") {
    throw new Error(`'${workflow.name}' is not a parent orchestration workflow`);
  }
  if (typeof task !== "string" || !task.trim()) throw new Error("Dispatch task must not be empty");
  assertRuntimeWorkflow(workflow);

  if (!isObject(laneTasks)) throw new Error("Dispatch laneTasks must be an object");
  const laneKeys = new Set(workflow.workflow.lanes.map((lane) => lane.key));
  for (const [key, laneTask] of Object.entries(laneTasks)) {
    if (!laneKeys.has(key)) throw new Error(`Dispatch laneTasks has unknown lane '${key}'`);
    if (typeof laneTask !== "string" || !laneTask.trim()) {
      throw new Error(`Dispatch laneTasks.${key} must be a non-empty string`);
    }
  }
  if (workflow.name === "matt-tdd" || workflow.name === "matt-code-review") {
    const missingLaneTasks = (requiredLaneKeys ?? [...laneKeys]).filter((key) => !Object.hasOwn(laneTasks, key));
    if (missingLaneTasks.length > 0) {
      throw new Error(`Workflow '${workflow.name}' requires complete laneTasks for [${missingLaneTasks.join(", ")}]`);
    }
  }

  const lanes = workflow.workflow.lanes.map((lane) => {
    const leafSkills = resolveLeafClosure(registry, workflow.name, lane);
    if (leafSkills.length === 0) throw new Error(`Workflow '${workflow.name}' lane '${lane.key}' has no leaf skills`);
    const delegatedTask = Object.hasOwn(laneTasks, lane.key) ? laneTasks[lane.key].trim() : task.trim();
    return {
      key: lane.key,
      ...(lane.stage !== undefined ? { stage: lane.stage } : {}),
      agent: lane.agent,
      skills: leafSkills.map((entry) => entry.name),
      task: `${lane.taskPrefix}\n\n委派任务：\n${delegatedTask}`,
      timeoutMs: lane.timeoutMs,
      ...(lane.gate ? { gate: lane.gate } : {}),
      outputSchema: lane.outputSchema,
    };
  });

  return { workflow, lanes, targetProjectRoot };
}

/** Build once from the prepared request, after trusted repair/evidence details are known. */
export function buildDispatchRequest({ workflow, lanes, targetProjectRoot }, reviewEvidence, recovery, execution = {}) {
  const reconsider = execution.reconsider;
  const reviewOnly = Boolean(execution.implementResult) && !reconsider;
  // Host verification only follows a writer run; review, recovery and reconsideration reuse a settled candidate.
  const verification = workflow.name === "matt-tdd" && !recovery && !reviewOnly && !reconsider
    ? execution.verification : undefined;
  const approvedFindingIds = verification?.approvedFindingIds ?? [];
  const preReviewCommand = verification ? reviewEvidence?.preReviewCommand : undefined;
  const reconsiderTask = lane => {
    const targets = reconsider.targets.filter(target => target.axis === lane.key)
      .map(({ reason, challengeEvidence, ...finding }) =>
        ({ findingId: finding.id, originalFinding: finding, reason, evidence: challengeEvidence }));
    return `${lane.task}\n\nReconsideration decision mode (${lane.key} axis only). A fresh read-only reviewer must independently ` +
      "decide each challenged valid FAIL finding. Do not modify files, rerun the writer, add findings, change unrelated " +
      "findings, or decide the other axis. Return exactly one decision for every challenged findingId, with non-empty " +
      `justification and evidence. "uphold" keeps the original blocker; "withdraw" removes only that finding.\n` +
      `Challenged findings:\n${JSON.stringify(targets)}`;
  };
  const runLanes = reconsider
    ? lanes.map(lane => reconsider.keys.includes(lane.key)
      ? { ...lane, task: reconsiderTask(lane), outputSchema: reconsiderationSchema(lane.key),
        gate: undefined }
      : lane)
    : lanes;
  const toRunItem = (lane) => lane.key === "implement" && execution.resume ? ({
    key: lane.key, resume: execution.resume, task: lane.task, timeoutMs: lane.timeoutMs, output: false,
  }) : ({
    key: lane.key,
    agent: lane.agent,
    task: lane.task,
    context: "fresh",
    skill: lane.skills,
    timeoutMs: lane.timeoutMs,
    outputSchema: lane.outputSchema,
    output: false,
  });
  const settlementRecoveryLines = (resultsName, stageLanes) => stageLanes.flatMap((lane, index) => {
    const recoveryKey = `${lane.key}-settlement`;
    const recoveryTask = [
      "结构化结果结算恢复。不要继续实现、探索、读取文件、运行命令或修改工作区。",
      "只使用当前保留会话中已有证据，立即调用 structured_output，并严格匹配原 schema。",
      "若原任务未完成或证据不足，使用 schema 允许的 BLOCKED、NO_EVIDENCE 或 FAIL 如实返回；不得编造 COMPLETE 或 PASS。",
      "structured_output 必须是你的最后一个动作，不要只返回 prose。",
    ].join(" ");
    return [
      `{`,
      `  const failedResult = ${resultsName}[${index}];`,
      "  const failedError = typeof failedResult?.error === 'string' ? failedResult.error : '';",
      "  const needsSettlement = !failedResult?.structuredOutput && (failedResult?.terminalOutcome?.reason === 'timeout' || failedResult?.timedOut === true || /Subagent timed out/.test(failedError));",
      "  if (needsSettlement && failedResult?.runId && failedResult?.resumability?.state === 'resumable') {",
      `    emit({ type: "pi-x-matt.recovery", lane: ${JSON.stringify(lane.key)}, state: "started", original: failedResult });`,
      "    try {",
      `      const settlementResults = await runs.all([{ key: ${JSON.stringify(recoveryKey)}, resume: failedResult.runId, task: ${JSON.stringify(recoveryTask)}, timeoutMs: 300000 }]);`,
      "      const settlementResult = settlementResults[0];",
      `      ${resultsName}[${index}] = { ...(settlementResult ?? failedResult), key: ${JSON.stringify(lane.key)}, recoveryHistory: [...(failedResult.recoveryHistory ?? []), failedResult], ...(!settlementResult?.ok ? { ok: false, error: failedError + '; settlement failed: ' + (settlementResult?.error ?? 'missing result') } : {}) };`,
      "    } catch (error) {",
      `      ${resultsName}[${index}] = { ...failedResult, ok: false, error: failedError + '; settlement failed: ' + String(error), recoveryHistory: [...(failedResult.recoveryHistory ?? []), failedResult] };`,
      "    }",
      `    emit({ type: "pi-x-matt.recovery", lane: ${JSON.stringify(lane.key)}, state: "settled", result: ${resultsName}[${index}] });`,
      "  }",
      `}`,
    ];
  });
  // emit survives script exceptions in status.json.workflow.emits; return does not.
  // Publish the entire settled stage (and prior stages) before any lane gate.
  const publishResultsLine = (resultsExpression, stage = 1) =>
    `emit({ type: "pi-x-matt.stage-results", version: 1, workflow: ${JSON.stringify(workflow.name)}, stage: ${stage}, results: ${resultsExpression} });`;
  const validationLines = (resultsName, stageLanes) => {
    const laneKeys = stageLanes.map((lane) => lane.key);
    return [
      `if (!Array.isArray(${resultsName}) || ${resultsName}.length !== ${stageLanes.length}) {`,
      `  throw new Error(${JSON.stringify(`Workflow expected ${stageLanes.length} lane result(s) for [${laneKeys.join(", ")}].`)});`,
      "}",
      `for (let index = 0; index < ${resultsName}.length; index++) {`,
      `  const result = ${resultsName}[index];`,
      `  if (!result || result.key !== ${JSON.stringify(laneKeys)}[index]) {`,
      `    throw new Error('Workflow returned an unexpected result for lane ' + ${JSON.stringify(laneKeys)}[index] + '.');`,
      "  }",
      "  if (!result.structuredOutput || typeof result.structuredOutput !== 'object' || Array.isArray(result.structuredOutput)) {",
      "    const failureReason = typeof result.error === 'string' && result.error.trim()",
      "      ? result.error.trim()",
      "      : result.terminalOutcome?.reason === 'timeout'",
      "        ? 'Subagent timed out.'",
      "        : result.terminalOutcome?.reason === 'budget_exhausted'",
      "          ? 'Subagent exceeded its budget.'",
      "          : result.stopped",
      "            ? 'Subagent stopped before completion.'",
      "            : result.interrupted",
      "              ? 'Subagent was interrupted before completion.'",
      "              : result.detached",
      "                ? 'Subagent detached before completion.'",
      "                : undefined;",
      "    if (failureReason) {",
      `      throw new Error('Workflow lane ' + ${JSON.stringify(laneKeys)}[index] + ' failed before structuredOutput: ' + failureReason);`,
      "    }",
      `    throw new Error('Workflow lane ' + ${JSON.stringify(laneKeys)}[index] + ' completed without valid structuredOutput.');`,
      "  }",
      "  if (result.ok !== true) {",
      "    const failureReason = typeof result.error === 'string' && result.error.trim()",
      "      ? result.error.trim() : 'Subagent did not complete successfully.';",
      `    throw new Error('Workflow lane ' + ${JSON.stringify(laneKeys)}[index] + ' failed despite structuredOutput: ' + failureReason);`,
      "  }",
      ...stageLanes.flatMap((lane, index) => lane.gate && (!reconsider || lane.key === "implement") ? [
        `  if (index === ${index} && result.structuredOutput[${JSON.stringify(lane.gate.field)}] !== ${JSON.stringify(lane.gate.equals)}) {`,
        `    throw new Error(${JSON.stringify(`Workflow gate '${lane.key}.${lane.gate.field}' did not equal '${lane.gate.equals}'.`)});`,
        "  }",
        ...(lane.gate.nonEmpty ?? []).flatMap((field) => [
          `  if (index === ${index} && (!Array.isArray(result.structuredOutput[${JSON.stringify(field)}]) || result.structuredOutput[${JSON.stringify(field)}].length === 0)) {`,
          `    throw new Error(${JSON.stringify(`Workflow gate '${lane.key}.${lane.gate.field}' requires non-empty '${field}'.`)});`,
          "  }",
        ]),
      ] : []),
      "}",
    ];
  };
  // Never throws: a failed check keeps the COMPLETE result so review admission, not a lost writer, blocks it.
  const hostVerificationLines = (resultsName, stageLanes, stage) => {
    const nonEmpty = stageLanes[0].gate?.nonEmpty ?? [];
    // Generated inline per host step: the workflow sandbox rejects nested async functions.
    const checkLines = (name, key) => [
      `const ${name} = { version: 1, ok: true };`,
      ...(approvedFindingIds.length ? [
        `${name}.accounting = verifyFindingResolutions(${resultsName}[0], approvedFindingIds);`,
        `${name}.ok = ${name}.accounting.ok;`,
      ] : []),
      ...(preReviewCommand ? [
        "try {",
        `  ${name}.preReview = JSON.parse((await runs.host(${JSON.stringify(key)}, ${JSON.stringify({ kind: "command", command: preReviewCommand, timeoutMs: PRE_REVIEW_HOST_TIMEOUT_MS })})).stdout);`,
        "} catch (error) {",
        `  ${name}.preReview = { ok: false, error: String(error?.message ?? error) };`,
        "}",
        `${name}.ok = ${name}.ok && ${name}.preReview.ok === true;`,
      ] : []),
    ];
    return [
      `const verifyFindingResolutions = ${verifyFindingResolutions.toString()};`,
      `const approvedFindingIds = ${JSON.stringify(approvedFindingIds)};`,
      ...checkLines("initialCheck", "pre-review"),
      "let hostVerification = initialCheck;",
      `const verifiedWriter = ${resultsName}[0];`,
      // Runner errors and worktree drift are command problems the writer cannot correct.
      "if (!initialCheck.ok && !initialCheck.preReview?.error && !initialCheck.preReview?.drift &&",
      "    verifiedWriter.runId && verifiedWriter.resumability?.state === 'resumable') {",
      `  emit({ type: "pi-x-matt.host-verification", version: 1, state: "correcting", verification: initialCheck });`,
      "  let corrected, correctionError;",
      "  try {",
      `    corrected = (await runs.all([{ key: "implement-correction", resume: verifiedWriter.runId, task: ${JSON.stringify(CORRECTION_TASK)} + JSON.stringify(initialCheck), timeoutMs: ${CORRECTION_TIMEOUT_MS} }]))[0];`,
      "  } catch (error) {",
      "    correctionError = String(error?.message ?? error);",
      "  }",
      "  const output = corrected?.structuredOutput;",
      `  const applied = corrected?.ok === true && output?.status === "COMPLETE" && ${JSON.stringify(nonEmpty)}.every(field => Array.isArray(output[field]) && output[field].length > 0);`,
      "  if (applied) {",
      `    ${resultsName}[0] = { ...corrected, key: "implement", ...(verifiedWriter.recoveryHistory ? { recoveryHistory: verifiedWriter.recoveryHistory } : {}), correctionHistory: [...(verifiedWriter.correctionHistory ?? []), verifiedWriter] };`,
      "  } else if (corrected?.runId && corrected.resumability?.state === 'resumable') {",
      // The rejected turn still advanced the retained session; a later repair must resume its newest handle.
      `    ${resultsName}[0] = { ...verifiedWriter, runId: corrected.runId, resumability: corrected.resumability, ...(corrected.continuation ? { continuation: corrected.continuation } : {}) };`,
      "  }",
      ...checkLines("recheck", "pre-review-recheck").map(line => `  ${line}`),
      `  hostVerification = { ...recheck, initial: initialCheck, correction: applied ? { state: "applied" } : { state: "rejected", status: output?.status, summary: output?.summary, error: correctionError ?? corrected?.error } };`,
      "}",
      `${resultsName}[0] = { ...${resultsName}[0], hostVerification };`,
      `emit({ type: "pi-x-matt.host-verification", version: 1, state: "settled", verification: hostVerification });`,
      publishResultsLine(`[...results, ...${resultsName}]`, stage),
    ];
  };

  let workflowScript;
  if (workflow.workflow.mode === "pipeline") {
    const stages = [...new Set(runLanes.map((lane) => lane.stage))].sort((a, b) => a - b)
      .filter((_stage, index) => !execution.repairOnly || index === 0);
    const lines = ["const results = [];",
      `const canonicalFindingId = ${canonicalFindingId.toString()};`,
      `const withSpecEvidenceHint = ${withSpecEvidenceHint.toString()};`];
    if (reviewEvidence?.claimCommand && !recovery && !reviewOnly && !reconsider) {
      lines.push(`await runs.host("implement-claim", ${JSON.stringify({ kind: "command", command: reviewEvidence.claimCommand, timeoutMs: 10000 })});`);
    }
    if (reviewEvidence?.controlled) lines.push(`let reviewBoundary = ${JSON.stringify(recovery?.boundary ?? execution.boundary ?? null)};`);
    const captureEvidence = () => [
      `${reviewEvidence.controlled ? "const capture = " : ""}await runs.host("review-evidence", ${JSON.stringify({ kind: "command", command: reviewEvidence.command, timeoutMs: 120000 })});`,
      ...(reviewEvidence.controlled ? [
        "const captured = JSON.parse(capture.stdout);",
        "reviewBoundary = captured.boundary;",
        ...(reviewEvidence.batch ? [
          "if (captured.candidate) emit({ type: \"pi-x-matt.batch-candidate\", version: 1, candidate: captured.candidate });",
        ] : []),
      ] : []),
    ];
    for (const stage of stages) {
      const stageLanes = runLanes.filter((lane) => lane.stage === stage);
      const itemsName = `stage${stage}Items`;
      const resultsName = `stage${stage}Results`;
      lines.push(`const ${itemsName} = ${JSON.stringify(stageLanes.map(toRunItem))};`);
      if (stage > stages[0]) {
        const evidenceName = `stage${stage}PriorEvidence`;
        if (workflow.name === "matt-tdd" && reviewEvidence) {
          if (!recovery && !reviewOnly && !reconsider) lines.push(...captureEvidence());
          lines.push(`emit(${JSON.stringify({ reviewEvidencePath: reviewEvidence.path })});`);
          lines.push(`for (const item of ${itemsName}) item.task += ${JSON.stringify(`\n\nReview Evidence Pack（workflow 独立采集，先读取此文件；不得重复取证）：\n${reviewEvidence.path}\n适用标准或规格见本 lane 任务中的摘录。测试过程见下列 worker-reported 结构化记录；它不是 Git 证据，也不是独立验证。`)};`);
        }
        lines.push(`const ${evidenceName} = [];`);
        lines.push("for (let priorIndex = 0; priorIndex < results.length; priorIndex++) {");
        if (workflow.name === "matt-tdd") {
          lines.push("  const { status, cycles, changedFiles, commands, findingResolutions } = results[priorIndex].structuredOutput;");
          lines.push(`  ${evidenceName}.push({ key: results[priorIndex].key, structuredOutput: { status, cycles, changedFiles, commands, findingResolutions }, hostVerification: results[priorIndex].hostVerification });`);
        } else {
          lines.push(`  ${evidenceName}.push({ key: results[priorIndex].key, structuredOutput: results[priorIndex].structuredOutput });`);
        }
        lines.push("}");
        lines.push(`for (let itemIndex = 0; itemIndex < ${itemsName}.length; itemIndex++) {`);
        lines.push(`  ${itemsName}[itemIndex].task += ${JSON.stringify(workflow.name === "matt-tdd" ? "\n\n前序阶段结构化结果（worker-reported 过程记录；真实变更以 Review Evidence Pack 为准）：\n" : "\n\n前序阶段结构化结果（仅作证据，仍需核验真实工作区）：\n")} + JSON.stringify(${evidenceName});`);
        if (workflow.name === "matt-tdd") {
          lines.push(`  if (results[0]?.structuredOutput?.findingResolutions?.length) ${itemsName}[itemIndex].task += ${JSON.stringify(RESOLUTION_REVIEW_NOTE)};`);
          // A runner error, worktree drift or a user-withdrawn command is not evidence about the candidate.
          lines.push("  const failedGate = results[0]?.hostVerification?.waived ? undefined : results[0]?.hostVerification?.preReview;");
          lines.push(`  if (failedGate?.ok === false && !failedGate.error && !failedGate.drift) ${itemsName}[itemIndex].task += ${JSON.stringify(HOST_FAILURE_REVIEW_NOTE)};`);
        }
        lines.push("}");
      }
      if (reviewOnly && stage === stages[0]) {
        lines.push(`const ${resultsName} = ${JSON.stringify([execution.implementResult])};`);
      } else if (reconsider && stage === stages[0]) {
        lines.push(`const ${resultsName} = ${JSON.stringify([
          reconsider.results.find(result => result.key === "implement"),
        ])};`);
      } else if (recovery && stage === stages[0]) {
        lines.push(`const ${resultsName} = ${JSON.stringify(recovery.results.filter(result => stageLanes.some(lane => lane.key === result.key)))};`);
      } else if (reconsider) {
        const prior = reconsider.results.filter(result => stageLanes.some(lane => lane.key === result.key));
        lines.push(`const ${resultsName}Original = ${JSON.stringify(prior)};`);
        lines.push(`const ${resultsName}Fresh = await runs.all(${itemsName}.filter(item => ${JSON.stringify(reconsider.keys)}.includes(item.key)));`);
        lines.push(`const ${resultsName} = JSON.parse(JSON.stringify(${resultsName}Original));`);
        lines.push(`for (let index = 0; index < ${resultsName}.length; index++) {`);
        lines.push(`  const fresh = ${resultsName}Fresh.find(result => result.key === ${resultsName}[index].key);`);
        lines.push(`  if (fresh) ${resultsName}[index] = fresh;`);
        if (reconsider.recovery) {
          lines.push(`  const prior = ${JSON.stringify(reconsider.priorResults)}.find(result => result.key === ${resultsName}[index].key);`);
          lines.push(`  if (fresh) ${resultsName}[index] = { ...fresh, ...(${JSON.stringify(reconsider.correctionKeys)}.includes(fresh.key)`);
          lines.push(`    ? { correctionHistory: [...(prior.correctionHistory ?? []), prior] }`);
          lines.push(`    : { recoveryHistory: [...(prior.recoveryHistory ?? []), prior] }) };`);
        }
        lines.push("}");
      } else if (recovery) {
        lines.push(`const ${resultsName}Fresh = ${recovery.keys.length
          ? `await runs.all(${itemsName}.filter(item => ${JSON.stringify(recovery.keys)}.includes(item.key)))` : "[]"};`);
        lines.push(`const ${resultsName} = ${JSON.stringify(stageLanes.map(lane => recovery.results.find(result => result.key === lane.key) ?? { key: lane.key }))};`);
        lines.push(`for (let index = 0; index < ${resultsName}.length; index++) {`);
        lines.push(`  const fresh = ${resultsName}Fresh.find(result => result.key === ${resultsName}[index].key);`);
        lines.push(`  if (fresh) ${resultsName}[index] = { ...fresh, ...(${JSON.stringify(recovery.correctionKeys ?? [])}.includes(${resultsName}[index].key)`);
        lines.push(`    ? { correctionHistory: [...(${resultsName}[index].correctionHistory ?? []), ${resultsName}[index]] }`);
        lines.push(`    : { recoveryHistory: [${resultsName}[index]] }) };`);
        lines.push("}");
      } else {
        lines.push(`const ${resultsName} = await runs.all(${itemsName});`);
      }
      if (execution.writerRecovery && stage === stages[0]) {
        const original = execution.writerRecovery.originalResult;
        lines.push(`for (let index = 0; index < ${resultsName}.length; index++) {`);
        lines.push(`  ${resultsName}[index] = { ...${resultsName}[index], recoveryHistory: ${JSON.stringify([
          ...(original.recoveryHistory ?? []), original,
        ])} };`);
        lines.push("}");
      }
      if (reviewEvidence?.controlled && stage > stages[0] && !reconsider) {
        lines.push(`for (let index = 0; index < ${resultsName}.length; index++) ${resultsName}[index] = (${validateReviewResult.toString()})(${resultsName}[index], reviewBoundary);`);
      }
      if (stage > stages[0]) {
        lines.push(`for (let index = 0; index < ${resultsName}.length; index++) ${resultsName}[index] = withSpecEvidenceHint(${resultsName}[index]);`);
      }
      lines.push(publishResultsLine(`[...results, ...${resultsName}]`, stage));
      if (!recovery && !execution.writerRecovery && !reconsider?.recovery && !(reviewOnly && stage === stages[0])) {
        lines.push(...settlementRecoveryLines(resultsName, stageLanes));
      }
      if (reconsider && stage > stages[0]) {
        lines.push(`for (let index = 0; index < ${resultsName}.length; index++) {`);
        lines.push(`  const key = ${resultsName}[index].key;`);
        lines.push(`  if (!${JSON.stringify(reconsider.keys)}.includes(key)) continue;`);
        lines.push(`  const original = ${resultsName}Original.find(result => result.key === key);`);
        lines.push(`  const targets = ${JSON.stringify(reconsider.targets)}.filter(target => target.axis === key);`);
        lines.push(`  const history = ${JSON.stringify(reconsider.history ?? {})}[key] ?? [];`);
        lines.push(`  ${resultsName}[index] = (${adjudicateReviewDecisions.toString()})(${resultsName}[index], original, targets, history, ` +
          `${JSON.stringify({ dispatchId: reconsider.dispatchId, candidateSnapshotId: reconsider.candidateSnapshotId })});`);
        lines.push("}");
      }
      if (reviewEvidence?.controlled && stage > stages[0] && !reconsider) {
        lines.push(`for (let index = 0; index < ${resultsName}.length; index++) ${resultsName}[index] = (${validateReviewResult.toString()})(${resultsName}[index], reviewBoundary);`);
      }
      if (workflow.name === "matt-tdd" && reviewEvidence && stage > stages[0]) {
        lines.push(`for (const result of ${resultsName}) {`);
        if (reconsider || recovery) {
          lines.push(`  if (!${JSON.stringify(reconsider?.keys ?? recovery.keys)}.includes(result.key)) continue;`);
        }
        lines.push(`  result.artifactPaths = [...new Set([...(result.artifactPaths ?? []), ${JSON.stringify(reviewEvidence.path)}])];`);
        lines.push("}");
      }
      lines.push(publishResultsLine(`[...results, ...${resultsName}]`, stage));
      if (stage > stages[0] && execution.hostRevalidated?.length) {
        lines.push(`emit(${JSON.stringify({ type: "pi-x-matt.report-revalidated", version: 1,
          lanes: execution.hostRevalidated })});`);
      }
      lines.push(...validationLines(resultsName, stageLanes));
      if (stage === stages[0] && (approvedFindingIds.length || preReviewCommand)) {
        lines.push(...hostVerificationLines(resultsName, stageLanes, stage));
      }
      if (stage > stages[0] && reconsider) {
        lines.push(`emit({ type: "pi-x-matt.reconsideration-complete", version: 1, ` +
          `reviewPassed: ${resultsName}.every(result => result.structuredOutput.verdict === "PASS"), ` +
          `remainingFindingIds: ${resultsName}.flatMap(result => result.structuredOutput.findings.map(finding => ` +
          `canonicalFindingId(result.key, finding.id))) });`);
      }
      lines.push(`results.push(...${resultsName});`);
      if (execution.repairOnly) {
        lines.push(...captureEvidence());
        lines.push(`emit(${JSON.stringify({
          type: "pi-x-matt.review-pending", version: 1, workflow: workflow.name,
          reviewEvidencePath: reviewEvidence.path,
        })});`);
      }
    }
    lines.push("return results;");
    workflowScript = lines.join("\n");
  } else {
    const items = lanes.map(toRunItem);
    const committedEvidence = reviewEvidence?.committed ? [
      `const items = ${JSON.stringify(items)};`,
      `const reviewCapture = await runs.host("review-evidence", ${JSON.stringify({ kind: "command", command: reviewEvidence.command, timeoutMs: 120000 })});`,
      "if (reviewCapture?.ok === false) {",
      "  throw new Error('Committed review evidence collection failed: ' + (reviewCapture.stderr || reviewCapture.error || 'unknown'));",
      "}",
      "const reviewCaptured = JSON.parse(reviewCapture.stdout);",
      `if (reviewCaptured?.path !== ${JSON.stringify(reviewEvidence.path)} ||` +
        ` reviewCaptured.fixedPoint !== ${JSON.stringify(reviewEvidence.fixedPoint)} ||` +
        ` reviewCaptured.head !== ${JSON.stringify(reviewEvidence.head)} ||` +
        " reviewCaptured.complete !== true) {",
      "  throw new Error('Committed review evidence is incomplete; reviewers were not launched.');",
      "}",
      `for (const item of items) item.task += ${JSON.stringify(`\n\nReview Evidence Pack（host 已按 committed F..H 采集；只读此文件；不得重新取证或读取工作树）：\n${reviewEvidence.path}\n`)};`,
      "const results = await runs.all(items);",
      `for (const result of results) result.artifactPaths = [...new Set([...(result.artifactPaths ?? []), ${JSON.stringify(reviewEvidence.path)}])];`,
    ] : [`const results = await runs.all(${JSON.stringify(items)});`];
    workflowScript = [
      ...(recovery ? [
        `const items = ${JSON.stringify(items)};`,
        ...(reviewEvidence ? [
          `for (const item of items) item.task += ${JSON.stringify(`\n\nOriginal pinned committed Evidence Pack (reuse; do not recollect):\n${reviewEvidence.path}\n`)};`,
        ] : []),
        `const fresh = await runs.all(items.filter(item => ${JSON.stringify(recovery.keys)}.includes(item.key)));`,
        `const results = ${JSON.stringify(recovery.results)};`,
        "for (let index = 0; index < results.length; index++) {",
        "  const replacement = fresh.find(result => result.key === results[index].key);",
        "  if (replacement) results[index] = { ...replacement, recoveryHistory: [...(results[index].recoveryHistory ?? []), results[index]] };",
        "}",
      ] : committedEvidence),
      publishResultsLine("results"),
      ...(!recovery ? settlementRecoveryLines("results", lanes) : []),
      ...(workflow.name === "matt-code-review" ? [
        `for (let index = 0; index < results.length; index++) results[index] = (${withSpecEvidenceHint.toString()})(results[index]);`,
        ...(reviewEvidence ? [
          `for (const result of results) result.artifactPaths = [...new Set([...(result.artifactPaths ?? []), ${JSON.stringify(reviewEvidence.path)}])];`,
        ] : []),
      ] : []),
      publishResultsLine("results"),
      ...validationLines("results", lanes),
      "return results;",
    ].join("\n");
  }

  return {
    lanes: runLanes.filter(lane => recovery ? recovery.keys.includes(lane.key) : execution.repairOnly ? lane.key === "implement"
      : reconsider ? reconsider.keys.includes(lane.key) : !reviewOnly || lane.key !== "implement"),
    ...(reviewEvidence ? {
      hostCommands: recovery || reviewOnly || reconsider ? [] : [
        ...(reviewEvidence.claimCommand ? [{ key: "implement-claim", command: reviewEvidence.claimCommand }] : []),
        ...(preReviewCommand ? ["pre-review", "pre-review-recheck"].map(key => ({ key, command: preReviewCommand })) : []),
        { key: "review-evidence", command: reviewEvidence.command },
      ],
      reviewEvidencePath: reviewEvidence.path,
    } : {}),
    rpcParams: {
      script: workflowScript,
      cwd: targetProjectRoot,
      async: true,
      mission: false,
    },
  };
}
