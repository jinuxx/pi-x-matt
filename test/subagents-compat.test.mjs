import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { registerWorkflowResource } from "pi-subagents/workflow-resources";
import { loadCurrentRegistry } from "../lib/dispatcher-core.mjs";
import { resolveReviewWorkflow } from "../lib/review-workflow.mjs";
import { buildDispatchRequest } from "./helpers/dispatch-plan.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const PACKAGE_ROOT = resolve(dirname(require.resolve("pi-subagents/workflow-resources")), "..");
const SOURCE_DIR = join(PACKAGE_ROOT, "src");

const { runWorkflowScript, validateWorkflowScript } = await import(pathToFileURL(join(SOURCE_DIR, "workflows/scripted-workflow.js")));
const { resolveWorkflowResource } = await import(pathToFileURL(join(SOURCE_DIR, "workflows/workflow-resources.js")));
const { reconcileAsyncRun } = await import(pathToFileURL(join(SOURCE_DIR, "runs/background/stale-run-reconciler.js")));
const { readProcessTerminal } = await import(pathToFileURL(join(SOURCE_DIR, "runs/background/process-terminal.js")));

const unexpectedStatus = async () => { throw new Error("Unexpected status call"); };

test("live child keeps pending terminal proof and orphaned child reconciles to observer-unavailable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-matt-terminal-race-"));
  try {
    const runId = "matt-terminal-race";
    const resultsDir = join(directory, "results");
    const asyncDir = join(directory, runId);
    const statusPath = join(asyncDir, "status.json");
    const pending = { version: 1, state: "pending", runId, runnerProcessInstanceId: "runner-live" };
    const running = {
      lifecycleArtifactVersion: 3, runId, mode: "single", state: "running", pid: 12345,
      pidNamespaceScope: "test-scope", startedAt: 1000, lastUpdate: 1500,
      processTerminal: pending, steps: [{ agent: "matt-researcher", status: "running", startedAt: 1000 }],
    };
    await mkdir(asyncDir);
    await mkdir(resultsDir);
    await writeFile(statusPath, JSON.stringify(running));
    await writeFile(join(resultsDir, `${runId}.json`), JSON.stringify({ id: runId, success: true, state: "complete" }));
    const live = reconcileAsyncRun(asyncDir, { resultsDir, now: () => 2000, kill: () => true, pidNamespaceScope: () => "test-scope" });
    assert.equal(live.repaired, false);
    assert.equal(live.status.state, "running");

    const gone = () => { throw Object.assign(new Error("No such process"), { code: "ESRCH" }); };
    await writeFile(join(asyncDir, "process-terminal.json"), JSON.stringify(pending));
    await writeFile(statusPath, JSON.stringify({ ...running, state: "complete", endedAt: 1500 }));
    reconcileAsyncRun(asyncDir, { resultsDir, now: () => 2000, kill: gone, pidNamespaceScope: () => "test-scope" });
    assert.equal(readProcessTerminal(asyncDir, pending).reason, "observer-unavailable");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("precise MCP grants exclude ambient tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-matt-mcp-grant-"));
  try {
    const script = `
      import assert from "node:assert/strict";
      import { resolveMcpDirectToolResolution } from
        ${JSON.stringify(pathToFileURL(join(SOURCE_DIR, "runs/shared/mcp-direct-tool-allowlist.js")).href)};
      const host = {
        getCommands: () => [{ name: "mcp", sourceInfo: { path: "builtin:mcp" } }],
        getAllTools: () => ["web_search_exa", "web_fetch_exa", "unapproved_write"].map(name => ({ name: "mcp__exa__" + name, namespace: { name: "mcp__exa" } })),
        getMcpServers: () => [{ name: "exa" }],
      };
      const grant = resolveMcpDirectToolResolution(["exa/web_search_exa", "exa/web_fetch_exa"], process.cwd(), host);
      assert.deepEqual(grant.unresolvedSelectors, []);
      assert.deepEqual(grant.selections.map(row => row.name), ["mcp__exa__web_search_exa", "mcp__exa__web_fetch_exa"]);
    `;
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: directory, encoding: "utf8",
      env: { ...process.env, PI_CODING_AGENT_DIR: join(directory, "user") },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("all registered workflows pass pi-subagents@0.90.0 script validation", async () => {
  const registry = await loadCurrentRegistry(ROOT);
  for (const name of ["matt-tdd", "matt-code-review", "matt-research", "matt-prototype", "architecture-scan", "architecture-design"]) {
    const plan = buildDispatchRequest(registry, registry.skills[name], "Sandbox check", ROOT);
    const checked = validateWorkflowScript(plan.rpcParams.script);
    assert.equal(checked.ok, true, `${name}: ${JSON.stringify(checked.errors)}`);
  }
});

test("matt-tdd runs claim, worker, and verify host step in real sandbox and handles BLOCKED cleanly", async () => {
  const registry = await loadCurrentRegistry(ROOT);
  const plan = buildDispatchRequest(registry, registry.skills["matt-tdd"], "Build parser", ROOT, {
    hostControls: { claimCommand: "claim-cmd", verifyCommand: "verify-cmd" },
  });
  const checked = validateWorkflowScript(plan.rpcParams.script);
  assert.equal(checked.ok, true, JSON.stringify(checked.errors));

  const calls = [];
  const complete = await runWorkflowScript({
    script: plan.rpcParams.script, timeoutMs: 5000, status: unexpectedStatus,
    launch: async (key, params) => {
      calls.push(`launch:${key}`);
      assert.equal(params.agent, "matt-worker");
      return {
        key, ok: true, output: "", artifactPaths: [],
        structuredOutput: {
          status: "COMPLETE", summary: "ok", confirmedSeams: [], cycles: [], changedFiles: ["a.js"], commands: [], residualRisks: [],
        },
      };
    },
    host: async (key) => {
      calls.push(`host:${key}`);
      return {
        key, kind: "command", ok: true, state: "passed", exitCode: 0, stderr: "",
        outputPath: "/tmp/out", durationMs: 1,
        stdout: key === "verify" ? JSON.stringify({ ok: true, results: [{ command: "npm test", ok: true, exitCode: 0 }] }) : '{"claimed":true}',
      };
    },
  });
  assert.deepEqual(calls, ["host:implement-claim", "launch:implement", "host:verify"]);
  assert.equal(complete.value[0].hostVerification.ok, true);

  // BLOCKED returns cleanly without throwing or running verify
  const blockedCalls = [];
  const blocked = await runWorkflowScript({
    script: plan.rpcParams.script, timeoutMs: 5000, status: unexpectedStatus,
    launch: async (key) => {
      blockedCalls.push(`launch:${key}`);
      return {
        key, ok: true, output: "", artifactPaths: [],
        structuredOutput: {
          status: "BLOCKED", summary: "need info", confirmedSeams: [], cycles: [], changedFiles: [], commands: [], residualRisks: [],
        },
      };
    },
    host: async (key) => {
      blockedCalls.push(`host:${key}`);
      return { key, kind: "command", ok: true, state: "passed", exitCode: 0, stderr: "", outputPath: "/tmp/out", durationMs: 1, stdout: '{"claimed":true}' };
    },
  });
  assert.deepEqual(blockedCalls, ["host:implement-claim", "launch:implement"]);
  assert.equal(blocked.value[0].structuredOutput.status, "BLOCKED");
});

test("matt-code-review runs shared evidence pack and returns advisory ISSUES without failing workflow", async () => {
  const registry = await loadCurrentRegistry(ROOT);
  const plan = buildDispatchRequest(registry, registry.skills["matt-code-review"], "Review PR", ROOT, {
    hostControls: { evidenceKind: "worktree", evidenceCommand: "collect-cmd", evidencePath: "/tmp/review.md" },
  });
  assert.equal(validateWorkflowScript(plan.rpcParams.script).ok, true);

  const plans = new Map([["d-review", plan]]);
  const registration = registerWorkflowResource({
    sessionId: "compat-session",
    definition: { name: "pi-x-matt.dispatch", version: 1, resolve: (args) => resolveReviewWorkflow(plans, args) },
  });
  try {
    const resolved = resolveWorkflowResource("pi-x-matt.dispatch", { dispatchId: "d-review" }, "compat-session");
    assert.equal(resolved.ok, true);
    assert.equal(resolved.resource.provenance.name, "pi-x-matt.dispatch");

    const seenTasks = [];
    const result = await runWorkflowScript({
      script: resolved.resource.script, timeoutMs: 5000, status: unexpectedStatus,
      host: async (key) => ({
        key, kind: "command", ok: true, state: "passed", exitCode: 0, stderr: "", outputPath: "/tmp/out", durationMs: 1,
        stdout: JSON.stringify({ path: "/tmp/review.md", head: "a".repeat(40), complete: true, changedCount: 2 }),
      }),
      launch: async (key, params) => {
        seenTasks.push(params.task);
        return {
          key, ok: true, output: "", artifactPaths: [],
          structuredOutput: {
            axis: key,
            verdict: key === "standards" ? "ISSUES" : "PASS",
            summary: `${key} done`,
            findings: key === "standards" ? [{
              severity: "P2", title: "Minor naming", locations: ["a.js:1"], evidence: "unclear name", suggestion: "rename",
            }] : [],
            notes: [],
          },
        };
      },
    });
    assert.equal(result.value.length, 2);
    assert.equal(result.value[0].structuredOutput.verdict, "ISSUES");
    assert.equal(result.value[1].structuredOutput.verdict, "PASS");
    assert.ok(seenTasks.every((task) => task.includes("/tmp/review.md")));
    assert.ok(result.value.every((row) => row.artifactPaths.includes("/tmp/review.md")));
  } finally {
    registration.dispose();
  }
});

test("timeout triggers a single settlement resume in sandbox", async () => {
  const registry = await loadCurrentRegistry(ROOT);
  const plan = buildDispatchRequest(registry, registry.skills["matt-tdd"], "Long task", ROOT);
  const calls = [];
  const result = await runWorkflowScript({
    script: plan.rpcParams.script, timeoutMs: 5000, status: unexpectedStatus,
    launch: async (key, params) => {
      calls.push({ key, resume: params.resume });
      if (key === "implement") {
        return {
          key, ok: false, runId: "writer-1", output: "", artifactPaths: [],
          terminalOutcome: { state: "partial", reason: "timeout" },
          resumability: { state: "resumable" },
        };
      }
      return {
        key, ok: true, runId: "writer-1", output: "", artifactPaths: [],
        structuredOutput: {
          status: "BLOCKED", summary: "timed out mid-way", confirmedSeams: [], cycles: [], changedFiles: ["a.js"], commands: [], residualRisks: [],
        },
      };
    },
  });
  assert.deepEqual(calls, [
    { key: "implement", resume: undefined },
    { key: "implement-settlement", resume: "writer-1" },
  ]);
  assert.equal(result.value[0].structuredOutput.status, "BLOCKED");
  assert.equal(result.value[0].recoveryHistory.length, 1);
});
