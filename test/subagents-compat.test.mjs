import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { registerWorkflowResource } from "pi-subagents/workflow-resources";
import { loadCurrentRegistry } from "../lib/dispatcher-core.mjs";
import { createImplementationRuntime } from "../lib/implementation-runtime.mjs";
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
          const outputs = results.map((result, index) => {
            const output = result.structuredOutput;
            if (result.key !== "spec" || output.verdict !== "NO_EVIDENCE") return output;
            assert.deepEqual(output.notes.slice(0, expected[index].structuredOutput.notes.length),
              expected[index].structuredOutput.notes);
            assert.match(output.notes.join("\n"), /laneTasks\.spec.*parent spec/);
            return { ...output, notes: expected[index].structuredOutput.notes };
          });
          assert.deepEqual(outputs, expected.map(result => result.structuredOutput));
          assert.ok(results.slice(1).every(result => result.artifactPaths.includes(evidence.path)));
          assert.deepEqual(calls, ["implement", "review-evidence", "standards", "spec"], "no automatic rerun");
        });
    }
  }
});

test("writer-only repair and deferred review validate and execute in the native sandbox", async () => {
  const registry = await loadCurrentRegistry(ROOT);
  const workflow = registry.skills["matt-tdd"];
  const tasks = { implement: "Repair all approved findings", standards: "Standards only", spec: "Spec only" };
  const evidence = { command: "trusted-collector", path: "/tmp/repair.md", controlled: true, claimCommand: "trusted-claim" };
  const boundary = { incremental: true, changedPaths: ["file.mjs"], approvedFindingIds: ["spec:F1"] };
  const repair = buildDispatchRequest(registry, workflow, "shared", ROOT, tasks, evidence, undefined,
    { repairOnly: true, resume: "retained-writer" });
  assert.equal(validateWorkflowScript(repair.rpcParams.script).ok, true);
  const calls = [];
  const repaired = await runWorkflowScript({
    script: repair.rpcParams.script, timeoutMs: 5000, status: unexpectedStatus,
    launch: async (key, params) => {
      calls.push(key);
      assert.equal(params.resume, "retained-writer");
      for (const field of ["agent", "context", "skill", "outputSchema", "gate"]) assert.equal(field in params, false);
      return implementResult(repair);
    },
    host: async key => {
      calls.push(key);
      return { key, kind: "command", ok: true, state: "passed", exitCode: 0,
        stdout: JSON.stringify({ boundary }), stderr: "", outputPath: "/tmp/mock-host", durationMs: 1 };
    },
  });
  assert.deepEqual(calls, ["implement-claim", "implement", "review-evidence"]);
  assert.deepEqual(repaired.value.map(row => row.key), ["implement"]);
  assert.ok(repaired.emits.some(row => row.type === "pi-x-matt.review-pending"));
  const review = buildDispatchRequest(registry, workflow, "shared", ROOT, tasks, evidence, undefined,
    { implementResult: repaired.value[0], boundary });
  assert.deepEqual(review.hostCommands, []);
  assert.equal(validateWorkflowScript(review.rpcParams.script).ok, true);
  calls.length = 0;
  const reviewed = await runWorkflowScript({
    script: review.rpcParams.script, timeoutMs: 5000, status: unexpectedStatus,
    launch: async (key, params) => {
      calls.push(key);
      assert.equal(params.context, "fresh");
      return reviewResult(review, key, "PASS");
    },
    host: async () => { throw new Error("Deferred review must not rerun writer or collector"); },
  });
  assert.deepEqual(calls, ["standards", "spec"]);
  assert.deepEqual(reviewed.value.map(row => row.key), ["implement", "standards", "spec"]);
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

test("reconsideration plans validate and merge exact decisions in the pinned native sandbox", async () => {
  const registry = await loadCurrentRegistry(ROOT);
  const workflow = registry.skills["matt-tdd"];
  const evidence = { command: "trusted-collector", path: "/tmp/review.md", controlled: true };
  const finding = {
    id: "parse", rootCauseId: "parse-order", severity: "P1", title: "validation order",
    basis: { kind: "acceptance", reference: "AC1" }, evidence: "null reaches normalize",
    expected: "reject null", actual: "throws", locations: ["parser.mjs:1"],
    classification: "original", relatedFindingIds: [], affectedBy: [], recommendation: "validate first",
  };
  const implemented = {
    key: "implement", ok: true, artifactPaths: [],
    structuredOutput: {
      status: "COMPLETE", summary: "implemented", residualRisks: [],
      confirmedSeams: [{ name: "parse", interface: "parse", behaviors: ["validate"] }],
      cycles: [{ test: "parse", redEvidence: "red", greenEvidence: "green", files: ["parser.mjs"] }],
      changedFiles: ["parser.mjs"],
      commands: [{ command: "test", phase: "GREEN", exitCode: 0, testCount: 1, outcome: "passed" }],
    },
  };
  const standards = {
    key: "standards", ok: true, artifactPaths: [evidence.path],
    structuredOutput: { axis: "standards", verdict: "PASS", summary: "standards pass", findings: [], notes: [] },
  };
  const spec = {
    key: "spec", ok: true, artifactPaths: [evidence.path],
    structuredOutput: { axis: "spec", verdict: "FAIL", summary: "spec fail", findings: [finding], notes: [] },
  };
  const targets = [{ ...finding, id: "spec:parse", axis: "spec", reason: "disputed", challengeEvidence: "ticket AC1" }];
  const plan = buildDispatchRequest(registry, workflow, "shared", ROOT,
    { implement: "Implementation", standards: "Standards only", spec: "Spec only" }, evidence, undefined, {
      reconsider: {
        keys: ["spec"], targets, results: [implemented, standards, spec], history: {},
        candidateSnapshotId: "snapshot", dispatchId: "reconsider-dispatch",
      },
    });
  assert.equal(validateWorkflowScript(plan.rpcParams.script).ok, true);
  assert.deepEqual(plan.lanes.map(lane => lane.key), ["spec"]);
  assert.equal(plan.hostCommands.length, 0);
  assert.match(plan.lanes[0].task, /spec:parse/);
  assert.deepEqual(plan.lanes[0].outputSchema.properties.decisions.items.properties.decision.enum,
    ["uphold", "withdraw"]);

  const decision = decisions => ({
    key: "spec", ok: true, artifactPaths: [],
    structuredOutput: { axis: "spec", decisions },
  });
  await withPersistedWorkflow(plan,
    key => {
      assert.equal(key, "spec");
      return decision([{ findingId: "spec:parse", decision: "withdraw",
        justification: "accepted behavior says optional", evidence: "ticket AC1" }]);
    },
    ({ persisted, results, calls, failure }) => {
      assert.equal(failure, undefined);
      assert.equal(persisted.state, "complete");
      assert.deepEqual(calls, ["spec"], "no writer, host collector or other axis runs");
      assert.deepEqual(results.map(result => result.key), ["implement", "standards", "spec"]);
      assert.equal(results[1].structuredOutput.verdict, "PASS");
      assert.deepEqual(results[2].structuredOutput, { ...spec.structuredOutput, verdict: "PASS", findings: [] });
      assert.equal(results[2].reconsiderationHistory[0].effectiveVerdict, "PASS");
    });

  const standardsFail = { ...standards, structuredOutput: {
    ...standards.structuredOutput, verdict: "FAIL",
    findings: [{ ...finding, basis: { kind: "standard", reference: "S1" } }],
  } };
  const standardsPlan = buildDispatchRequest(registry, workflow, "shared", ROOT,
    { implement: "Implementation", standards: "Standards only", spec: "Spec only" }, evidence, undefined, {
      reconsider: { keys: ["standards"],
        targets: [{ ...standardsFail.structuredOutput.findings[0], id: "standards:parse", axis: "standards",
          reason: "disputed", challengeEvidence: "S1" }],
        results: [implemented, standardsFail, { ...spec, structuredOutput: {
          ...spec.structuredOutput, verdict: "PASS", findings: [],
        } }], candidateSnapshotId: "snapshot", dispatchId: "standards-reconsider",
      },
    });
  for (const outcome of ["withdraw", "uphold"]) {
    await withPersistedWorkflow(standardsPlan,
      key => ({ key, ok: true, structuredOutput: { axis: "standards", decisions: [{
        findingId: "standards:parse", decision: outcome, justification: "S1 interpretation", evidence: "S1",
      }] } }),
      ({ persisted, results, calls, failure }) => {
        assert.equal(failure, undefined, "a valid decision is not an execution or schema failure");
        assert.equal(persisted.state, "complete");
        assert.deepEqual(calls, ["standards"]);
        assert.equal(results[1].structuredOutput.verdict, outcome === "withdraw" ? "PASS" : "FAIL");
        const applied = persisted.workflow.emits.find(row => row.type === "pi-x-matt.reconsideration-complete");
        assert.equal(applied.reviewPassed, outcome === "withdraw");
        assert.deepEqual(applied.remainingFindingIds, outcome === "withdraw" ? [] : ["standards:parse"]);
      });
  }

  let failedResults;
  await withPersistedWorkflow(plan,
    key => {
      assert.equal(key, "spec");
      return decision([{ findingId: "standards:parse", decision: "withdraw",
        justification: "wrong axis", evidence: "wrong axis" }]);
    },
    ({ persisted, results, failure, calls }) => {
      assert.match(failure.message, /reconsideration contract invalid/i);
      assert.equal(persisted.state, "failed");
      assert.deepEqual(calls, ["spec"]);
      assert.equal(results[2].ok, false);
      assert.equal(results[2].contractError.kind, "reconsideration");
      assert.equal(results[2].reconsiderationHistory.at(-1).decisionError.length > 0, true);
      assert.equal(results[1].structuredOutput.verdict, "PASS", "the other axis is preserved");
      failedResults = results;
    });
  const correction = buildDispatchRequest(registry, workflow, "shared", ROOT,
    { implement: "Implementation", standards: "Standards only", spec: "Spec only" }, evidence, undefined, {
      reconsider: {
        keys: ["spec"], targets, results: [implemented, standards, spec], priorResults: failedResults,
        history: { spec: failedResults[2].reconsiderationHistory }, recovery: true, correctionKeys: ["spec"],
        candidateSnapshotId: "snapshot", dispatchId: "corrected-reconsideration",
      },
    });
  assert.equal(validateWorkflowScript(correction.rpcParams.script).ok, true);
  await withPersistedWorkflow(correction,
    () => decision([{ findingId: "spec:parse", decision: "withdraw", justification: "AC1 applies", evidence: "AC1" }]),
    ({ results, calls, failure }) => {
      assert.equal(failure, undefined);
      assert.deepEqual(calls, ["spec"]);
      assert.deepEqual(results[1], standards);
      assert.deepEqual(results[2].correctionHistory[0], failedResults[2]);
      assert.equal(results[2].structuredOutput.verdict, "PASS");
    });
  const { formatStructuredOutputRejectionError } =
    await import(pathToFileURL(join(SOURCE_DIR, "runs/shared/structured-output.js")));
  // The SDK supplies TypeBox at runtime; this peer-omitted suite tests its rejection projection, not the compiler.
  const runtimeError = formatStructuredOutputRejectionError([{
    role: "toolResult", toolName: "structured_output", isError: true,
    content: [{ type: "text", text: "Structured output validation failed: /decisions/0/decision must be uphold or withdraw" }],
  }]);
  await withPersistedWorkflow(plan,
    key => ({ key, ok: false, error: runtimeError,
      results: [{ structuredOutputFailed: true, exitCode: 1, error: runtimeError }] }),
    ({ results, calls, failure }) => {
      assert.ok(failure);
      assert.deepEqual(calls, ["spec"]);
      assert.equal(results[2].ok, false);
      assert.equal(results[2].contractError.kind, "structured-output");
      assert.equal(results[2].structuredOutput, undefined);
      assert.deepEqual(results[1], standards);
    });
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

test("committed review runs one host capture before both read-only lanes in the pinned sandbox", async () => {
  const registry = await loadCurrentRegistry(ROOT);
  const committed = {
    committed: true, kind: "committed", path: "/tmp/host-owned/review.md",
    fixedPoint: "a".repeat(40), head: "b".repeat(40), command: "trusted-committed-collector",
  };
  const workflow = registry.skills["matt-code-review"];
  const laneTasks = { standards: "Standards evidence only", spec: "Spec inline source: AC1 committed range" };
  const plan = buildDispatchRequest(registry, workflow, "shared review facts", ROOT, laneTasks, committed);
  assert.deepEqual(plan.hostCommands, [{ key: "review-evidence", command: committed.command }]);
  assert.equal(validateWorkflowScript(plan.rpcParams.script).ok, true);
  const calls = [], seen = [];
  const result = await runWorkflowScript({
    script: plan.rpcParams.script, timeoutMs: 5000, status: unexpectedStatus,
    launch: async (key, params) => {
      calls.push(key);
      seen.push({ key, params });
      return reviewResult(plan, key, "PASS");
    },
    host: async (key, params) => {
      calls.push(key);
      assert.equal(key, "review-evidence");
      assert.equal(params.command, committed.command);
      return { key, kind: "command", ok: true, state: "passed", exitCode: 0, stderr: "",
        stdout: JSON.stringify({ path: committed.path, fixedPoint: committed.fixedPoint, head: committed.head, complete: true }),
        outputPath: "/tmp/mock-committed-host", durationMs: 1 };
    },
  });
  assert.deepEqual(calls, ["review-evidence", "standards", "spec"]);
  assert.ok(seen.every(item => item.params.task.includes(committed.path)));
  assert.match(seen.find(item => item.key === "spec").params.task, /Spec inline source: AC1 committed range/);
  assert.doesNotMatch(seen.find(item => item.key === "standards").params.task, /Spec inline source/);
  assert.ok(result.value.every(row => row.artifactPaths.includes(committed.path)));

  calls.length = 0;
  await assert.rejects(() => runWorkflowScript({
    script: plan.rpcParams.script, timeoutMs: 5000, status: unexpectedStatus,
    launch: async () => { calls.push("reviewer"); return successfulResult(plan, "standards"); },
    host: async key => {
      calls.push(key);
      return { key, kind: "command", ok: false, state: "failed", exitCode: 1,
        stdout: "", stderr: "incomplete committed evidence", outputPath: "/tmp/mock-committed-host", durationMs: 1 };
    },
  }), /incomplete committed evidence/);
  assert.deepEqual(calls, ["review-evidence"], "a failed committed capture launches no reviewer");
});

test("actual committed dispatch resolves through the public resource and real host before mock reviewers", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "matt-committed-public-"));
  const entries = [];
  const sessionId = "committed-public-session";
  let captured;
  const runtime = createImplementationRuntime({
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data: structuredClone(data) }),
    events: { emit() {} },
    sendUserMessage() {},
  }, ROOT, {
    rpc: async (method, params) => {
      assert.equal(method, "spawn");
      captured = params;
      return { details: {} };
    },
  });
  const ctx = {
    cwd, hasUI: true, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => sessionId, getBranch: () => entries },
    ui: { confirm: async () => true },
  };
  runtime.start(ctx, "startup");
  const resource = registerWorkflowResource({
    sessionId,
    definition: { name: "pi-x-matt.tdd", version: 1, resolve: args => runtime.resolve(args) },
  });
  const evidence = [];
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  try {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "settings.json"), "{}");
    git("init", "-q");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Test");
    await writeFile(join(cwd, "tracked.txt"), "before\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const fixedPoint = git("rev-parse", "HEAD");
    await writeFile(join(cwd, "tracked.txt"), "after\n");
    git("commit", "-qam", "feature");
    const head = git("rev-parse", "HEAD");
    const laneTasks = { standards: "Standards evidence only", spec: "Spec inline source: PUBLIC-CHAIN-MARKER" };
    const queued = await runtime.dispatch({
      workflow: "matt-code-review", task: "shared review facts", laneTasks,
      reviewScope: { kind: "committed", fixedPoint },
    }, undefined, ctx);
    evidence.push(dirname(queued.details.reviewEvidencePath));
    await runtime.flush();
    assert.equal(captured.workflow, "pi-x-matt.tdd");
    assert.equal(captured.args.dispatchId, queued.details.dispatchId);
    assert.equal("script" in captured, false);

    const resolved = resolveWorkflowResource("pi-x-matt.tdd", { dispatchId: queued.details.dispatchId }, sessionId);
    assert.equal(resolved.ok, true);
    assert.equal(validateWorkflowScript(resolved.resource.script).ok, true);
    const calls = [], seen = [];
    let packPath;
    const result = await runWorkflowScript({
      script: resolved.resource.script, timeoutMs: 5000, status: unexpectedStatus,
      launch: async (key, params) => {
        calls.push(key);
        seen.push({ key, params });
        return { key, ok: true, artifactPaths: [], structuredOutput: {
          axis: key, verdict: "PASS", summary: `${key} pass`, findings: [], notes: [],
        } };
      },
      host: async (key, params) => {
        calls.push(key);
        assert.equal(key, "review-evidence");
        const stdout = execFileSync("/bin/sh", ["-c", params.command], { cwd, encoding: "utf8" });
        packPath = JSON.parse(stdout).path;
        return { key, kind: "command", ok: true, state: "passed", exitCode: 0, stdout, stderr: "",
          outputPath: "/tmp/mock-public-committed", durationMs: 1 };
      },
    });
    assert.deepEqual(calls, ["review-evidence", "standards", "spec"]);
    assert.ok(seen.every(item => item.params.task.includes(packPath)));
    assert.match(seen.find(item => item.key === "spec").params.task, /PUBLIC-CHAIN-MARKER/);
    assert.doesNotMatch(seen.find(item => item.key === "standards").params.task, /PUBLIC-CHAIN-MARKER/);
    assert.ok(result.value.every(row => row.artifactPaths.includes(packPath)));
    const pack = JSON.parse(await readFile(packPath.replace(/\.md$/, ".json"), "utf8"));
    assert.equal(pack.fixedPoint, fixedPoint);
    assert.equal(pack.head, head);

    const second = await runtime.dispatch({
      workflow: "matt-code-review", task: "shared review facts", laneTasks,
      reviewScope: { kind: "committed", fixedPoint },
    }, undefined, ctx);
    evidence.push(dirname(second.details.reviewEvidencePath));
    await runtime.flush();
    const secondResource = resolveWorkflowResource("pi-x-matt.tdd", { dispatchId: second.details.dispatchId }, sessionId);
    assert.equal(secondResource.ok, true);
    git("commit", "--allow-empty", "-qm", "moved after admission");
    const failedLaunches = [];
    const reviewMock = key => ({ key, ok: true, artifactPaths: [], structuredOutput: {
      axis: key, verdict: "PASS", summary: `${key} pass`, findings: [], notes: [],
    } });
    await assert.rejects(() => runWorkflowScript({
      script: secondResource.resource.script, timeoutMs: 5000, status: unexpectedStatus,
      launch: async key => { failedLaunches.push(key); return reviewMock(key); },
      host: async (key, params) => {
        const stdout = execFileSync("/bin/sh", ["-c", params.command], { cwd, encoding: "utf8" });
        return { key, kind: "command", ok: true, state: "passed", exitCode: 0, stdout, stderr: "",
          outputPath: "/tmp/mock-public-committed", durationMs: 1 };
      },
    }), /HEAD changed/i);
    assert.deepEqual(failedLaunches, [], "drifted committed host capture launches no reviewer");
  } finally {
    resource.dispose();
    runtime.shutdown();
    for (const directory of evidence) await rm(directory, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});
