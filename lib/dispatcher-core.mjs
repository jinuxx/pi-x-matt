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

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
export function prepareDispatchRequest(registry, workflow, task, targetProjectRoot, laneTasks = {}) {
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
    const missingLaneTasks = [...laneKeys].filter((key) => !Object.hasOwn(laneTasks, key));
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
      "  const needsSettlement = !failedResult?.structuredOutput && (failedResult?.timedOut === true || failedResult?.terminalOutcome === 'timeout' || failedError.startsWith('Subagent timed out'));",
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
      "      : result.timedOut",
      "        ? 'Subagent timed out.'",
      "        : result.turnBudgetExceeded",
      "          ? 'Subagent exceeded its turn budget.'",
      "          : result.stopped",
      "            ? 'Subagent stopped before completion.'",
      "            : result.processSignal",
      "              ? 'Subagent terminated with process signal ' + result.processSignal + '.'",
      "              : typeof result.exitCode === 'number' && result.exitCode !== 0",
      "                ? 'Subagent exited with code ' + result.exitCode + '.'",
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
          lines.push("  const { status, cycles, changedFiles, commands } = results[priorIndex].structuredOutput;");
          lines.push(`  ${evidenceName}.push({ key: results[priorIndex].key, structuredOutput: { status, cycles, changedFiles, commands } });`);
        } else {
          lines.push(`  ${evidenceName}.push({ key: results[priorIndex].key, structuredOutput: results[priorIndex].structuredOutput });`);
        }
        lines.push("}");
        lines.push(`for (let itemIndex = 0; itemIndex < ${itemsName}.length; itemIndex++) {`);
        lines.push(`  ${itemsName}[itemIndex].task += ${JSON.stringify(workflow.name === "matt-tdd" ? "\n\n前序阶段结构化结果（worker-reported 过程记录；真实变更以 Review Evidence Pack 为准）：\n" : "\n\n前序阶段结构化结果（仅作证据，仍需核验真实工作区）：\n")} + JSON.stringify(${evidenceName});`);
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
      if (reviewEvidence?.controlled && stage > stages[0] && !reconsider) {
        lines.push(`for (let index = 0; index < ${resultsName}.length; index++) ${resultsName}[index] = (${validateReviewResult.toString()})(${resultsName}[index], reviewBoundary);`);
      }
      if (stage > stages[0]) {
        lines.push(`for (let index = 0; index < ${resultsName}.length; index++) ${resultsName}[index] = withSpecEvidenceHint(${resultsName}[index]);`);
      }
      lines.push(publishResultsLine(`[...results, ...${resultsName}]`, stage));
      if (!recovery && !reconsider?.recovery && !(reviewOnly && stage === stages[0])) {
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
      ...committedEvidence,
      publishResultsLine("results"),
      ...settlementRecoveryLines("results", lanes),
      ...(workflow.name === "matt-code-review" ? [
        `for (let index = 0; index < results.length; index++) results[index] = (${withSpecEvidenceHint.toString()})(results[index]);`,
      ] : []),
      publishResultsLine("results"),
      ...validationLines("results", lanes),
      "return results;",
    ].join("\n");
  }

  return {
    lanes: runLanes.filter(lane => execution.repairOnly ? lane.key === "implement"
      : reconsider ? reconsider.keys.includes(lane.key) : !reviewOnly || lane.key !== "implement"),
    ...(reviewEvidence ? {
      hostCommands: recovery || reviewOnly || reconsider ? [] : [
        ...(reviewEvidence.claimCommand ? [{ key: "implement-claim", command: reviewEvidence.claimCommand }] : []),
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
