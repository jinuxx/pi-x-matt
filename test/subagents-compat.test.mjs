import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { registerWorkflowResource } from "pi-subagents/workflow-resources";
import { buildDispatchRequest, loadCurrentRegistry } from "../lib/dispatcher-core.mjs";
import { resolveReviewWorkflow } from "../lib/review-workflow.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const API_DIR = dirname(require.resolve("pi-subagents/workflow-resources"));
const PACKAGE_ROOT = resolve(API_DIR, "../..");
// Exercise the pinned runtime's real parser/sandbox and notification formatter,
// without launching child sessions, running host commands, or calling models.
const { runWorkflowScript, validateWorkflowScript } = await import(pathToFileURL(join(API_DIR, "../workflows/scripted-workflow.js")));
const { resolveWorkflowResource } = await import(pathToFileURL(join(API_DIR, "../workflows/workflow-resources.js")));
const { buildCompletionDetails, formatSingleCompletion } = await import(pathToFileURL(join(API_DIR, "../runs/background/notify.js")));

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
