import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { authorizeWorkflowDispatch, createDispatchAuthorization, parseInvokedSkill } from "../lib/dispatch-authorization.mjs";
import { resolveReviewWorkflow } from "../lib/review-workflow.mjs";
import {
  buildDispatchRequest,
  findProjectRoot,
  loadCurrentRegistry,
  resolveProjectPath,
} from "../lib/dispatcher-core.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REVIEW_LANE_TASKS = { standards: "Standards evidence only", spec: "Spec evidence only" };

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
      { command: "test red", phase: "RED", exitCode: 1, testCount: 1, outcome: "failed as expected" },
      { command: "test green", phase: "GREEN", exitCode: 0, testCount: 1, outcome: "passed" },
    ],
    residualRisks: [],
  };
}

test("dispatcher authorization allows ordinary workflows without prompting", async () => {
  let prompted = false;
  const reason = await authorizeWorkflowDispatch("matt-research", undefined, {
    hasUI: false,
    ui: { confirm: async () => { prompted = true; return true; } },
  }, createDispatchAuthorization());

  assert.equal(reason, "not-required");
  assert.equal(prompted, false);
});

test("dispatcher parses explicit skill invocations like Pi does", () => {
  assert.equal(parseInvokedSkill("/skill:matt-implement"), "matt-implement");
  assert.equal(parseInvokedSkill("/skill:matt-implement 处理 ticket 003"), "matt-implement");
  assert.equal(parseInvokedSkill("/skill:matt-grilling"), "matt-grilling");
  assert.equal(parseInvokedSkill("请运行 /skill:matt-implement"), null);
  assert.equal(parseInvokedSkill("/template:foo"), null);
  assert.equal(parseInvokedSkill("/skill:"), null);
  assert.equal(parseInvokedSkill(undefined), null);
});

test("dispatcher skips the matt-tdd prompt for a user-invoked implement session", async () => {
  for (const source of ["interactive", "rpc"]) {
    const authorization = createDispatchAuthorization();
    let prompted = false;
    authorization.observeInput("/skill:matt-implement 003-modular-python-worker", source);

    const reason = await authorizeWorkflowDispatch("matt-tdd", undefined, {
      hasUI: false,
      ui: { confirm: async () => { prompted = true; return true; } },
    }, authorization);

    assert.equal(reason, "user-invoked-implement", source);
    assert.equal(prompted, false, source);
  }
});

test("dispatcher still prompts when implement was not user-invoked", async () => {
  const extensionInjected = createDispatchAuthorization();
  extensionInjected.observeInput("/skill:matt-implement", "extension");
  assert.equal(extensionInjected.userInvokedImplement(), false);

  const otherSkill = createDispatchAuthorization();
  otherSkill.observeInput("/skill:matt-implement", "interactive");
  assert.equal(otherSkill.userInvokedImplement(), true);
  otherSkill.observeInput("/skill:matt-grilling", "interactive");
  assert.equal(otherSkill.userInvokedImplement(), false, "a later explicit skill invocation revokes the grant");

  const plainText = createDispatchAuthorization();
  plainText.observeInput("实现 ticket 003", "interactive");
  assert.equal(plainText.userInvokedImplement(), false);

  const reset = createDispatchAuthorization();
  reset.observeInput("/skill:matt-implement", "interactive");
  reset.reset();
  assert.equal(reset.userInvokedImplement(), false);

  let prompted = false;
  const reason = await authorizeWorkflowDispatch("matt-tdd", undefined, {
    hasUI: true,
    ui: { confirm: async () => { prompted = true; return true; } },
  }, extensionInjected);
  assert.equal(reason, "user-confirmed");
  assert.equal(prompted, true);
});

test("dispatcher authorization fails closed for matt-tdd without UI or confirmation", async () => {
  await assert.rejects(
    () => authorizeWorkflowDispatch("matt-tdd", undefined, { hasUI: false, ui: {} }, createDispatchAuthorization()),
    /requires explicit user authorization outside an explicit \/skill:matt-implement session/,
  );

  let prompt;
  await assert.rejects(
    () => authorizeWorkflowDispatch("matt-tdd", undefined, {
      hasUI: true,
      ui: {
        confirm: async (title, message) => {
          prompt = { title, message };
          return false;
        },
      },
    }, createDispatchAuthorization()),
    /was not authorized by the user; no workflow was queued/,
  );
  assert.equal(prompt.title, "Authorize matt-tdd?");
  assert.match(prompt.message, /No explicit \/skill:matt-implement invocation was seen/);
  assert.match(prompt.message, /verified one ready ticket or approved a direct slice/);
  assert.match(prompt.message, /publish a spec, split tickets, or pause/);
});

