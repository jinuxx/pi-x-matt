import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildRegistry, serializeRegistry } from "../scripts/generate-registry.mjs";
import { validateReviewResult } from "./review-contract.mjs";

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
export function buildDispatchRequest({ workflow, lanes, targetProjectRoot }, reviewEvidence, recovery) {
  const toRunItem = (lane) => ({
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
      ...stageLanes.flatMap((lane, index) => lane.gate ? [
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
    const stages = [...new Set(lanes.map((lane) => lane.stage))].sort((a, b) => a - b);
    const lines = ["const results = [];"];
    if (reviewEvidence?.claimCommand && !recovery) {
      lines.push(`await runs.host("implement-claim", ${JSON.stringify({ kind: "command", command: reviewEvidence.claimCommand, timeoutMs: 10000 })});`);
    }
    if (reviewEvidence?.controlled) lines.push(`let reviewBoundary = ${JSON.stringify(recovery?.boundary ?? null)};`);
    for (const stage of stages) {
      const stageLanes = lanes.filter((lane) => lane.stage === stage);
      const itemsName = `stage${stage}Items`;
      const resultsName = `stage${stage}Results`;
      lines.push(`const ${itemsName} = ${JSON.stringify(stageLanes.map(toRunItem))};`);
      if (stage > stages[0]) {
        const evidenceName = `stage${stage}PriorEvidence`;
        if (workflow.name === "matt-tdd" && reviewEvidence) {
          if (!recovery) {
            lines.push(`${reviewEvidence.controlled ? "const capture = " : ""}await runs.host("review-evidence", ${JSON.stringify({ kind: "command", command: reviewEvidence.command, timeoutMs: 120000 })});`);
            if (reviewEvidence.controlled) lines.push("reviewBoundary = JSON.parse(capture.stdout).boundary;");
          }
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
      if (recovery && stage === stages[0]) {
        lines.push(`const ${resultsName} = ${JSON.stringify(recovery.results.filter(result => stageLanes.some(lane => lane.key === result.key)))};`);
      } else if (recovery) {
        lines.push(`const ${resultsName}Fresh = await runs.all(${itemsName}.filter(item => ${JSON.stringify(recovery.keys)}.includes(item.key)));`);
        lines.push(`const ${resultsName} = ${JSON.stringify(stageLanes.map(lane => recovery.results.find(result => result.key === lane.key) ?? { key: lane.key }))};`);
        lines.push(`for (let index = 0; index < ${resultsName}.length; index++) {`);
        lines.push(`  const fresh = ${resultsName}Fresh.find(result => result.key === ${resultsName}[index].key);`);
        lines.push(`  if (fresh) ${resultsName}[index] = { ...fresh, recoveryHistory: [${resultsName}[index]] };`);
        lines.push("}");
      } else {
        lines.push(`const ${resultsName} = await runs.all(${itemsName});`);
      }
      if (reviewEvidence?.controlled && stage > stages[0]) {
        lines.push(`for (let index = 0; index < ${resultsName}.length; index++) ${resultsName}[index] = (${validateReviewResult.toString()})(${resultsName}[index], reviewBoundary);`);
      }
      lines.push(publishResultsLine(`[...results, ...${resultsName}]`, stage));
      if (!recovery) lines.push(...settlementRecoveryLines(resultsName, stageLanes));
      if (reviewEvidence?.controlled && stage > stages[0]) {
        lines.push(`for (let index = 0; index < ${resultsName}.length; index++) ${resultsName}[index] = (${validateReviewResult.toString()})(${resultsName}[index], reviewBoundary);`);
      }
      if (workflow.name === "matt-tdd" && reviewEvidence && stage > stages[0]) {
        lines.push(`for (const result of ${resultsName}) result.artifactPaths = [...(result.artifactPaths ?? []), ${JSON.stringify(reviewEvidence.path)}];`);
      }
      lines.push(publishResultsLine(`[...results, ...${resultsName}]`, stage));
      lines.push(...validationLines(resultsName, stageLanes));
      lines.push(`results.push(...${resultsName});`);
    }
    lines.push("return results;");
    workflowScript = lines.join("\n");
  } else {
    const items = lanes.map(toRunItem);
    workflowScript = [
      `const results = await runs.all(${JSON.stringify(items)});`,
      publishResultsLine("results"),
      ...settlementRecoveryLines("results", lanes),
      publishResultsLine("results"),
      ...validationLines("results", lanes),
      "return results;",
    ].join("\n");
  }

  return {
    lanes,
    ...(reviewEvidence ? {
      hostCommands: recovery ? [] : [
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
