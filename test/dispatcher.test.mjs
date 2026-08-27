import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildDispatchRequest,
  findProjectRoot,
  loadCurrentRegistry,
  resolveProjectPath,
} from "../lib/dispatcher-core.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function withTempDispatcherProject(run) {
  const temp = await mkdtemp(join(tmpdir(), "pi-x-matt-dispatcher-"));
  try {
    for (const source of [".pi/agents", ".pi/skills", "skillpacks", "vendor", "config"]) {
      await cp(join(ROOT, source), join(temp, source), { recursive: true });
    }
    await cp(join(ROOT, ".pi", "settings.json"), join(temp, ".pi", "settings.json"));
    await run(temp);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

function parseWorkflowItems(workflowScript) {
  const firstLine = workflowScript.split("\n", 1)[0];
  const prefix = "const results = await runs.all(";
  assert.ok(firstLine.startsWith(prefix));
  assert.ok(firstLine.endsWith(");"));
  return JSON.parse(firstLine.slice(prefix.length, -2));
}

function parsePipelineStages(workflowScript) {
  return [...workflowScript.matchAll(/^const stage\d+Items = (\[.*\]);$/gm)]
    .map((match) => JSON.parse(match[1]));
}

function completeWorkerOutput() {
  return {
    status: "COMPLETE",
    summary: "done",
    confirmedSeams: [{ name: "module", interface: "public", behaviors: ["works"] }],
    cycles: [{ test: "works", redEvidence: "failed first", greenEvidence: "passed next", files: ["file.mjs"] }],
    changedFiles: ["file.mjs"],
    commands: [
      { command: "test red", outcome: "failed as expected" },
      { command: "test green", outcome: "passed" },
    ],
    residualRisks: [],
  };
}

test("dispatcher builds one guarded fresh child for research", async () => {
  const registry = await loadCurrentRegistry(ROOT);
  const workflow = registry.skills.research;
  const plan = buildDispatchRequest(registry, workflow, "调查一个明确问题", ROOT);
  const items = parseWorkflowItems(plan.rpcParams.workflowScript);

  assert.equal(plan.lanes.length, 1);
  assert.equal(items.length, 1);
  assert.equal(items[0].key, "research");
  assert.equal(items[0].agent, "researcher");
  assert.equal(items[0].context, "fresh");
  assert.deepEqual(items[0].skill, ["research-executor"]);
  assert.equal(items[0].output, false);
  assert.deepEqual(items[0].turnBudget, { maxTurns: 8, graceTurns: 2 });
  assert.equal(items[0].outputSchema.type, "object");
  assert.match(plan.rpcParams.workflowScript, /completed without valid structuredOutput/);
  assert.deepEqual(
    { async: plan.rpcParams.async, mission: plan.rpcParams.mission, cwd: plan.rpcParams.cwd },
    { async: true, mission: false, cwd: ROOT },
  );
});

test("dispatcher builds one guarded prototype writer with private branch skills", async () => {
  const registry = await loadCurrentRegistry(ROOT);
  const workflow = registry.skills.prototype;
  const plan = buildDispatchRequest(registry, workflow, "构建一个已确认问题的 logic prototype", ROOT);
  const items = parseWorkflowItems(plan.rpcParams.workflowScript);

  assert.equal(plan.lanes.length, 1);
  assert.deepEqual(plan.lanes[0].skills, ["prototype-logic", "prototype-ui", "prototype-executor"]);
  assert.deepEqual(
    items.map(({ key, agent, context, skill, output }) => ({ key, agent, context, skill, output })),
    [{
      key: "prototype",
      agent: "worker",
      context: "fresh",
      skill: ["prototype-logic", "prototype-ui", "prototype-executor"],
      output: false,
    }],
  );
  assert.deepEqual(plan.lanes[0].gate, {
    field: "status",
    equals: "BUILT",
    nonEmpty: ["artifactPaths", "runInstructions", "reviewTargets", "changedFiles", "commands", "cleanupPlan"],
  });
  assert.match(plan.rpcParams.workflowScript, /prototype\.status/);
  assert.match(plan.rpcParams.workflowScript, /completed without valid structuredOutput/);
});

test("dispatcher builds a temp-only architecture scan writer", async () => {
  const registry = await loadCurrentRegistry(ROOT);
  const plan = buildDispatchRequest(registry, registry.skills["architecture-scan"], "扫描固定 scope", ROOT);
  const items = parseWorkflowItems(plan.rpcParams.workflowScript);

  assert.deepEqual(plan.lanes.map(({ key, agent, skills }) => ({ key, agent, skills })), [{
    key: "scan",
    agent: "worker",
    skills: ["codebase-design", "architecture-html-report", "architecture-scan-executor"],
  }]);
  assert.deepEqual(items[0].skill, ["codebase-design", "architecture-html-report", "architecture-scan-executor"]);
  assert.equal(items[0].output, false);
  assert.deepEqual(plan.lanes[0].gate, {
    field: "status",
    equals: "REPORTED",
    nonEmpty: ["scopeEvidence", "commands"],
  });
  assert.match(plan.rpcParams.workflowScript, /scan\.status/);
});

test("dispatcher builds three guarded read-only architecture design lanes", async () => {
  const registry = await loadCurrentRegistry(ROOT);
  const plan = buildDispatchRequest(registry, registry.skills["architecture-design"], "为固定 candidate 设计 interfaces", ROOT);
  const items = parseWorkflowItems(plan.rpcParams.workflowScript);
  const closure = ["architecture-vocabulary-reader", "architecture-deepening-reader", "architecture-interface-design"];

  assert.deepEqual(plan.lanes.map(({ key, agent, skills }) => ({ key, agent, skills })), [
    { key: "minimal", agent: "reader", skills: closure },
    { key: "flexible", agent: "reader", skills: closure },
    { key: "common-caller", agent: "reader", skills: closure },
  ]);
  assert.deepEqual(items.map((item) => item.context), ["fresh", "fresh", "fresh"]);
  assert.ok(items.every((item) => item.agent === "reader" && item.output === false));
  assert.deepEqual(items.map((item) => item.outputSchema.properties.strategy.enum[0]), ["minimal", "flexible", "common-caller"]);
  assert.match(plan.rpcParams.workflowScript, /minimal\.status/);
  assert.match(plan.rpcParams.workflowScript, /flexible\.status/);
  assert.match(plan.rpcParams.workflowScript, /common-caller\.status/);
});

test("dispatcher builds two independent guarded review lanes", async () => {
  const registry = await loadCurrentRegistry(ROOT);
  const workflow = registry.skills["code-review"];
  const plan = buildDispatchRequest(registry, workflow, "评审固定范围", ROOT);
  const items = parseWorkflowItems(plan.rpcParams.workflowScript);

  assert.deepEqual(items.map(({ key, agent, context, skill, output }) => ({ key, agent, context, skill, output })), [
    { key: "standards", agent: "reviewer", context: "fresh", skill: ["review-standards"], output: false },
    { key: "spec", agent: "reviewer", context: "fresh", skill: ["review-spec"], output: false },
  ]);
  assert.ok(items.every((item) => item.timeoutMs === 300000));
  assert.ok(items.every((item) => item.turnBudget.maxTurns === 12 && item.turnBudget.graceTurns === 2));
  assert.deepEqual(items.map((item) => item.outputSchema.properties.axis.enum[0]), ["standards", "spec"]);
  assert.deepEqual(plan.lanes.map((lane) => lane.gate), [
    { field: "verdict", equals: "PASS" },
    { field: "verdict", equals: "PASS" },
  ]);
  assert.match(plan.rpcParams.workflowScript, /standards\.verdict/);
  assert.match(plan.rpcParams.workflowScript, /spec\.verdict/);

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction("runs", plan.rpcParams.workflowScript);
  await assert.rejects(
    () => execute({ all: async (lanes) => lanes.map((lane) => ({
      key: lane.key,
      structuredOutput: { axis: lane.key, verdict: lane.key === "standards" ? "FAIL" : "PASS" },
    })) }),
    /standards\.verdict/,
  );
});

test("dispatcher builds a gated worker-to-reviewer TDD pipeline", async () => {
  const registry = await loadCurrentRegistry(ROOT);
  const plan = buildDispatchRequest(registry, registry.skills.tdd, "已确认 seams 的实现任务", ROOT);
  const stages = parsePipelineStages(plan.rpcParams.workflowScript);

  assert.deepEqual(plan.lanes.map(({ key, stage, agent, skills }) => ({ key, stage, agent, skills })), [
    { key: "implement", stage: 1, agent: "worker", skills: ["codebase-design", "tdd-executor"] },
    { key: "standards", stage: 2, agent: "reviewer", skills: ["review-standards"] },
    { key: "spec", stage: 2, agent: "reviewer", skills: ["review-spec"] },
  ]);
  assert.equal(stages.length, 2);
  assert.deepEqual(stages[0].map(({ key, agent, context, skill, output }) => ({ key, agent, context, skill, output })), [
    { key: "implement", agent: "worker", context: "fresh", skill: ["codebase-design", "tdd-executor"], output: false },
  ]);
  assert.deepEqual(stages[1].map(({ key, agent, context, skill, output }) => ({ key, agent, context, skill, output })), [
    { key: "standards", agent: "reviewer", context: "fresh", skill: ["review-standards"], output: false },
    { key: "spec", agent: "reviewer", context: "fresh", skill: ["review-spec"], output: false },
  ]);
  assert.match(plan.rpcParams.workflowScript, /Workflow gate 'implement\.status' did not equal 'COMPLETE'/);
  assert.match(plan.rpcParams.workflowScript, /Workflow gate 'standards\.verdict' did not equal 'PASS'/);
  assert.match(plan.rpcParams.workflowScript, /前序阶段结构化结果/);

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction("runs", plan.rpcParams.workflowScript);
  let calls = 0;
  await assert.rejects(
    () => execute({ all: async () => {
      calls += 1;
      return [{ key: "implement", structuredOutput: { status: "BLOCKED" } }];
    } }),
    /implement\.status/,
  );
  assert.equal(calls, 1, "review stage must not launch after a blocked implementation");

  calls = 0;
  await assert.rejects(
    () => execute({ all: async () => {
      calls += 1;
      return [{
        key: "implement",
        structuredOutput: {
          status: "COMPLETE",
          summary: "",
          confirmedSeams: [],
          cycles: [],
          changedFiles: [],
          commands: [],
          residualRisks: [],
        },
      }];
    } }),
    /requires non-empty 'confirmedSeams'/,
  );
  assert.equal(calls, 1, "review stage must not launch without TDD evidence");

  calls = 0;
  const results = await execute({ all: async (items) => {
    calls += 1;
    if (calls === 2) {
      assert.ok(items.every((item) => item.task.includes("前序阶段结构化结果")));
      assert.ok(items.every((item) => item.task.includes('"status":"COMPLETE"')));
    }
    return items.map((item) => ({
      key: item.key,
      structuredOutput: item.key === "implement" ? completeWorkerOutput() : { axis: item.key, verdict: "PASS" },
    }));
  } });
  assert.equal(calls, 2);
  assert.deepEqual(results.map((result) => result.key), ["implement", "standards", "spec"]);

  calls = 0;
  await assert.rejects(
    () => execute({ all: async (items) => {
      calls += 1;
      return items.map((item) => ({
        key: item.key,
        structuredOutput: item.key === "implement"
          ? completeWorkerOutput()
          : { axis: item.key, verdict: item.key === "standards" ? "FAIL" : "PASS" },
      }));
    } }),
    /standards\.verdict/,
  );
  assert.equal(calls, 2);

  calls = 0;
  await assert.rejects(
    () => execute({ all: async (items) => {
      calls += 1;
      if (calls === 1) return [{ key: "implement", structuredOutput: completeWorkerOutput() }];
      return [{ key: items[0].key, structuredOutput: { axis: items[0].key, verdict: "PASS" } }];
    } }),
    /expected 2 lane result/,
  );
  assert.equal(calls, 2);
});

test("dispatcher workflow guard rejects missing structured output", async () => {
  const registry = await loadCurrentRegistry(ROOT);
  const plan = buildDispatchRequest(registry, registry.skills.research, "research", ROOT);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction("runs", plan.rpcParams.workflowScript);

  await assert.rejects(
    () => execute({ all: async () => [] }),
    /expected 1 lane result/,
  );
  await assert.rejects(
    () => execute({ all: async () => [{ key: "research", ok: true, output: "prose only" }] }),
    /completed without valid structuredOutput/,
  );
  const structuredOutput = { question: "q" };
  const result = await execute({ all: async () => [{ key: "research", ok: true, structuredOutput }] });
  assert.deepEqual(result[0].structuredOutput, structuredOutput);
});

test("dispatcher fails closed on malformed lanes and cross-agent grants", async () => {
  const registry = await loadCurrentRegistry(ROOT);
  const duplicate = structuredClone(registry.skills["code-review"]);
  duplicate.workflow.lanes[1].key = duplicate.workflow.lanes[0].key;
  assert.throws(() => buildDispatchRequest(registry, duplicate, "review", ROOT), /duplicate lane/);

  const crossAgentRegistry = structuredClone(registry);
  crossAgentRegistry.skills["review-spec"].agent = "worker";
  assert.throws(
    () => buildDispatchRequest(crossAgentRegistry, crossAgentRegistry.skills["code-review"], "review", ROOT),
    /cannot grant 'review-spec' to agent 'reviewer'/,
  );
});

test("dispatcher rejects interaction parents", async () => {
  const registry = await loadCurrentRegistry(ROOT);
  const interaction = registry.skills["grill-with-docs"];
  assert.throws(
    () => buildDispatchRequest(registry, interaction, "不要委派 HITL 访谈", ROOT),
    /not a parent orchestration workflow/,
  );
});

test("dispatcher validates runtime gate shape for every workflow mode", async () => {
  const registry = await loadCurrentRegistry(ROOT);
  const invalid = structuredClone(registry.skills["code-review"]);
  invalid.workflow.lanes[0].gate.equals = "NOT_DECLARED";
  assert.throws(
    () => buildDispatchRequest(registry, invalid, "review", ROOT),
    /lane 'standards' has invalid gate/,
  );
});

test("dispatcher finds the nearest project root and fails without one", async () => {
  await withTempDispatcherProject(async (temp) => {
    const nested = join(temp, "nested", "child");
    await mkdir(nested, { recursive: true });
    assert.equal(await findProjectRoot(nested), temp);
  });

  const empty = await mkdtemp(join(tmpdir(), "pi-x-matt-no-root-"));
  try {
    await assert.rejects(() => findProjectRoot(empty), /requires a project \.pi\/settings\.json/);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test("dispatcher registry paths cannot escape the project root", () => {
  assert.throws(() => resolveProjectPath(ROOT, "../outside", "Source path"), /inside the project root/);
  assert.throws(() => resolveProjectPath(ROOT, "/tmp/outside", "Source path"), /project-relative/);
  assert.equal(resolveProjectPath(ROOT, "config/skill-registry.json"), resolve(ROOT, "config/skill-registry.json"));
});

test("dispatcher rejects malformed interaction and unsupported parent routing", async () => {
  await withTempDispatcherProject(async (temp) => {
    const registryPath = join(temp, "config", "skill-registry.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8"));
    registry.skills.grilling.dispatch = "parallel";
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    await assert.rejects(() => loadCurrentRegistry(temp), /invalid interaction routing for 'grilling'/);
  });

  await withTempDispatcherProject(async (temp) => {
    const registryPath = join(temp, "config", "skill-registry.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8"));
    registry.skills.grilling.class = "unsupported";
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    await assert.rejects(() => loadCurrentRegistry(temp), /unsupported parent class for 'grilling'/);
  });
});

test("dispatcher rejects a tampered generated registry", async () => {
  await withTempDispatcherProject(async (temp) => {
    const registryPath = join(temp, "config", "skill-registry.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8"));
    registry.skills.research.workflow.lanes[0].timeoutMs = 1;
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

    await assert.rejects(() => loadCurrentRegistry(temp), /not the current generated registry/);
  });
});
