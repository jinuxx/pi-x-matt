import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { createImplementationRuntime } from "../lib/implementation-runtime.mjs";
import { IMPLEMENTATION_ENTRY } from "../lib/repair-contract.mjs";
import { resolveImplementationScope } from "../lib/dispatch-authorization.mjs";

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const worker = {
  status: "COMPLETE", summary: "implemented", confirmedSeams: [{ name: "parse", interface: "parse", behaviors: ["validate"] }],
  cycles: [{ test: "parse", redEvidence: "red", greenEvidence: "green", files: ["parser.mjs"] }],
  changedFiles: ["parser.mjs"], commands: [{ command: "test", phase: "GREEN", exitCode: 0, testCount: 1, outcome: "green" }],
};
const finding = {
  id: "parse", rootCauseId: "parse-order", severity: "P1", title: "validation order",
  basis: { kind: "acceptance", reference: "AC1" }, evidence: "null reaches normalize",
  expected: "reject null", actual: "throws", locations: ["parser.mjs:1"],
  classification: "original", relatedFindingIds: [], affectedBy: [], recommendation: "validate first",
};
const review = (axis, fail = false) => ({ key: axis, ok: true,
  structuredOutput: { axis, verdict: fail ? "FAIL" : "PASS", summary: "review", findings: fail ? [finding] : [], notes: [] } });

async function fixture(run) {
  const cwd = await mkdtemp(join(tmpdir(), "matt-runtime-project-"));
  const artifacts = await mkdtemp(join(tmpdir(), "matt-runtime-status-"));
  const entries = [], launches = [], notices = [];
  let prompts = 0, runtime;
  const ctx = {
    cwd, hasUI: true, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "host-session", getBranch: () => entries },
    ui: { confirm: async () => { prompts++; return true; } },
  };
  const pi = {
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data: structuredClone(data) }),
    events: { emit() {} }, sendUserMessage: text => notices.push(text),
  };
  const reload = () => {
    runtime = createImplementationRuntime(pi, ROOT, {
      rpc: async (method, params) => {
        assert.equal(method, "spawn");
        const plan = runtime.resolve(params.args);
        assert.ok(plan.script, plan.error);
        const runId = `run-${launches.length}`, asyncDir = join(artifacts, runId);
        await mkdir(asyncDir);
        await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId, state: "running" }));
        launches.push({ ...plan, runId, asyncDir });
        return { details: { runId, asyncDir } };
      },
    });
    runtime.start(ctx, entries.length ? "reload" : "startup");
    return runtime;
  };
  const params = {
    workflow: "matt-tdd", task: "shared parser contract",
    laneTasks: { implement: "implement parser", standards: "standards only", spec: "AC1 only" },
    implementation: { ticket: "slice:parser", scope: "preserve parser contract", allowedFiles: ["parser.mjs"] },
  };
  const settle = async ({ fail = false, executionFailure = false, value = "patched\n" } = {}) => {
    const launch = launches.at(-1), calls = [], emits = [];
    const runs = {
      all: async items => {
        calls.push(...items.map(item => item.key));
        const results = [];
        for (const item of items) {
          if (item.key === "implement") {
            await writeFile(join(cwd, "parser.mjs"), value);
            results.push({ key: "implement", ok: true, structuredOutput: worker });
          } else if (item.key === "spec" && executionFailure) {
            results.push({ key: "spec", ok: false, error: "fetch failed" });
          } else results.push(review(item.key, item.key === "spec" && fail));
        }
        return results;
      },
      host: async (key, options) => {
        calls.push(key === "implement-claim" ? "claim" : "evidence");
        return exec("/bin/sh", ["-c", options.command], { cwd });
      },
    };
    const status = { runId: launch.runId, state: "running", workflow: { emits } };
    try {
      const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
      status.workflow.value = await new AsyncFunction("runs", "emit", launch.script)(runs, value => emits.push(value));
      status.state = "complete";
    } catch (error) {
      status.state = "failed";
      status.error = error.message;
    }
    await writeFile(join(launch.asyncDir, "status.json"), JSON.stringify(status));
    await runtime.completion({ runId: launch.runId });
    return { calls, status };
  };
  try {
    await mkdir(join(cwd, ".pi"));
    await writeFile(join(cwd, ".pi", "settings.json"), "{}");
    await writeFile(join(cwd, "parser.mjs"), "original\n");
    for (const args of [["init", "-q"], ["config", "user.email", "test@example.invalid"],
      ["config", "user.name", "Test"], ["add", "."], ["commit", "-qm", "baseline"]]) await exec("git", args, { cwd });
    reload();
    await run({ ctx, pi, params, entries, launches, notices, reload, settle,
      get runtime() { return runtime; }, get prompts() { return prompts; } });
  } finally {
    const evidenceDirs = new Set(entries.filter(entry => entry.customType === IMPLEMENTATION_ENTRY)
      .map(entry => entry.data.evidence?.path).filter(Boolean).map(dirname));
    for (const path of evidenceDirs) await rm(path, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
    await rm(artifacts, { recursive: true, force: true });
  }
}

