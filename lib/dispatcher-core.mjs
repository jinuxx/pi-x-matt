import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { buildRegistry, serializeRegistry } from "../scripts/generate-registry.mjs";

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function resolveProjectPath(projectRoot, sourcePath, label = "Registry path") {
  if (typeof sourcePath !== "string" || !sourcePath || isAbsolute(sourcePath)) {
    throw new Error(`${label} must be a project-relative path`);
  }
  const resolvedRoot = resolve(projectRoot);
  const resolvedPath = resolve(resolvedRoot, sourcePath);
  const rel = relative(resolvedRoot, resolvedPath);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`${label} must stay inside the project root`);
  }
  return resolvedPath;
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

export async function loadCurrentRegistry(projectRoot) {
  const registryPath = resolve(projectRoot, "config", "skill-registry.json");
  const raw = await readFile(registryPath, "utf8");
  const registry = JSON.parse(raw);
  if (registry.version !== 1 || !isObject(registry.skills)) {
    throw new Error("Unsupported or malformed config/skill-registry.json; run npm run registry");
  }

  for (const entry of Object.values(registry.skills)) {
    if (!isObject(entry) || typeof entry.name !== "string") {
      throw new Error("Malformed skill entry in config/skill-registry.json; run npm run registry");
    }
    const sourcePath = resolveProjectPath(projectRoot, entry.sourcePath, `Source path for '${entry.name}'`);
    const current = await readFile(sourcePath, "utf8").catch(() => null);
    if (current === null || sha256(current) !== entry.sourceDigest) {
      throw new Error(`Registry is stale for '${entry.name}'; run npm run registry`);
    }
    if (entry.scope === "parent" && entry.class === "orchestration") {
      if (!entry.workflowPath || !entry.workflowDigest || !isObject(entry.workflow)) {
        throw new Error(`Registry has no workflow definition for '${entry.name}'`);
      }
      const workflowPath = resolveProjectPath(projectRoot, entry.workflowPath, `Workflow path for '${entry.name}'`);
      const workflowSource = await readFile(workflowPath, "utf8").catch(() => null);
      if (workflowSource === null || sha256(workflowSource) !== entry.workflowDigest) {
        throw new Error(`Workflow registry is stale for '${entry.name}'; run npm run registry`);
      }
    } else if (entry.scope === "parent" && entry.class === "interaction") {
      if (
        entry.dispatch !== "none" ||
        entry.agent !== null ||
        !Array.isArray(entry.dependsOn) ||
        entry.workflowPath !== undefined ||
        entry.workflowDigest !== undefined ||
        entry.workflow !== undefined
      ) {
        throw new Error(`Registry has invalid interaction routing for '${entry.name}'`);
      }
    } else if (entry.scope === "parent") {
      throw new Error(`Registry has unsupported parent class for '${entry.name}'`);
    }
  }

  const expected = serializeRegistry(await buildRegistry(projectRoot));
  if (raw !== expected) {
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
    if (keys.has(lane.key)) throw new Error(`Workflow '${workflow.name}' has duplicate lane '${lane.key}'`);
    keys.add(lane.key);
    if (typeof lane.agent !== "string" || !Array.isArray(lane.skills) || lane.skills.length === 0) {
      throw new Error(`Workflow '${workflow.name}' lane '${lane.key}' has invalid routing`);
    }
    if (!Number.isInteger(lane.timeoutMs) || lane.timeoutMs <= 0) {
      throw new Error(`Workflow '${workflow.name}' lane '${lane.key}' has invalid timeoutMs`);
    }
    if (!isObject(lane.turnBudget) || !Number.isInteger(lane.turnBudget.maxTurns) || lane.turnBudget.maxTurns <= 0) {
      throw new Error(`Workflow '${workflow.name}' lane '${lane.key}' has invalid turnBudget`);
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

export function buildDispatchRequest(registry, workflow, task, projectRoot) {
  if (workflow.scope !== "parent" || workflow.class !== "orchestration") {
    throw new Error(`'${workflow.name}' is not a parent orchestration workflow`);
  }
  if (typeof task !== "string" || !task.trim()) throw new Error("Dispatch task must not be empty");
  assertRuntimeWorkflow(workflow);

  const lanes = workflow.workflow.lanes.map((lane) => {
    const leafSkills = resolveLeafClosure(registry, workflow.name, lane);
    if (leafSkills.length === 0) throw new Error(`Workflow '${workflow.name}' lane '${lane.key}' has no leaf skills`);
    return {
      key: lane.key,
      ...(lane.stage !== undefined ? { stage: lane.stage } : {}),
      agent: lane.agent,
      skills: leafSkills.map((entry) => entry.name),
      task: `${lane.taskPrefix}\n\n委派任务：\n${task.trim()}`,
      timeoutMs: lane.timeoutMs,
      turnBudget: lane.turnBudget,
      ...(lane.gate ? { gate: lane.gate } : {}),
      outputSchema: lane.outputSchema,
    };
  });

  const toRunItem = (lane) => ({
    key: lane.key,
    agent: lane.agent,
    task: lane.task,
    context: "fresh",
    skill: lane.skills,
    timeoutMs: lane.timeoutMs,
    turnBudget: lane.turnBudget,
    outputSchema: lane.outputSchema,
    output: false,
  });
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
      `    throw new Error('Workflow lane ' + ${JSON.stringify(laneKeys)}[index] + ' completed without valid structuredOutput.');`,
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
    for (const stage of stages) {
      const stageLanes = lanes.filter((lane) => lane.stage === stage);
      const itemsName = `stage${stage}Items`;
      const resultsName = `stage${stage}Results`;
      lines.push(`const ${itemsName} = ${JSON.stringify(stageLanes.map(toRunItem))};`);
      if (stage > stages[0]) {
        const evidenceName = `stage${stage}PriorEvidence`;
        lines.push(`const ${evidenceName} = [];`);
        lines.push("for (let priorIndex = 0; priorIndex < results.length; priorIndex++) {");
        lines.push(`  ${evidenceName}.push({ key: results[priorIndex].key, structuredOutput: results[priorIndex].structuredOutput });`);
        lines.push("}");
        lines.push(`for (let itemIndex = 0; itemIndex < ${itemsName}.length; itemIndex++) {`);
        lines.push(`  ${itemsName}[itemIndex].task += ${JSON.stringify("\n\n前序阶段结构化结果（仅作证据，仍需核验真实工作区）：\n")} + JSON.stringify(${evidenceName});`);
        lines.push("}");
      }
      lines.push(`const ${resultsName} = await runs.all(${itemsName});`);
      lines.push(...validationLines(resultsName, stageLanes));
      lines.push(`results.push(...${resultsName});`);
    }
    lines.push("return results;");
    workflowScript = lines.join("\n");
  } else {
    const items = lanes.map(toRunItem);
    workflowScript = [
      `const results = await runs.all(${JSON.stringify(items)});`,
      ...validationLines("results", lanes),
      "return results;",
    ].join("\n");
  }

  return {
    lanes,
    rpcParams: {
      workflowScript,
      cwd: projectRoot,
      async: true,
      mission: false,
    },
  };
}