test("dispatcher authorization records an explicit matt-tdd confirmation", async () => {
  const reason = await authorizeWorkflowDispatch("matt-tdd", undefined, {
    hasUI: true,
    ui: { confirm: async () => true },
  }, createDispatchAuthorization());
  assert.equal(reason, "user-confirmed");
});

test("dispatcher verifies package resources separately from the target project", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "pi-x-matt-package-"));
  const targetRoot = await mkdtemp(join(tmpdir(), "pi-x-matt-target-"));
  try {
    for (const source of [".pi/agents", ".pi/skills", "skillpacks", "vendor", "config"]) {
      await cp(join(ROOT, source), join(packageRoot, source), { recursive: true });
    }
    const registry = await loadCurrentRegistry(packageRoot);
    const plan = buildDispatchRequest(registry, registry.skills["matt-research"], "调查一个明确问题", targetRoot);

    assert.equal(plan.rpcParams.cwd, targetRoot);
    assert.deepEqual(plan.lanes.map(({ key, agent }) => ({ key, agent })), [{ key: "research", agent: "matt-researcher" }]);
    assert.match(plan.rpcParams.workflowScript, /research-executor/);
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("dispatcher builds one guarded fresh child for research", async () => {
  const registry = await loadCurrentRegistry(ROOT);
  const workflow = registry.skills["matt-research"];
  const plan = buildDispatchRequest(registry, workflow, "调查一个明确问题", ROOT);
  const items = parseWorkflowItems(plan.rpcParams.workflowScript);

  assert.equal(plan.lanes.length, 1);
  assert.equal(items.length, 1);
  assert.equal(items[0].key, "research");
  assert.equal(items[0].agent, "matt-researcher");
  assert.equal(items[0].context, "fresh");
  assert.deepEqual(items[0].skill, ["research-executor"]);
  assert.equal(items[0].output, false);
  assert.equal("turnBudget" in items[0], false);
  assert.equal(items[0].outputSchema.type, "object");
  assert.match(plan.rpcParams.workflowScript, /completed without valid structuredOutput/);
  assert.deepEqual(
    { async: plan.rpcParams.async, mission: plan.rpcParams.mission, cwd: plan.rpcParams.cwd },
    { async: true, mission: false, cwd: ROOT },
  );
});

test("dispatcher builds one guarded prototype writer with private branch skills", async () => {
  const registry = await loadCurrentRegistry(ROOT);
  const workflow = registry.skills["matt-prototype"];
  const plan = buildDispatchRequest(registry, workflow, "构建一个已确认问题的 logic prototype", ROOT);
  const items = parseWorkflowItems(plan.rpcParams.workflowScript);

  assert.equal(plan.lanes.length, 1);
  assert.deepEqual(plan.lanes[0].skills, ["prototype-logic", "prototype-ui", "prototype-executor"]);
  assert.deepEqual(
    items.map(({ key, agent, context, skill, output }) => ({ key, agent, context, skill, output })),
    [{
      key: "prototype",
      agent: "matt-worker",
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
    agent: "matt-worker",
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
    { key: "minimal", agent: "matt-reader", skills: closure },
    { key: "flexible", agent: "matt-reader", skills: closure },
    { key: "common-caller", agent: "matt-reader", skills: closure },
  ]);
  assert.deepEqual(items.map((item) => item.context), ["fresh", "fresh", "fresh"]);
  assert.ok(items.every((item) => item.agent === "matt-reader" && item.output === false));
  assert.deepEqual(items.map((item) => item.outputSchema.properties.strategy.enum[0]), ["minimal", "flexible", "common-caller"]);
  assert.match(plan.rpcParams.workflowScript, /minimal\.status/);
  assert.match(plan.rpcParams.workflowScript, /flexible\.status/);
  assert.match(plan.rpcParams.workflowScript, /common-caller\.status/);
});

test("dispatcher builds two independent guarded review lanes", async () => {
  const registry = await loadCurrentRegistry(ROOT);
  const workflow = registry.skills["matt-code-review"];
  const plan = buildDispatchRequest(registry, workflow, "评审固定范围", ROOT, REVIEW_LANE_TASKS);
  const items = parseWorkflowItems(plan.rpcParams.workflowScript);

  assert.deepEqual(items.map(({ key, agent, context, skill, output }) => ({ key, agent, context, skill, output })), [
    { key: "standards", agent: "matt-reviewer", context: "fresh", skill: ["review-standards"], output: false },
    { key: "spec", agent: "matt-reviewer", context: "fresh", skill: ["review-spec"], output: false },
  ]);
  assert.match(items[0].task, /Standards evidence only/);
  assert.doesNotMatch(items[0].task, /Spec evidence only/);
  assert.match(items[1].task, /Spec evidence only/);
  assert.doesNotMatch(items[1].task, /Standards evidence only/);
  assert.ok(items.every((item) => item.timeoutMs === 900000));
  assert.ok(items.every((item) => !("turnBudget" in item)));
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
  const plan = buildDispatchRequest(registry, registry.skills["matt-tdd"], "已确认 seams 的实现任务", ROOT, {
    implement: "已确认 seams 的实现任务；执行 RED/GREEN",
    standards: "按当前 worktree diff 执行 Standards 复核",
    spec: "读取 ticket/spec 后按当前 worktree diff 执行 Spec 复核",
  });
  const stages = parsePipelineStages(plan.rpcParams.workflowScript);

  assert.deepEqual(plan.lanes.map(({ key, stage, agent, skills }) => ({ key, stage, agent, skills })), [
    { key: "implement", stage: 1, agent: "matt-worker", skills: ["codebase-design", "tdd-executor"] },
    { key: "standards", stage: 2, agent: "matt-reviewer", skills: ["review-standards"] },
    { key: "spec", stage: 2, agent: "matt-reviewer", skills: ["review-spec"] },
  ]);
  assert.equal(stages.length, 2);
  assert.deepEqual(stages[0].map(({ key, agent, context, skill, output }) => ({ key, agent, context, skill, output })), [
    { key: "implement", agent: "matt-worker", context: "fresh", skill: ["codebase-design", "tdd-executor"], output: false },
  ]);
  assert.deepEqual(stages[1].map(({ key, agent, context, skill, output }) => ({ key, agent, context, skill, output })), [
    { key: "standards", agent: "matt-reviewer", context: "fresh", skill: ["review-standards"], output: false },
    { key: "spec", agent: "matt-reviewer", context: "fresh", skill: ["review-spec"], output: false },
  ]);
  assert.equal(stages[0][0].timeoutMs, 1200000);
  assert.ok(stages[1].every((item) => item.timeoutMs === 900000));
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

test("TDD host evidence is captured once after implement and before both reviewers, failing closed", async () => {
  const registry = await loadCurrentRegistry(ROOT);
  const evidence = { command: "trusted-collector", path: "/tmp/workflow-owned/review.md" };
  const plan = buildDispatchRequest(registry, registry.skills["matt-tdd"], "shared", ROOT, {
    implement: "Implementation Context Pack", standards: "Applicable standards", spec: "Acceptance matrix",
  }, evidence);
  assert.deepEqual(plan.hostCommands, [{ key: "review-evidence", command: evidence.command }]);
  const plans = new Map([["validated-id", plan]]);
  assert.equal(resolveReviewWorkflow(plans, { dispatchId: "validated-id" }).script, plan.rpcParams.workflowScript);
  assert.match(resolveReviewWorkflow(plans, { dispatchId: "validated-id" }).error, /expired/, "validated plans are one-shot");
  assert.match(resolveReviewWorkflow(plans, { dispatchId: "unknown" }).error, /Unknown/);
  assert.match(resolveReviewWorkflow(plans, { dispatchId: "validated-id", command: "untrusted" }).error, /Expected only/);

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction("runs", "emit", plan.rpcParams.workflowScript);
  const order = [];
  const emitted = [];
  const runs = {
    all: async (items) => {
      order.push(items.map(item => item.key).join(","));
      if (items[0].key === "standards") {
        assert.ok(items.every(item => item.task.includes(evidence.path)));
        assert.ok(items.every(item => item.task.includes("worker-reported")));
        assert.ok(items.every(item => item.task.includes('"exitCode":1')));
        assert.ok(items.every(item => !item.task.includes('"summary":"done"')), "do not inject the writer's completion narrative");
      }
      return items.map(item => ({ key: item.key, structuredOutput: item.key === "implement"
        ? completeWorkerOutput() : { axis: item.key, verdict: "PASS" } }));
    },
    host: async (key, options) => {
      order.push(key);
      assert.equal(options.command, evidence.command);
      assert.equal(options.kind, "command");
    },
  };
  const results = await execute(runs, value => emitted.push(value));
  assert.ok(results.slice(1).every(result => result.artifactPaths.includes(evidence.path)));
  assert.deepEqual(order, ["implement", "review-evidence", "standards,spec"]);
  assert.deepEqual(emitted, [{ reviewEvidencePath: evidence.path }]);
  order.length = 0;
  await assert.rejects(() => execute({ ...runs, host: async () => { throw new Error("capture failed"); } }, () => {}), /capture failed/);
  assert.deepEqual(order, ["implement"], "no reviewer can launch without current Git evidence");
});

test("dispatcher supports complete per-lane task replacements", async () => {
  const registry = await loadCurrentRegistry(ROOT);
  const plan = buildDispatchRequest(
    registry,
    registry.skills["matt-tdd"],
    "共享任务不应覆盖显式 lane task",
    ROOT,
    {
      implement: "只执行 report-only 结构化恢复",
      standards: "只按当前 worktree diff 执行 Standards 复核",
      spec: "先读取 ticket/spec，再按当前 worktree diff 执行 Spec 复核",
    },
  );
  const stages = parsePipelineStages(plan.rpcParams.workflowScript);

  assert.match(stages[0][0].task, /只执行 report-only 结构化恢复/);
  assert.doesNotMatch(stages[0][0].task, /Standards 复核/);
  assert.match(stages[1][0].task, /只按当前 worktree diff 执行 Standards 复核/);
  assert.doesNotMatch(stages[1][0].task, /report-only 结构化恢复/);
  assert.match(stages[1][1].task, /先读取 ticket\/spec/);
  assert.doesNotMatch(stages[1][1].task, /report-only 结构化恢复/);

  assert.throws(
    () => buildDispatchRequest(registry, registry.skills["matt-tdd"], "shared", ROOT, { unknown: "task" }),
    /unknown lane 'unknown'/,
  );
  assert.throws(
    () => buildDispatchRequest(registry, registry.skills["matt-tdd"], "shared", ROOT, { implement: "task" }),
    /requires complete laneTasks for \[standards, spec\]/,
  );
  assert.throws(
    () => buildDispatchRequest(registry, registry.skills["matt-code-review"], "shared", ROOT, { standards: "task" }),
    /matt-code-review.*requires complete laneTasks for \[spec\]/,
  );
});

test("dispatcher workflow guard rejects missing structured output", async () => {
  const registry = await loadCurrentRegistry(ROOT);
  const plan = buildDispatchRequest(registry, registry.skills["matt-research"], "matt-research", ROOT);
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

  const failureCases = [
    {
      name: "timeout error",
      result: { error: "Subagent timed out after 600000ms.", timedOut: true },
      reason: "Subagent timed out after 600000ms.",
    },
    { name: "provider error", result: { error: "fetch failed" }, reason: "fetch failed" },
    { name: "timeout flag", result: { timedOut: true }, reason: "Subagent timed out." },
    {
      name: "turn budget",
      result: { turnBudgetExceeded: true },
      reason: "Subagent exceeded its turn budget.",
    },
    { name: "stopped", result: { stopped: true }, reason: "Subagent stopped before completion." },
    {
      name: "termination signal",
      result: { processSignal: "SIGTERM" },
      reason: "Subagent terminated with process signal SIGTERM.",
    },
    { name: "non-zero exit", result: { exitCode: 1 }, reason: "Subagent exited with code 1." },
  ];
  for (const { name, result, reason } of failureCases) {
    await assert.rejects(
      () => execute({ all: async () => [{ key: "research", ...result }] }),
      (error) => {
        assert.equal(error.message, `Workflow lane research failed before structuredOutput: ${reason}`, name);
        return true;
      },
    );
  }

  const structuredOutput = { question: "q" };
  const result = await execute({ all: async () => [{ key: "research", ok: true, structuredOutput }] });
  assert.deepEqual(result[0].structuredOutput, structuredOutput);
});

test("dispatcher resumes a retained child once for structured-output settlement", async () => {
  const registry = await loadCurrentRegistry(ROOT);
  const plan = buildDispatchRequest(registry, registry.skills["matt-research"], "matt-research", ROOT);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction("runs", plan.rpcParams.workflowScript);
  const failures = [
    { error: "Missing structured_output call; this step has outputSchema and must finish by calling structured_output." },
    { error: "Subagent timed out after 300000ms.", timedOut: true },
  ];

  for (const failure of failures) {
    let calls = 0;
    const results = await execute({ all: async (items) => {
      calls += 1;
      if (calls === 1) {
        return [{
          key: "research",
          ok: false,
          runId: "retained-run",
          resumability: { state: "resumable" },
          ...failure,
        }];
      }
      assert.equal(items.length, 1);
      assert.equal(items[0].key, "research-settlement");
      assert.equal(items[0].resume, "retained-run");
      assert.equal(items[0].timeoutMs, 300000);
      assert.match(items[0].task, /立即调用 structured_output/);
      assert.match(items[0].task, /不得编造 COMPLETE 或 PASS/);
      return [{
        key: "research-settlement",
        ok: true,
        structuredOutput: { question: "q", summary: "done", findings: [], sources: [], gaps: [] },
      }];
    } });

    assert.equal(calls, 2);
    assert.equal(results[0].key, "research");
    assert.equal(results[0].structuredOutput.summary, "done");
  }
});

test("dispatcher fails closed on malformed lanes and cross-agent grants", async () => {
  const registry = await loadCurrentRegistry(ROOT);
  const duplicate = structuredClone(registry.skills["matt-code-review"]);
  duplicate.workflow.lanes[1].key = duplicate.workflow.lanes[0].key;
  assert.throws(() => buildDispatchRequest(registry, duplicate, "review", ROOT, REVIEW_LANE_TASKS), /duplicate lane/);

  const reserved = structuredClone(registry.skills["matt-code-review"]);
  reserved.workflow.lanes[0].key = "standards-settlement";
  assert.throws(() => buildDispatchRequest(registry, reserved, "review", ROOT, REVIEW_LANE_TASKS), /reserved settlement suffix/);

  const crossAgentRegistry = structuredClone(registry);
  crossAgentRegistry.skills["review-spec"].agent = "matt-worker";
  assert.throws(
    () => buildDispatchRequest(crossAgentRegistry, crossAgentRegistry.skills["matt-code-review"], "review", ROOT, REVIEW_LANE_TASKS),
    /cannot grant 'review-spec' to agent 'matt-reviewer'/,
  );
});

test("dispatcher rejects interaction parents", async () => {
  const registry = await loadCurrentRegistry(ROOT);
  const interaction = registry.skills["matt-grill-with-docs"];
  assert.throws(
    () => buildDispatchRequest(registry, interaction, "不要委派 HITL 访谈", ROOT),
    /not a parent orchestration workflow/,
  );
});

test("dispatcher validates runtime gate shape for every workflow mode", async () => {
  const registry = await loadCurrentRegistry(ROOT);
  const invalid = structuredClone(registry.skills["matt-code-review"]);
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
    registry.skills["matt-grilling"].dispatch = "parallel";
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    await assert.rejects(() => loadCurrentRegistry(temp), /invalid interaction routing for 'matt-grilling'/);
  });

  await withTempDispatcherProject(async (temp) => {
    const registryPath = join(temp, "config", "skill-registry.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8"));
    registry.skills["matt-grilling"].class = "unsupported";
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    await assert.rejects(() => loadCurrentRegistry(temp), /unsupported parent class for 'matt-grilling'/);
  });
});

test("dispatcher rejects a tampered generated registry", async () => {
  await withTempDispatcherProject(async (temp) => {
    const registryPath = join(temp, "config", "skill-registry.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8"));
    registry.skills["matt-research"].workflow.lanes[0].timeoutMs = 1;
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

    await assert.rejects(() => loadCurrentRegistry(temp), /not the current generated registry/);
  });
});
