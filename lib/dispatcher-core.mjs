import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildRegistry, serializeRegistry } from "../scripts/generate-registry.mjs";

export const VERIFY_HOST_TIMEOUT_MS = 660_000;
const VERIFY_COMMAND_LIMIT = 8;
const VERIFY_COMMAND_BYTES = 500;

export function normalizeVerifyCommands(commands) {
  if (commands === undefined) return [];
  if (!Array.isArray(commands) || commands.length > VERIFY_COMMAND_LIMIT ||
      commands.some((command) => typeof command !== "string" || !command.trim() ||
        /[\0\r\n]/.test(command) || Buffer.byteLength(command) > VERIFY_COMMAND_BYTES)) {
    throw new Error(
      `verifyCommands must be at most ${VERIFY_COMMAND_LIMIT} single-line commands of at most ${VERIFY_COMMAND_BYTES} bytes each`,
    );
  }
  return [...new Set(commands.map((command) => command.trim()))];
}

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
  if (!["single", "parallel", "pipeline"].includes(definition.mode)) {
    throw new Error(`Workflow '${workflow.name}' has unsupported mode '${definition.mode}'`);
  }
  if (definition.mode === "single" && definition.lanes.length !== 1) {
    throw new Error(`Workflow '${workflow.name}' single mode requires exactly one lane`);
  }
  if (definition.mode !== "single" && definition.lanes.length < 2) {
    throw new Error(`Workflow '${workflow.name}' ${definition.mode} mode requires at least two lanes`);
  }
  const keys = new Set();
  for (const lane of definition.lanes) {
    if (!isObject(lane) || typeof lane.key !== "string" || !lane.key || keys.has(lane.key)) {
      throw new Error(`Workflow '${workflow.name}' has an invalid or duplicate lane`);
    }
    keys.add(lane.key);
    if (!Number.isInteger(lane.timeoutMs) || lane.timeoutMs <= 0) {
      throw new Error(`Workflow '${workflow.name}' lane '${lane.key}' has invalid timeoutMs`);
    }
    if (!isObject(lane.outputSchema) || lane.outputSchema.type !== "object") {
      throw new Error(`Workflow '${workflow.name}' lane '${lane.key}' has invalid outputSchema`);
    }
  }
}

