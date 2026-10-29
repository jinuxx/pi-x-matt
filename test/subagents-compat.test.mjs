import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { registerWorkflowResource } from "pi-subagents/workflow-resources";
import { loadCurrentRegistry } from "../lib/dispatcher-core.mjs";
import { buildDispatchRequest } from "./helpers/dispatch-plan.mjs";
import { resolveReviewWorkflow } from "../lib/review-workflow.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const PACKAGE_ROOT = resolve(dirname(require.resolve("pi-subagents/workflow-resources")), "..");
const SOURCE_DIR = join(PACKAGE_ROOT, "src");
// Exercise the pinned runtime's real parser/sandbox and notification formatter,
// without launching child sessions, running host commands, or calling models.
const { runWorkflowScript, validateWorkflowScript } = await import(pathToFileURL(join(SOURCE_DIR, "workflows/scripted-workflow.js")));
const { resolveWorkflowResource } = await import(pathToFileURL(join(SOURCE_DIR, "workflows/workflow-resources.js")));
const { buildCompletionDetails, formatSingleCompletion } = await import(pathToFileURL(join(SOURCE_DIR, "runs/background/notify.js")));
const { createCapacityResilientJsonWriter } = await import(pathToFileURL(join(SOURCE_DIR, "shared/capacity-resilient-json.js")));

function planFor(registry, name, evidence) {
  const workflow = registry.skills[name];
  const laneTasks = Object.fromEntries(workflow.workflow.lanes.map(lane => [lane.key, "Compatibility probe"]));
  return buildDispatchRequest(registry, workflow, "Compatibility probe", ROOT, laneTasks, evidence);
}

function successfulResult(plan, key) {
  const lane = plan.lanes.find(lane => lane.key === key);
  const structuredOutput = lane.gate
    ? { [lane.gate.field]: lane.gate.equals, ...Object.fromEntries((lane.gate.nonEmpty ?? []).map(field => [field, ["mock evidence"]])) }
    : { question: "probe" };
  return { key, ok: true, output: "", artifactPaths: [], structuredOutput };
}

const unexpectedStatus = async () => { throw new Error("Unexpected status call"); };

function reviewResult(plan, key, verdict) {
  return {
    ...successfulResult(plan, key),
    structuredOutput: {
      axis: key, verdict, summary: `${key}: ${verdict}`,
      findings: verdict === "FAIL" ? [{
        severity: "P1", title: `${key} finding`, evidence: `${key}: ${"evidence ".repeat(800)}`,
        locations: [`${key}.mjs:1`], recommendation: `Fix ${key}`,
      }] : [],
      notes: verdict === "NO_EVIDENCE" ? ["Required evidence is unavailable"] : [],
    },
  };
}

function implementResult(plan) {
  return {
    ...successfulResult(plan, "implement"),
    structuredOutput: {
      status: "COMPLETE", summary: "Implemented", residualRisks: [], changedFiles: ["file.mjs"],
      confirmedSeams: [{ name: "module", interface: "public", behaviors: ["works"] }],
      cycles: [{ test: "works", redEvidence: "failed first", greenEvidence: "passed next", files: ["file.mjs"] }],
      commands: [
        { command: "test red", phase: "RED", exitCode: 1, testCount: 1, outcome: "failed as expected" },
        { command: "test green", phase: "GREEN", exitCode: 0, testCount: 1, outcome: "passed" },
      ],
    },
  };
}