test("host reload restores the exact grant and repair lineage without repeating authorization", async () => {
  await fixture(async f => {
    const initial = await f.runtime.dispatch(f.params, undefined, f.ctx);
    await assert.rejects(() => f.runtime.dispatch(f.params, undefined, f.ctx), /still active/);
    await f.runtime.flush();
    const first = await f.settle({ fail: true });
    assert.equal(first.status.state, "failed");
    f.reload();
    const repair = await f.runtime.dispatch({ ...f.params, repair: {
      previousDispatchId: initial.details.dispatchId,
      groups: [{ id: "parser", findingIds: ["spec:parse"], contract: "validate first",
        preserve: ["valid text"], validationOrder: "validate -> normalize -> parse",
        callPath: ["public -> parser"], examples: ["null rejects"] }],
    } }, undefined, f.ctx);
    assert.equal(repair.details.authorization, "reused-implement-grant");
    assert.equal(f.prompts, 1);
    await f.runtime.flush();
    const second = await f.settle({ value: "fixed\n" });
    assert.equal(second.status.state, "complete");
    const pack = JSON.parse(await readFile(f.entries.filter(entry => entry.customType === IMPLEMENTATION_ENTRY).at(-1).data.evidence.snapshotPath, "utf8"));
    assert.deepEqual(pack.incremental.approvedFindingIds, ["spec:parse"]);
    assert.deepEqual(pack.incremental.changes.map(change => change.path), ["parser.mjs"]);
  });
});

test("failed reviewer recovery reuses the snapshot and never starts implement, evidence or the passing axis", async () => {
  await fixture(async f => {
    const initial = await f.runtime.dispatch(f.params, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ executionFailure: true });
    f.reload();
    await f.runtime.dispatch({ ...f.params, recovery: { dispatchId: initial.details.dispatchId, lanes: ["spec"] } }, undefined, f.ctx);
    await f.runtime.flush();
    const recovered = await f.settle();
    assert.deepEqual(recovered.calls, ["spec"]);
    assert.equal(recovered.status.state, "complete");
    assert.deepEqual(recovered.status.workflow.value.map(result => result.key), ["implement", "standards", "spec"]);
    assert.equal(recovered.status.workflow.value[2].recoveryHistory[0].error, "fetch failed");
    assert.equal(f.prompts, 1);
  });
});

test("replaying an admitted script cannot launch the writer again", async () => {
  await fixture(async f => {
    await f.runtime.dispatch(f.params, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ fail: true });
    let writerCalls = 0;
    const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
    await assert.rejects(() => new AsyncFunction("runs", "emit", f.launches[0].script)({
      all: async () => { writerCalls++; throw new Error("must not launch"); },
      host: async (_key, options) => exec("/bin/sh", ["-c", options.command], { cwd: f.ctx.cwd }),
    }, () => {}), /EEXIST/);
    assert.equal(writerCalls, 0);
  });
});

test("session-tree changes, parent cancellation and reloaded queued work cannot launch a writer", async () => {
  await fixture(async f => {
    await f.runtime.dispatch(f.params, undefined, f.ctx);
    f.runtime.revoke("session-tree-changed");
    await f.runtime.flush();
    assert.equal(f.launches.length, 0);
    f.reload();
    const controller = new AbortController();
    await f.runtime.dispatch(f.params, controller.signal, f.ctx);
    controller.abort();
    await f.runtime.flush();
    assert.equal(f.launches.length, 0);
    await f.runtime.dispatch(f.params, undefined, f.ctx);
    f.reload();
    await f.runtime.flush();
    assert.equal(f.launches.length, 0);
  });
});

test("native trace events report reviewer execution separately from settlement and survive reload without duplication", async () => {
  await fixture(async f => {
    await f.runtime.dispatch(f.params, undefined, f.ctx);
    await f.runtime.flush();
    const launch = f.launches[0];
    await writeFile(join(launch.asyncDir, "status.json"), JSON.stringify({
      runId: launch.runId, state: "running", workflow: { trace: [
        { operation: "run", key: "spec", state: "failed", durationMs: 900000, error: "Subagent timed out after 900000ms." },
        { operation: "run", key: "spec-settlement", state: "failed", durationMs: 300000, error: "fetch failed" },
      ] },
    }));
    await f.runtime.progress();
    const native = () => f.entries.filter(entry => entry.customType === "pi-x-matt.dispatch-phase" &&
      Number.isInteger(entry.data.nativeTraceIndex));
    assert.deepEqual(native().map(entry => [entry.data.phase, entry.data.durationMs, entry.data.configuredTimeoutMs]),
      [["execution", 900000, 900000], ["settlement", 300000, 300000]]);
    f.reload();
    await f.runtime.progress();
    assert.equal(native().length, 2);
  });
});

test("ticket digests are read by the host, including ignored artifacts, and shipped references fail closed", async () => {
  await fixture(async f => {
    const ticket = ".x-matt/work/feature/ticket.md";
    await mkdir(join(f.ctx.cwd, ".x-matt/work/feature"), { recursive: true });
    await writeFile(join(f.ctx.cwd, ".git/info/exclude"), ".x-matt/\n");
    await writeFile(join(f.ctx.cwd, ticket), "# Ticket\nAC1: reject null\n");
    const input = { ...f.params.implementation, ticket, ticketDigest: "model-provided-authorization" };
    const first = await resolveImplementationScope(f.ctx.cwd, input);
    assert.notEqual(first.ticketDigest, input.ticketDigest);
    await writeFile(join(f.ctx.cwd, ticket), "# Ticket\nAC1: accept null\n");
    const changed = await resolveImplementationScope(f.ctx.cwd, input);
    assert.notEqual(first.ticketDigest, changed.ticketDigest);
    await assert.rejects(() => resolveImplementationScope(f.ctx.cwd,
      { ...input, ticket: ".x-matt/work/shipped/../feature/ticket.md" }), /shipped history/);
  });
});