/** Validate caller input, resolve leaf skill closures, and filter optional lane subset. */
export function prepareDispatchRequest(registry, workflow, task, targetProjectRoot, { laneTasks = {}, lanes: selectedKeys } = {}) {
  if (workflow.scope !== "parent" || workflow.class !== "orchestration") {
    throw new Error(`'${workflow.name}' is not a parent orchestration workflow`);
  }
  if (typeof task !== "string" || !task.trim()) throw new Error("Dispatch task must not be empty");
  assertRuntimeWorkflow(workflow);
  if (!isObject(laneTasks)) throw new Error("Dispatch laneTasks must be an object");

  const validKeys = new Set(workflow.workflow.lanes.map((lane) => lane.key));
  for (const [key, laneTask] of Object.entries(laneTasks)) {
    if (!validKeys.has(key)) throw new Error(`Dispatch laneTasks has unknown lane '${key}'`);
    if (typeof laneTask !== "string" || !laneTask.trim()) {
      throw new Error(`Dispatch laneTasks.${key} must be a non-empty string`);
    }
  }

  let activeKeys = validKeys;
  if (selectedKeys !== undefined) {
    if (!Array.isArray(selectedKeys) || selectedKeys.length === 0) {
      throw new Error("Dispatch lanes must be a non-empty array of lane keys");
    }
    for (const key of selectedKeys) {
      if (!validKeys.has(key)) throw new Error(`Dispatch lanes has unknown lane '${key}'`);
    }
    activeKeys = new Set(selectedKeys);
  }

  const lanes = workflow.workflow.lanes
    .filter((lane) => activeKeys.has(lane.key))
    .map((lane) => {
      const leafSkills = resolveLeafClosure(registry, workflow.name, lane);
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

/** Build the pi-subagents workflow script and host command allowlist. */
export function buildDispatchRequest({ workflow, lanes, targetProjectRoot }, { resumeRunId, hostControls } = {}) {
  const laneLabel = (key) => `${workflow.name} / ${key}`;
  const toRunItem = (lane) => ({
    key: lane.key,
    label: laneLabel(lane.key),
    task: lane.task,
    timeoutMs: lane.timeoutMs,
    output: false,
    ...(lane.key === "implement" && resumeRunId
      ? { resume: resumeRunId }
      : { agent: lane.agent, context: "fresh", skill: lane.skills, outputSchema: lane.outputSchema }),
  });

  const settlementLines = (resultsName, stageLanes) => stageLanes.flatMap((lane, index) => {
    const recoveryKey = `${lane.key}-settlement`;
    const recoveryTask = [
      "结构化结果结算。不要继续实现、读取文件或运行命令。",
      "只使用当前会话中已有信息，立即调用 structured_output 返回符合原 schema 的结果（未完成可如实返回 BLOCKED/ISSUES/NO_EVIDENCE）。",
    ].join(" ");
    return [
      "{",
      `  const failedResult = ${resultsName}[${index}];`,
      "  const needsSettlement = !failedResult?.structuredOutput && failedResult?.terminalOutcome?.reason === 'timeout';",
      "  if (needsSettlement && failedResult?.runId && failedResult?.resumability?.state === 'resumable') {",
      "    try {",
      `      const settled = (await runs.all([{ key: ${JSON.stringify(recoveryKey)}, label: ${JSON.stringify(laneLabel(recoveryKey))}, resume: failedResult.runId, task: ${JSON.stringify(recoveryTask)}, timeoutMs: 300000 }]))[0];`,
      `      ${resultsName}[${index}] = { ...(settled ?? failedResult), key: ${JSON.stringify(lane.key)}, recoveryHistory: [...(failedResult.recoveryHistory ?? []), failedResult] };`,
      "    } catch (error) {",
      `      ${resultsName}[${index}] = { ...failedResult, ok: false, error: (failedResult.error ?? 'timeout') + '; settlement failed: ' + String(error), recoveryHistory: [...(failedResult.recoveryHistory ?? []), failedResult] };`,
      "    }",
      "  }",
      "}",
    ];
  });

  const publishResultsLine = (expr, stage = 1) =>
    `emit({ type: "pi-x-matt.stage-results", version: 1, workflow: ${JSON.stringify(workflow.name)}, stage: ${stage}, results: ${expr} });`;

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
      "    const reason = typeof result.error === 'string' && result.error.trim()",
      "      ? result.error.trim()",
      "      : result.terminalOutcome?.reason || (result.stopped ? 'stopped' : result.interrupted ? 'interrupted' : 'missing structuredOutput');",
      `    throw new Error('Workflow lane ' + ${JSON.stringify(laneKeys)}[index] + ' failed: ' + reason);`,
      "  }",
      "  if (result.ok !== true) {",
      `    throw new Error('Workflow lane ' + ${JSON.stringify(laneKeys)}[index] + ' failed: ' + (result.error || 'subagent failed'));`,
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

  const hostCommands = [];
  const lines = [];

  if (workflow.workflow.mode === "pipeline") {
    lines.push("const results = [];");
    const stages = [...new Set(lanes.map((lane) => lane.stage))].sort((a, b) => a - b);
    for (const stage of stages) {
      const stageLanes = lanes.filter((lane) => lane.stage === stage);
      const itemsName = `stage${stage}Items`;
      const resultsName = `stage${stage}Results`;
      lines.push(`const ${itemsName} = ${JSON.stringify(stageLanes.map(toRunItem))};`);
      if (stage > stages[0]) {
        lines.push(`for (const item of ${itemsName}) item.task += "\\n\\n前序阶段结构化结果：\\n" + JSON.stringify(results.map((r) => ({ key: r.key, structuredOutput: r.structuredOutput })));`);
      }
      lines.push(`const ${resultsName} = await runs.all(${itemsName});`);
      lines.push(...settlementLines(resultsName, stageLanes));
      lines.push(publishResultsLine(`[...results, ...${resultsName}]`, stage));
      lines.push(...validationLines(resultsName, stageLanes));
      lines.push(`results.push(...${resultsName});`);
    }
    lines.push("return results;");
  } else {
    if (hostControls?.claimCommand) {
      hostCommands.push({ key: "implement-claim", command: hostControls.claimCommand });
      lines.push(`await runs.host("implement-claim", ${JSON.stringify({ kind: "command", command: hostControls.claimCommand, timeoutMs: 10_000 })});`);
    }
    lines.push(`const items = ${JSON.stringify(lanes.map(toRunItem))};`);
    if (hostControls?.evidenceCommand) {
      hostCommands.push({ key: "review-evidence", command: hostControls.evidenceCommand });
      lines.push(`const evidenceRun = await runs.host("review-evidence", ${JSON.stringify({ kind: "command", command: hostControls.evidenceCommand, timeoutMs: 120_000 })});`);
      lines.push("if (evidenceRun?.ok === false) throw new Error('Review evidence collection failed: ' + (evidenceRun.stderr || evidenceRun.error || 'unknown'));");
      lines.push("const evidence = JSON.parse(evidenceRun.stdout);");
      lines.push("emit({ type: 'pi-x-matt.review-evidence', version: 1, evidence });");
      const packHint = hostControls.evidenceKind === "committed"
        ? "\n\nReview Evidence Pack（已提交范围 F..H，先读取此文件，无需重复 Git 取证）：\n"
        : "\n\nReview Evidence Pack（当前工作区变更，先读取此文件，无需重复 Git 取证）：\n";
      lines.push(`for (const item of items) item.task += ${JSON.stringify(packHint)} + evidence.path;`);
    }
    lines.push("const results = await runs.all(items);");
    lines.push(...settlementLines("results", lanes));
    if (hostControls?.evidenceCommand) {
      lines.push("for (const result of results) result.artifactPaths = [...new Set([...(result.artifactPaths ?? []), evidence.path])];");
    }
    if (hostControls?.verifyCommand) {
      hostCommands.push({ key: "verify", command: hostControls.verifyCommand });
      lines.push("if (results[0]?.ok === true && results[0]?.structuredOutput?.status === 'COMPLETE') {");
      lines.push("  try {");
      lines.push(`    const verifyRun = await runs.host("verify", ${JSON.stringify({ kind: "command", command: hostControls.verifyCommand, timeoutMs: VERIFY_HOST_TIMEOUT_MS })});`);
      lines.push("    if (verifyRun?.ok === false) throw new Error(verifyRun.stderr || verifyRun.error || 'verify runner failed');");
      lines.push("    results[0].hostVerification = JSON.parse(verifyRun.stdout);");
      lines.push("  } catch (error) {");
      lines.push("    results[0].hostVerification = { ok: false, error: String(error?.message ?? error), results: [] };");
      lines.push("  }");
      lines.push("}");
    }
    lines.push(publishResultsLine("results", 1));
    lines.push(...validationLines("results", lanes));
    lines.push("return results;");
  }

  return {
    lanes,
    hostCommands,
    ...(hostControls?.evidencePath ? { reviewEvidencePath: hostControls.evidencePath } : {}),
    rpcParams: {
      script: lines.join("\n"),
      cwd: targetProjectRoot,
      async: true,
      mission: false,
    },
  };
}