// The real sandbox drives onEmit; the adapter uses the pinned async executor's
// status projection and atomic writer. Never recover from partial.children here:
// the failure checkpoint must already be on disk when the sandbox rejects.
async function withPersistedWorkflow(plan, launch, inspect) {
  const directory = await mkdtemp(join(tmpdir(), "pi-matt-workflow-status-"));
  const statusPath = join(directory, "status.json");
  const writer = createCapacityResilientJsonWriter();
  let status = { runId: "test-workflow", state: "running", workflow: { emits: [] } };
  const calls = [];
  let failure;
  try {
    writer.write(statusPath, status);
    try {
      const result = await runWorkflowScript({
        script: plan.rpcParams.script, timeoutMs: 5000, status: unexpectedStatus,
        launch: async key => { calls.push(key); return launch(key); },
        host: async key => {
          calls.push(key);
          return { key, kind: "command", ok: true, state: "passed", exitCode: 0,
            stdout: "", stderr: "", outputPath: "/tmp/mock-host.log", durationMs: 1 };
        },
        onEmit: emits => {
          status.workflow = { ...status.workflow, emits };
          writer.write(statusPath, status);
        },
      });
      status = { ...status, state: "complete", workflow: { ...status.workflow, value: result.value } };
    } catch (error) {
      failure = error;
      const published = JSON.parse(await readFile(statusPath, "utf8"));
      assert.deepEqual(published.workflow.emits, error.partial.emits);
      assert.ok(published.workflow.emits.some(value => value.type === "pi-x-matt.stage-results"),
        `complete stage results must be persisted before the gate throws: ${error.message}`);
      status = { ...published, state: "failed", error: error.message };
    }
    writer.write(statusPath, status);
    // Consume only the documented status.json source, not the in-memory emits.
    const persisted = JSON.parse(await readFile(statusPath, "utf8"));
    const checkpoint = persisted.workflow.emits.findLast(value => value.type === "pi-x-matt.stage-results");
    assert.equal(checkpoint.version, 1);
    assert.equal(checkpoint.workflow, "matt-tdd");
    const results = persisted.state === "complete" ? persisted.workflow.value : checkpoint.results;
    await inspect({ persisted, checkpoint, results, calls, failure });
  } finally {
    writer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

test("TDD PASS remains readable from persisted workflow.value", async () => {
  const registry = await loadCurrentRegistry(ROOT);
  const plan = planFor(registry, "matt-tdd", { command: "trusted-collector", path: "/tmp/mock-review.md" });
  await withPersistedWorkflow(plan,
    key => key === "implement" ? implementResult(plan) : reviewResult(plan, key, "PASS"),
    ({ persisted, checkpoint, results, calls, failure }) => {
      assert.equal(failure, undefined);
      assert.equal(persisted.state, "complete");
      assert.equal(checkpoint.stage, 2);
      assert.deepEqual(results, persisted.workflow.value);
      assert.deepEqual(results, checkpoint.results);
      assert.deepEqual(results.map(result => result.key), ["implement", "standards", "spec"]);
      assert.deepEqual(calls, ["implement", "review-evidence", "standards", "spec"]);
    });
});

test("controlled incremental review and selective recovery run in the pinned native sandbox", async () => {
  const registry = await loadCurrentRegistry(ROOT);
  const evidence = { command: "trusted-collector", path: "/tmp/mock-review.md", controlled: true };
  const workflow = registry.skills["matt-tdd"];
  const laneTasks = { implement: "Implementation pack", standards: "Standards only", spec: "Spec only" };
  const plan = buildDispatchRequest(registry, workflow, "shared", ROOT, laneTasks, evidence);
  assert.equal(validateWorkflowScript(plan.rpcParams.script).ok, true);
  const result = await runWorkflowScript({
    script: plan.rpcParams.script, timeoutMs: 5000, status: unexpectedStatus,
    launch: async key => key === "implement" ? implementResult(plan) : reviewResult(plan, key, "PASS"),
    host: async key => ({ key, kind: "command", ok: true, state: "passed", exitCode: 0,
      stdout: JSON.stringify({ boundary: { incremental: true, changedPaths: ["file.mjs"], approvedFindingIds: [] } }),
      stderr: "", outputPath: "/tmp/mock-host", durationMs: 1 }),
  });
  assert.deepEqual(result.value.map(row => row.key), ["implement", "standards", "spec"]);
  const prior = result.value.map(row => row.key === "spec" ? { key: "spec", ok: false, error: "fetch failed" } : row);
  const recovery = buildDispatchRequest(registry, workflow, "shared", ROOT, laneTasks, evidence, {
    results: prior, keys: ["spec"], boundary: { incremental: true, changedPaths: ["file.mjs"], approvedFindingIds: [] },
  });
  const calls = [];
  const recovered = await runWorkflowScript({
    script: recovery.rpcParams.script, timeoutMs: 5000, status: unexpectedStatus,
    launch: async key => { calls.push(key); return reviewResult(plan, key, "PASS"); },
    host: async () => { throw new Error("Recovery must not recapture evidence"); },
  });
  assert.deepEqual(calls, ["spec"]);
  assert.equal(recovered.value[2].recoveryHistory[0].error, "fetch failed");
});

test("each reviewer FAIL or NO_EVIDENCE fails closed with both full results persisted", async () => {
  const registry = await loadCurrentRegistry(ROOT);
  const evidence = { command: "trusted-collector", path: "/tmp/mock-review.md" };
  const plan = planFor(registry, "matt-tdd", evidence);
  for (const axis of ["standards", "spec"]) {
    for (const verdict of ["FAIL", "NO_EVIDENCE"]) {
      const expected = plan.lanes.map(({ key }) => key === "implement"
        ? implementResult(plan) : reviewResult(plan, key, key === axis ? verdict : "PASS"));
      await withPersistedWorkflow(plan, key => expected.find(result => result.key === key),
        ({ persisted, checkpoint, results, failure, calls }) => {
          assert.match(failure.message, new RegExp(`${axis}\\.verdict`));
          assert.equal(persisted.state, "failed");
          assert.equal(Object.hasOwn(persisted.workflow, "value"), false);
          assert.equal(checkpoint.stage, 2);
          assert.deepEqual(results.map(result => result.structuredOutput), expected.map(result => result.structuredOutput));
          assert.ok(results.slice(1).every(result => result.artifactPaths.includes(evidence.path)));
          assert.deepEqual(calls, ["implement", "review-evidence", "standards", "spec"], "no automatic rerun");
        });
    }
  }
});

test("both failing review axes retain all findings, not just the first gate error", async () => {
  const registry = await loadCurrentRegistry(ROOT);
  const plan = planFor(registry, "matt-tdd");
  await withPersistedWorkflow(plan,
    key => key === "implement" ? implementResult(plan) : reviewResult(plan, key, "FAIL"),
    ({ persisted, results, failure }) => {
      assert.equal(persisted.state, "failed");
      assert.match(failure.message, /standards\.verdict/);
      for (const result of results.slice(1)) {
        assert.deepEqual(result.structuredOutput, reviewResult(plan, result.key, "FAIL").structuredOutput);
        assert.ok(result.structuredOutput.findings[0].evidence.length > 5000);
      }
    });
});

test("blocked or missing implement results persist but cannot launch evidence or review", async () => {
  const registry = await loadCurrentRegistry(ROOT);
  const plan = planFor(registry, "matt-tdd", { command: "trusted-collector", path: "/tmp/mock-review.md" });
  for (const missing of [false, true]) {
    const implement = implementResult(plan);
    if (missing) delete implement.structuredOutput;
    else implement.structuredOutput.status = "BLOCKED";
    await withPersistedWorkflow(plan, () => implement, ({ persisted, checkpoint, results, failure, calls }) => {
      assert.equal(persisted.state, "failed");
      assert.match(failure.message, missing ? /without valid structuredOutput/ : /implement\.status/);
      assert.equal(checkpoint.stage, 1);
      assert.deepEqual(results, [implement]);
      assert.deepEqual(calls, ["implement"]);
    });
  }
});

test("execution and invalid-output failures remain distinct from valid review verdicts on disk", async () => {
  const registry = await loadCurrentRegistry(ROOT);
  const plan = planFor(registry, "matt-tdd");
  const cases = [
    { ok: false, error: "provider failed after structured_output", structuredOutput: reviewResult(plan, "spec", "FAIL").structuredOutput },
    { ok: true },
    { ok: false, error: "Structured output validation failed: invalid verdict" },
  ];
  for (const result of cases) {
    await withPersistedWorkflow(plan,
      key => key === "implement" ? implementResult(plan)
        : key === "standards" ? reviewResult(plan, key, "FAIL")
          : { key, output: "", artifactPaths: [], ...result },
      ({ persisted, results, calls }) => {
        assert.equal(persisted.state, "failed");
        // The first gate error is not an aggregate verdict: inspect every lane.
        const standards = results.find(result => result.key === "standards");
        assert.equal(standards.ok, true);
        assert.equal(standards.structuredOutput.verdict, "FAIL");
        assert.deepEqual(standards.structuredOutput.findings, reviewResult(plan, "standards", "FAIL").structuredOutput.findings);
        const spec = results.find(result => result.key === "spec");
        assert.equal(spec.ok, result.ok);
        assert.deepEqual(spec.structuredOutput, result.structuredOutput);
        assert.equal(spec.error, result.error);
        assert.ok(spec.ok !== true || !spec.structuredOutput, "not a valid review rejection");
        assert.deepEqual(calls, ["implement", "standards", "spec"]);
      });
  }
});

test("project filter selects the installed npm extension and matches the bundled version", async () => {
  const manifest = JSON.parse(await readFile(join(PACKAGE_ROOT, "package.json"), "utf8"));
  const ownManifest = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  const settings = JSON.parse(await readFile(join(ROOT, ".pi/settings.json"), "utf8"));
  assert.equal(manifest.version, ownManifest.dependencies["pi-subagents"]);
  const entry = settings.packages.find(entry => entry.source === `npm:pi-subagents@${manifest.version}`);
  assert.ok(entry);
  assert.deepEqual(entry.extensions, manifest.pi.extensions.map(path => `+${path.replace(/^\.\//, "")}`));
  for (const path of manifest.pi.extensions) {
    assert.equal((await stat(join(PACKAGE_ROOT, path))).isFile(), true);
  }
});

test("all generated workflows validate and run in the installed sandbox with mock children", async () => {
  const registry = await loadCurrentRegistry(ROOT);
  for (const workflow of Object.values(registry.skills)) {
    if (workflow.class !== "orchestration") continue;
    const plan = planFor(registry, workflow.name);
    const validation = validateWorkflowScript(plan.rpcParams.script);
    assert.equal(validation.ok, true, JSON.stringify(validation.errors));
    const result = await runWorkflowScript({
      script: plan.rpcParams.script, timeoutMs: 5000, status: unexpectedStatus,
      launch: async key => successfulResult(plan, key),
    });
    assert.deepEqual(result.value.map(result => result.key), plan.lanes.map(lane => lane.key), workflow.name);
  }
});

test("a failed implement with retained COMPLETE output cannot run host evidence or reviewers", async () => {
  const registry = await loadCurrentRegistry(ROOT);
  const plan = planFor(registry, "matt-tdd", { command: "trusted-collector", path: "/tmp/mock-review.md" });
  const calls = [];
  await assert.rejects(() => runWorkflowScript({
    script: plan.rpcParams.script, timeoutMs: 5000, status: unexpectedStatus,
    launch: async key => {
      calls.push(key);
      return { ...successfulResult(plan, key), ok: false, error: "provider failed after structured_output" };
    },
    host: async () => { throw new Error("Host evidence must not run"); },
  }), /provider failed after structured_output/);
  assert.deepEqual(calls, ["implement"]);
});

test("the bundled public resource API resolves a one-shot TDD plan in the installed runtime", async () => {
  const registry = await loadCurrentRegistry(ROOT);
  const plan = planFor(registry, "matt-tdd", { command: "trusted-collector", path: "/tmp/mock-review.md" });
  const plans = new Map([["probe-id", plan]]);
  const sessionId = "pi-x-matt-compat-test";
  const resource = registerWorkflowResource({
    sessionId,
    definition: { name: "pi-x-matt.tdd", version: 1, resolve: args => resolveReviewWorkflow(plans, args) },
  });
  try {
    const result = resolveWorkflowResource("pi-x-matt.tdd", { dispatchId: "probe-id" }, sessionId);
    assert.equal(result.ok, true);
    assert.equal(result.resource.script, plan.rpcParams.script);
    assert.equal(result.resource.provenance.name, "pi-x-matt.tdd");
    assert.equal(resolveWorkflowResource("pi-x-matt.tdd", { dispatchId: "probe-id" }, sessionId).ok, false);
  } finally {
    resource.dispose();
  }
  assert.equal(resolveWorkflowResource("pi-x-matt.tdd", { dispatchId: "probe-id" }, sessionId).ok, false);
});

test("a truncated structured completion retains an explicit path to the complete JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-matt-completion-"));
  try {
    const structuredOutput = { question: "probe", summary: "x".repeat(3000), findings: [], sources: [], gaps: [] };
    const structuredOutputPath = join(directory, "output.json");
    await writeFile(structuredOutputPath, JSON.stringify(structuredOutput));
    const details = buildCompletionDetails({
      id: "probe-run", runId: "probe-run", agent: "workflow", mode: "workflow",
      success: true, summary: "mock workflow summary",
      results: [{
        agent: "matt-researcher", runId: "child-run", workflowKey: "research",
        success: true, exitCode: 0, output: "", outputState: "absent",
        structuredOutput, structuredOutputPath,
      }],
    });
    const notice = formatSingleCompletion(details);
    assert.ok(notice.includes("[preview truncated]"));
    assert.ok(notice.includes(structuredOutputPath));
    assert.ok(!notice.includes(structuredOutput.summary));
    assert.equal(details.childOutputs[0].workflowKey, "research");
    assert.equal(details.childOutputs[0].runId, "child-run");
    assert.equal(details.childOutputs[0].status, "completed");
    const full = JSON.parse(await readFile(details.childOutputs[0].structuredOutputPath, "utf8"));
    assert.deepEqual(full, structuredOutput);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
