import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
const review = (axis, fail = false, item = finding) => ({ key: axis, ok: true,
  structuredOutput: { axis, verdict: fail ? "FAIL" : "PASS", summary: "review", findings: fail ? [item] : [], notes: [] } });

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
        if (params.workflow) {
          assert.equal(params.workflow, "pi-x-matt.tdd");
          assert.equal("script" in params, false);
          assert.deepEqual(Object.keys(params.args), ["dispatchId"]);
        }
        const plan = params.workflow ? runtime.resolve(params.args) : { script: params.script };
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
  const settle = async ({ fail = false, executionFailure = false, value = "patched\n", files = {}, findingOverride, workerOverride } = {}) => {
    const launch = launches.at(-1), calls = [], itemsSeen = [], emits = [];
    const runs = {
      all: async items => {
        calls.push(...items.map(item => item.key));
        itemsSeen.push(...items);
        const results = [];
        for (const item of items) {
          if (item.key === "implement") {
            await writeFile(join(cwd, "parser.mjs"), value);
            for (const [path, content] of Object.entries(files)) {
              await mkdir(dirname(join(cwd, path)), { recursive: true });
              await writeFile(join(cwd, path), content);
            }
            results.push({ key: "implement", ok: true, agent: "matt-worker",
              runId: `${launch.runId}-writer`, resumability: { state: "resumable" }, structuredOutput: worker,
              ...workerOverride });
          } else if (item.key === "spec" && executionFailure) {
            results.push({ key: "spec", ok: false, error: "fetch failed" });
          } else results.push(review(item.key, item.key === "spec" && fail, findingOverride));
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
    return { calls, status, itemsSeen };
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

test("invalid dispatch input fails before authorization, evidence preparation or queueing", async () => {
  await fixture(async f => {
    await assert.rejects(() => f.runtime.dispatch(f.params, undefined,
      { ...f.ctx, isProjectTrusted: () => false }), /untrusted project/);
    const invalid = [
      [{ ...f.params, task: " " }, /task must not be empty/],
      [{ ...f.params, laneTasks: { implement: "implementation only" } }, /requires complete laneTasks/],
      [{ ...f.params, laneTasks: { ...f.params.laneTasks, spec: " " } }, /spec must be a non-empty string/],
      [{ ...f.params, laneTasks: { ...f.params.laneTasks, unknown: "task" } }, /unknown lane/],
      [{ ...f.params, workflow: "matt-grilling" }, /not a parent orchestration workflow/],
    ];
    for (const [params, error] of invalid) {
      await assert.rejects(() => f.runtime.dispatch(params, undefined, f.ctx), error);
    }
    assert.equal(f.prompts, 0);
    assert.equal(f.runtime.plans.size, 0);
    assert.equal(f.entries.length, 0);
    await f.runtime.flush();
    assert.equal(f.launches.length, 0);
  });
});

test("TDD cannot queue or launch without user authorization", async () => {
  await fixture(async f => {
    await assert.rejects(() => f.runtime.dispatch(f.params, undefined,
      { ...f.ctx, hasUI: false }), /requires explicit user authorization/);
    await assert.rejects(() => f.runtime.dispatch(f.params, undefined,
      { ...f.ctx, ui: { confirm: async () => false } }), /not authorized by the user/);
    assert.equal(f.runtime.plans.size, 0);
    assert.equal(f.entries.some(entry => entry.customType === IMPLEMENTATION_ENTRY), false);
    await f.runtime.flush();
    assert.equal(f.launches.length, 0);
  });
});

test("ordinary dispatch queues a script without authorization and launches only on flush", async () => {
  await fixture(async f => {
    const queued = await f.runtime.dispatch({ workflow: "matt-research", task: "research only" }, undefined, f.ctx);
    assert.equal(queued.details.authorization, "not-required");
    assert.equal(f.prompts, 0);
    assert.equal(f.launches.length, 0);
    await f.runtime.flush();
    assert.equal(f.launches.length, 1);
    assert.match(f.launches[0].script, /matt-researcher/);
  });
});

test("host reload restores the exact grant and repair lineage without repeating authorization", async () => {
  await fixture(async f => {
    const initial = await f.runtime.dispatch(f.params, undefined, f.ctx);
    assert.equal(f.launches.length, 0);
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
    assert.match(repair.details.lanes.find(lane => lane.key === "implement").task, /Root-cause repair contract/);
    assert.equal(repair.details.reviewPending, true);
    assert.deepEqual(repair.details.lanes.map(lane => lane.key), ["implement"]);
    assert.equal(f.prompts, 1);
    await f.runtime.flush();
    const second = await f.settle({ value: "fixed\n" });
    assert.equal(second.status.state, "complete");
    assert.deepEqual(second.calls, ["claim", "implement", "evidence"]);
    assert.equal(second.itemsSeen[0].resume, "run-0-writer");
    for (const key of ["agent", "context", "skill", "outputSchema"]) assert.equal(key in second.itemsSeen[0], false);
    assert.deepEqual(second.status.workflow.value.map(row => row.key), ["implement"]);
    const pack = JSON.parse(await readFile(f.entries.filter(entry => entry.customType === IMPLEMENTATION_ENTRY).at(-1).data.evidence.snapshotPath, "utf8"));
    assert.deepEqual(pack.incremental.approvedFindingIds, ["spec:parse"]);
    assert.deepEqual(pack.incremental.changes.map(change => change.path), ["parser.mjs"]);
    f.reload();
    const reviewDispatch = await f.runtime.dispatch({ ...f.params,
      review: { dispatchId: repair.details.dispatchId } }, undefined, f.ctx);
    assert.equal(reviewDispatch.details.reviewPending, false);
    const standardsTask = reviewDispatch.details.lanes.find(lane => lane.key === "standards").task;
    const specTask = reviewDispatch.details.lanes.find(lane => lane.key === "spec").task;
    assert.match(specTask, /"reference":"AC1"/);
    assert.doesNotMatch(standardsTask, /"reference":"AC1"/);
    assert.doesNotMatch(standardsTask + specTask, /Root-cause repair contract/);
    await f.runtime.flush();
    const reviewed = await f.settle();
    assert.deepEqual(reviewed.calls, ["standards", "spec"]);
    assert.equal(reviewed.status.state, "complete");
    assert.deepEqual(reviewed.status.workflow.value.map(row => row.key), ["implement", "standards", "spec"]);
    assert.equal(f.prompts, 1);
  });
});

const repairGroups = [{ id: "parser", findingIds: ["spec:parse"], contract: "validate first",
  preserve: ["valid text"], validationOrder: "validate -> normalize -> parse",
  callPath: ["public -> parser"], examples: ["null rejects"] }];

test("several repairs precede one review, preserving cumulative evidence, latest writer and diagnosis counts", async () => {
  await fixture(async f => {
    const initial = await f.runtime.dispatch(f.params, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ fail: true });
    let previousId = initial.details.dispatchId;
    for (const value of ["repair one\n", "repair two\n"]) {
      const dispatch = await f.runtime.dispatch({ ...f.params, repair: {
        previousDispatchId: previousId, groups: repairGroups,
      } }, undefined, f.ctx);
      await f.runtime.flush();
      const run = await f.settle({ value });
      assert.equal(run.status.state, "complete");
      assert.deepEqual(run.calls, ["claim", "implement", "evidence"]);
      assert.equal(run.itemsSeen[0].resume, `run-${f.launches.length - 2}-writer`);
      assert.ok(run.status.workflow.emits.some(row => row.type === "pi-x-matt.review-pending"));
      previousId = dispatch.details.dispatchId;
      f.reload();
    }
    const latest = f.entries.findLast(entry => entry.customType === IMPLEMENTATION_ENTRY).data;
    const pack = JSON.parse(await readFile(latest.evidence.snapshotPath, "utf8"));
    assert.equal(pack.incremental.changes[0].before.content, "patched\n");
    assert.equal(pack.incremental.changes[0].after.content, "repair two\n");
    assert.equal(latest.repair.counts.parser, 2);
    await assert.rejects(() => f.runtime.dispatch({ ...f.params, repair: {
      previousDispatchId: previousId, groups: repairGroups,
    } }, undefined, f.ctx), /DIAGNOSIS_REQUIRED/);
    await assert.rejects(() => f.runtime.dispatch({ ...f.params,
      recovery: { dispatchId: previousId, lanes: ["spec"] } }, undefined, f.ctx), /pending.*review/i);
    await f.runtime.dispatch({ ...f.params, review: { dispatchId: previousId } }, undefined, f.ctx);
    await f.runtime.flush();
    const reviewed = await f.settle({ executionFailure: true });
    assert.deepEqual(reviewed.calls, ["standards", "spec"]);
    assert.equal(reviewed.status.state, "failed");
    const reviewId = f.entries.findLast(entry => entry.customType === IMPLEMENTATION_ENTRY).data.id;
    await f.runtime.dispatch({ ...f.params, recovery: { dispatchId: reviewId, lanes: ["spec"] } }, undefined, f.ctx);
    await f.runtime.flush();
    assert.deepEqual((await f.settle()).calls, ["spec"]);
  });
});

test("deferred review rejects missing preparation, stale references and drift instead of rerunning a writer", async () => {
  await fixture(async f => {
    await assert.rejects(() => f.runtime.dispatch({ ...f.params, review: { dispatchId: "invented" } },
      undefined, f.ctx), /latest host dispatch/);
    const initial = await f.runtime.dispatch(f.params, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ fail: true });
    await assert.rejects(() => f.runtime.dispatch({ ...f.params,
      review: { dispatchId: initial.details.dispatchId } }, undefined, f.ctx), /pending repair/i);
    const repaired = await f.runtime.dispatch({ ...f.params, repair: {
      previousDispatchId: initial.details.dispatchId, groups: repairGroups,
    } }, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ value: "fixed\n" });
    await assert.rejects(() => f.runtime.dispatch({ ...f.params,
      review: { dispatchId: initial.details.dispatchId } }, undefined, f.ctx), /latest host dispatch/);
    await writeFile(join(f.ctx.cwd, "parser.mjs"), "external change\n");
    for (const control of [
      { review: { dispatchId: repaired.details.dispatchId } },
      { repair: { previousDispatchId: repaired.details.dispatchId, groups: repairGroups } },
    ]) await assert.rejects(() => f.runtime.dispatch({ ...f.params, ...control }, undefined, f.ctx), /snapshot.*stale|snapshot.*match/i);
    await f.runtime.flush();
    assert.equal(f.launches.length, 2);
  });
});

test("a rejected formal re-review repairs its latest candidate, not the original writer or old increment", async () => {
  await fixture(async f => {
    const initial = await f.runtime.dispatch(f.params, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ fail: true });
    const repair = await f.runtime.dispatch({ ...f.params, repair: {
      previousDispatchId: initial.details.dispatchId, groups: repairGroups,
    } }, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ value: "first repair\n" });
    const reviewDispatch = await f.runtime.dispatch({ ...f.params,
      review: { dispatchId: repair.details.dispatchId } }, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ fail: true, findingOverride: { ...finding, relatedFindingIds: ["spec:parse"] } });
    const next = await f.runtime.dispatch({ ...f.params, repair: {
      previousDispatchId: reviewDispatch.details.dispatchId, groups: repairGroups,
    } }, undefined, f.ctx);
    await f.runtime.flush();
    const repaired = await f.settle({ value: "second repair\n" });
    assert.equal(repaired.itemsSeen[0].resume, "run-1-writer");
    const record = f.entries.findLast(entry => entry.customType === IMPLEMENTATION_ENTRY).data;
    const pack = JSON.parse(await readFile(record.evidence.snapshotPath, "utf8"));
    assert.equal(pack.incremental.changes[0].before.content, "first repair\n");
    assert.equal(pack.incremental.changes[0].after.content, "second repair\n");
    assert.equal(record.repair.counts.parser, 2);
    assert.equal(record.reviewSourceId, reviewDispatch.details.dispatchId);
    assert.equal(next.details.reviewPending, true);
  });
});

test("missing retained writer fails closed; blocked repairs cannot become formal review", async () => {
  await fixture(async f => {
    const initial = await f.runtime.dispatch(f.params, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ fail: true, workerOverride: { resumability: { state: "not-resumable" } } });
    await assert.rejects(() => f.runtime.dispatch({ ...f.params, repair: {
      previousDispatchId: initial.details.dispatchId, groups: repairGroups,
    } }, undefined, f.ctx), /Retained writer is unavailable/);
    await f.runtime.flush();
    assert.equal(f.launches.length, 1);
  });
  await fixture(async f => {
    const initial = await f.runtime.dispatch(f.params, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ fail: true });
    const repair = await f.runtime.dispatch({ ...f.params, repair: {
      previousDispatchId: initial.details.dispatchId, groups: repairGroups,
    } }, undefined, f.ctx);
    await f.runtime.flush();
    const blocked = await f.settle({ workerOverride: {
      structuredOutput: { ...worker, status: "BLOCKED" },
    } });
    assert.equal(blocked.status.state, "failed");
    assert.deepEqual(blocked.calls, ["claim", "implement"]);
    await assert.rejects(() => f.runtime.dispatch({ ...f.params,
      review: { dispatchId: repair.details.dispatchId } }, undefined, f.ctx), /pending repair|implementation/i);
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

test("failed isolated commands do not persist reproduction output in the diagnosis trace", async () => {
  await fixture(async f => {
    await writeFile(join(f.ctx.cwd, "parser.test.mjs"), "process.exit(0);\n");
    await exec("git", ["add", "parser.test.mjs"], { cwd: f.ctx.cwd });
    await exec("git", ["commit", "-qm", "diagnostic baseline"], { cwd: f.ctx.cwd });
    const params = { ...f.params, implementation: { ...f.params.implementation,
      allowedFiles: ["parser.mjs", "parser.test.mjs"], diagnosticFiles: ["parser.test.mjs"],
      diagnosticCommands: ["node parser.test.mjs"],
    } };
    const initial = await f.runtime.dispatch(params, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ fail: true, value: 'export const state = "reviewed";\n',
      findingOverride: { ...finding, classification: "regression" } });
    const marker = "SYNTHETIC-FAILED-REPRODUCTION-MARKER";
    const content = 'import { readFileSync } from "node:fs";\n' +
      'process.stderr.write(readFileSync(new URL(import.meta.url), "utf8"));\n' +
      `process.exit(2); // ${marker}\n`;
    let failure;
    await assert.rejects(() => f.runtime.dispatch({ ...params, repair: {
      previousDispatchId: initial.details.dispatchId,
      groups: [{ id: "parser", findingIds: ["spec:parse"], contract: "preserve reviewed state",
        preserve: ["valid input"], validationOrder: "validate -> parse",
        callPath: ["public -> parser"], examples: ["invalid input rejects"] }],
      diagnosis: { rootCauseIds: ["parser"], explanation: "diagnostic failure",
        prediction: "the approved command reports the target symptom",
        command: "node parser.test.mjs", expectedFailure: "target regression",
        testFiles: [{ path: "parser.test.mjs", content }] },
    } }, undefined, f.ctx), error => { failure = error; return error.code === 2; });
    assert.equal(failure.message.includes(marker), false);
    assert.equal(JSON.stringify(f.entries).includes(marker), false);
    const trace = f.entries.findLast(entry => entry.customType === "pi-x-matt.dispatch-phase" &&
      entry.data.phase === "diagnosis" && entry.data.state === "failed");
    assert.equal(trace.data.error.code, 2);
    assert.match(trace.data.error.message, /outputSha256=[0-9a-f]{64}/);
    await f.runtime.flush();
    assert.equal(f.launches.length, 1);
    assert.equal(f.runtime.plans.size, 0);
  });
});

test("an isolated diagnosis reproduces the regression, hands off only path/hash evidence, and preserves the original repair chain", async () => {
  await fixture(async f => {
    const green = [
      'import assert from "node:assert/strict";',
      'import { state } from "./parser.mjs";',
      'assert.ok(["head", "reviewed"].includes(state));',
      "",
    ].join("\n");
    const inlineMarker = "SYNTHETIC-INLINE-MARKER-4c7a2f18";
    const red = [
      'import assert from "node:assert/strict";',
      'import { state } from "./parser.mjs";',
      'assert.equal(state, "fixed", "target regression: parser still returns " + state);',
      `// synthetic inline marker: ${inlineMarker}`,
      "",
    ].join("\n");
    const inlineSha256 = createHash("sha256").update(red).digest("hex");
    const reviewed = 'export const state = "reviewed";\n';
    await writeFile(join(f.ctx.cwd, "parser.test.mjs"), green);
    for (const args of [["add", "."], ["commit", "-qm", "green regression check"]]) {
      await exec("git", args, { cwd: f.ctx.cwd });
    }
    const params = { ...f.params, implementation: {
      ticket: "slice:parser", scope: "preserve parser contract",
      allowedFiles: ["parser.mjs", "parser.test.mjs"], diagnosticFiles: ["parser.test.mjs"],
      diagnosticCommands: ["node parser.test.mjs"],
    } };
    const initial = await f.runtime.dispatch(params, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ fail: true, value: reviewed,
      findingOverride: { ...finding, classification: "regression" } });
    f.reload();
    assert.equal(await readFile(join(f.ctx.cwd, "parser.test.mjs"), "utf8"), green);
    const before = await exec("node", ["parser.test.mjs"], { cwd: f.ctx.cwd });
    assert.equal(before.stderr, "");
    const repair = {
      previousDispatchId: initial.details.dispatchId,
      groups: [{ id: "parser", findingIds: ["spec:parse"], contract: "validate before exposing state",
        preserve: ["reviewed module loads"], validationOrder: "validate -> expose",
        callPath: ["public -> parser"], examples: ["reviewed state is not fixed"] }],
      diagnosis: {
        rootCauseIds: ["parser"], explanation: "the reviewed module still exposes the pre-fix state",
        prediction: "the inline regression check fails on the reviewed source",
        command: "node parser.test.mjs",
        expectedFailure: "target regression: parser still returns reviewed",
        testFiles: [{ path: "parser.test.mjs", content: red }],
      },
    };
    const repairDispatch = await f.runtime.dispatch({ ...params, repair }, undefined, f.ctx);
    assert.equal(f.runtime.plans.size, 1);
    const status = await exec("git", ["status", "--porcelain"], { cwd: f.ctx.cwd });
    assert.equal(status.stdout, " M parser.mjs\n");
    assert.equal(await readFile(join(f.ctx.cwd, "parser.test.mjs"), "utf8"), green);
    const record = f.entries.filter(entry => entry.customType === IMPLEMENTATION_ENTRY).at(-1).data;
    assert.equal(record.repair.diagnosis.isolation.reviewedDispatchId, initial.details.dispatchId);
    assert.equal(record.repair.diagnosis.isolation.reviewedSnapshotId, record.repair.previousSnapshotId);
    assert.deepEqual(record.repair.diagnosis.isolation.testFiles,
      [{ path: "parser.test.mjs", sha256: inlineSha256 }]);
    assert.equal(JSON.stringify(record).includes(inlineMarker), false);
    const queuedImplement = repairDispatch.details.lanes.find(lane => lane.key === "implement");
    assert.match(queuedImplement.task, /Root-cause repair contract/);
    assert.equal(queuedImplement.task.includes(inlineMarker), false);
    assert.match(queuedImplement.task, new RegExp(inlineSha256));
    const previousRecord = f.entries.filter(entry => entry.customType === IMPLEMENTATION_ENTRY)
      .map(entry => entry.data).find(data => data.id === initial.details.dispatchId);
    const reviewedPack = JSON.parse(await readFile(previousRecord.evidence.snapshotPath, "utf8"));
    assert.equal(reviewedPack.manifest.find(entry => entry.path === "parser.mjs").content, reviewed);
    const head = await exec("git", ["show", "HEAD:parser.mjs"], { cwd: f.ctx.cwd });
    assert.notEqual(head.stdout, reviewed);
    await assert.rejects(() => f.runtime.dispatch({ ...params, repair }, undefined, f.ctx),
      /still active|latest host dispatch/);
    assert.equal(f.runtime.plans.size, 1);
    await f.runtime.flush();
    const repaired = await f.settle({ value: 'export const state = "fixed";\n' });
    assert.equal(repaired.status.state, "complete");
    const finalRecord = f.entries.filter(entry => entry.customType === IMPLEMENTATION_ENTRY).at(-1).data;
    const finalPack = JSON.parse(await readFile(finalRecord.evidence.snapshotPath, "utf8"));
    assert.deepEqual(finalPack.incremental.changes.map(change => change.path), ["parser.mjs"]);
  });
});

test("explicit reapproval amends the same-ticket file envelope without severing repair lineage", async () => {
  await fixture(async f => {
    const initial = await f.runtime.dispatch(f.params, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ fail: true });
    const widened = { ...f.params, implementation: { ...f.params.implementation,
      allowedFiles: ["parser.mjs", "parser.test.mjs"], diagnosticFiles: ["parser.test.mjs"],
      diagnosticCommands: ["node parser.test.mjs"] } };
    const first = await f.runtime.dispatch({ ...widened, repair: {
      previousDispatchId: initial.details.dispatchId, groups: repairGroups,
    } }, undefined, f.ctx);
    assert.equal(first.details.authorization, "user-confirmed");
    assert.equal(first.details.reviewPending, true);
    assert.equal(f.prompts, 2);
    await f.runtime.flush();
    const firstRun = await f.settle({ value: "repair one\n",
      files: { "parser.test.mjs": 'import assert from "node:assert/strict";\n' } });
    assert.equal(firstRun.status.state, "complete");
    assert.equal(firstRun.itemsSeen[0].resume, "run-0-writer");
    const firstRecord = f.entries.filter(entry => entry.customType === IMPLEMENTATION_ENTRY).at(-1).data;
    assert.equal(firstRecord.repair.counts.parser, 1);
    assert.deepEqual(firstRecord.repair.approvedFindingIds, ["spec:parse"]);
    f.runtime.revoke("session-tree-changed");
    f.reload();
    const replaced = { ...widened, implementation: { ...widened.implementation,
      diagnosticCommands: ["node --test parser.test.mjs"] } };
    const second = await f.runtime.dispatch({ ...replaced, repair: {
      previousDispatchId: firstRecord.id, groups: repairGroups,
    } }, undefined, f.ctx);
    assert.equal(second.details.authorization, "user-confirmed");
    assert.equal(f.prompts, 3);
    await f.runtime.flush();
    const secondRun = await f.settle({ value: "repair two\n" });
    assert.equal(secondRun.status.state, "complete");
    assert.equal(secondRun.itemsSeen[0].resume, "run-1-writer");
    const secondRecord = f.entries.filter(entry => entry.customType === IMPLEMENTATION_ENTRY).at(-1).data;
    assert.equal(secondRecord.repair.counts.parser, 2);
    assert.equal(secondRecord.reviewSourceId, initial.details.dispatchId);
    const pack = JSON.parse(await readFile(secondRecord.evidence.snapshotPath, "utf8"));
    assert.deepEqual(pack.incremental.approvedFindingIds, ["spec:parse"]);
    assert.deepEqual(pack.incremental.changes.map(change => change.path), ["parser.mjs", "parser.test.mjs"]);
    assert.equal(pack.incremental.changes[0].before.content, "patched\n");
    assert.equal(pack.incremental.changes[0].after.content, "repair two\n");
    assert.match(pack.incremental.changes[1].after.content, /node:assert/);
    f.reload();
    const third = { ...replaced, implementation: { ...replaced.implementation,
      diagnosticCommands: ["node --test --test-only parser.test.mjs"] } };
    await assert.rejects(() => f.runtime.dispatch({ ...third, repair: {
      previousDispatchId: secondRecord.id, groups: repairGroups,
    } }, undefined, f.ctx), /DIAGNOSIS_REQUIRED/);
    assert.equal(f.prompts, 4);
    assert.equal(f.runtime.plans.size, 0);
    await f.runtime.flush();
    assert.equal(f.launches.length, 3);
    f.runtime.input({ text: "/skill:matt-implement", source: "interactive" });
    await assert.rejects(() => f.runtime.dispatch({ ...replaced }, undefined, f.ctx), /already has a dispatch/);
    assert.equal(f.prompts, 4);
    await assert.rejects(() => f.runtime.dispatch({ ...replaced, repair: {
      previousDispatchId: initial.details.dispatchId, groups: repairGroups,
    } }, undefined, f.ctx), /latest host dispatch/);
    const reviewDispatch = await f.runtime.dispatch({ ...replaced,
      review: { dispatchId: secondRecord.id } }, undefined, f.ctx);
    assert.equal(reviewDispatch.details.reviewPending, false);
    assert.deepEqual(reviewDispatch.details.lanes.map(lane => lane.key), ["standards", "spec"]);
    await f.runtime.flush();
    const reviewed = await f.settle();
    assert.deepEqual(reviewed.calls, ["standards", "spec"]);
    assert.equal(reviewed.status.state, "complete");
    assert.deepEqual(reviewed.status.workflow.value.map(row => row.key), ["implement", "standards", "spec"]);
    assert.equal(f.prompts, 4);
  });
});

test("denied reapproval queues nothing and a later approved repair keeps the old lineage", async () => {
  await fixture(async f => {
    const initial = await f.runtime.dispatch(f.params, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ fail: true });
    const widened = { ...f.params, implementation: { ...f.params.implementation,
      allowedFiles: ["parser.mjs", "parser.test.mjs"], diagnosticFiles: ["parser.test.mjs"],
      diagnosticCommands: ["node parser.test.mjs"] },
      repair: { previousDispatchId: initial.details.dispatchId, groups: repairGroups } };
    const records = () => f.entries.filter(entry => entry.customType === IMPLEMENTATION_ENTRY).length;
    const before = records();
    await assert.rejects(() => f.runtime.dispatch(widened, undefined, { ...f.ctx, hasUI: false }),
      /requires explicit user authorization/);
    await assert.rejects(() => f.runtime.dispatch(widened, undefined,
      { ...f.ctx, ui: { confirm: async () => false } }), /not authorized by the user/);
    assert.equal(records(), before);
    assert.equal(f.runtime.plans.size, 0);
    await f.runtime.flush();
    assert.equal(f.launches.length, 1);
    const approved = await f.runtime.dispatch(widened, undefined, f.ctx);
    assert.equal(approved.details.authorization, "user-confirmed");
    await f.runtime.flush();
    const run = await f.settle({ value: "repair\n", files: { "parser.test.mjs": "export const checked = true;\n" } });
    assert.equal(run.status.state, "complete");
    assert.equal(run.itemsSeen[0].resume, "run-0-writer");
    assert.equal(f.launches.length, 2);
    assert.equal(f.prompts, 2);
  });
});

test("reapproval cannot change ticket content, approved behavior or remove approved files", async () => {
  await fixture(async f => {
    const initial = await f.runtime.dispatch(f.params, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ fail: true });
    const changed = { ...f.params, implementation: { ...f.params.implementation, scope: "different behavior" },
      repair: { previousDispatchId: initial.details.dispatchId, groups: repairGroups } };
    await assert.rejects(() => f.runtime.dispatch(changed, undefined, f.ctx), /approved envelope changed/);
    assert.equal(f.prompts, 2);
    await f.runtime.flush();
    assert.equal(f.launches.length, 1);
  });
  await fixture(async f => {
    const ticket = ".x-matt/work/feature/ticket.md";
    await mkdir(join(f.ctx.cwd, ".x-matt/work/feature"), { recursive: true });
    await writeFile(join(f.ctx.cwd, ".git/info/exclude"), ".x-matt/\n");
    await writeFile(join(f.ctx.cwd, ticket), "# Ticket\nAC1: reject null\n");
    const implementation = { ...f.params.implementation, ticket };
    const initial = await f.runtime.dispatch({ ...f.params, implementation }, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ fail: true });
    await writeFile(join(f.ctx.cwd, ticket), "# Ticket\nAC1: accept null\n");
    await assert.rejects(() => f.runtime.dispatch({ ...f.params, implementation,
      repair: { previousDispatchId: initial.details.dispatchId, groups: repairGroups } }, undefined, f.ctx),
      /approved envelope changed/);
    assert.equal(f.prompts, 2);
    await f.runtime.flush();
    assert.equal(f.launches.length, 1);
  });
  await fixture(async f => {
    const wide = { ...f.params.implementation, allowedFiles: ["parser.mjs", "parser.test.mjs"] };
    const initial = await f.runtime.dispatch({ ...f.params, implementation: wide }, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ fail: true });
    await assert.rejects(() => f.runtime.dispatch({ ...f.params,
      implementation: { ...wide, allowedFiles: ["parser.mjs"] },
      repair: { previousDispatchId: initial.details.dispatchId, groups: repairGroups } }, undefined, f.ctx),
      /approved envelope changed/);
    assert.equal(f.prompts, 2);
    await f.runtime.flush();
    assert.equal(f.launches.length, 1);
  });
});

test("reapproval cannot bypass branch, HEAD or candidate drift", async () => {
  await fixture(async f => {
    const initial = await f.runtime.dispatch(f.params, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ fail: true });
    await exec("git", ["checkout", "-q", "-b", "other"], { cwd: f.ctx.cwd });
    await assert.rejects(() => f.runtime.dispatch({ ...f.params, repair: {
      previousDispatchId: initial.details.dispatchId, groups: repairGroups } }, undefined, f.ctx),
      /approved envelope changed/);
    assert.equal(f.prompts, 2);
    assert.equal(f.runtime.plans.size, 0);
    await f.runtime.flush();
    assert.equal(f.launches.length, 1);
  });
  await fixture(async f => {
    const initial = await f.runtime.dispatch(f.params, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ fail: true });
    await exec("git", ["commit", "-q", "--allow-empty", "-m", "head drift"], { cwd: f.ctx.cwd });
    await assert.rejects(() => f.runtime.dispatch({ ...f.params, repair: {
      previousDispatchId: initial.details.dispatchId, groups: repairGroups } }, undefined, f.ctx),
      /approved envelope changed/);
    assert.equal(f.prompts, 2);
    await f.runtime.flush();
    assert.equal(f.launches.length, 1);
  });
  await fixture(async f => {
    const initial = await f.runtime.dispatch(f.params, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ fail: true });
    const widened = { ...f.params, implementation: { ...f.params.implementation,
      allowedFiles: ["parser.mjs", "parser.test.mjs"], diagnosticFiles: ["parser.test.mjs"],
      diagnosticCommands: ["node parser.test.mjs"] } };
    await writeFile(join(f.ctx.cwd, "parser.mjs"), "external change\n");
    await assert.rejects(() => f.runtime.dispatch({ ...widened, repair: {
      previousDispatchId: initial.details.dispatchId, groups: repairGroups } }, undefined, f.ctx),
      /stale|no longer matches/i);
    assert.equal(f.prompts, 2);
    assert.equal(f.runtime.plans.size, 0);
    await f.runtime.flush();
    assert.equal(f.launches.length, 1);
  });
});

test("regrant and reload preserve reviewer recovery budget and the passing axis", async () => {
  await fixture(async f => {
    const initial = await f.runtime.dispatch(f.params, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ executionFailure: true });
    f.reload();
    const changed = { ...f.params, implementation: { ...f.params.implementation,
      diagnosticCommands: ["node --test parser.test.mjs"] },
      recovery: { dispatchId: initial.details.dispatchId, lanes: ["spec"] } };
    await f.runtime.dispatch(changed, undefined, f.ctx);
    assert.equal(f.prompts, 2);
    await f.runtime.flush();
    const recovered = await f.settle();
    assert.deepEqual(recovered.calls, ["spec"]);
    assert.equal(recovered.status.state, "complete");
    assert.deepEqual(recovered.status.workflow.value.map(row => row.key), ["implement", "standards", "spec"]);
    assert.equal(recovered.status.workflow.value[2].recoveryHistory[0].error, "fetch failed");
    const recoveryRecord = f.entries.filter(entry => entry.customType === IMPLEMENTATION_ENTRY).at(-1).data;
    assert.equal(recoveryRecord.recoveryAttempt, 1);
    f.reload();
    const amended = { ...f.params, implementation: { ...f.params.implementation,
      diagnosticCommands: ["node --test --test-only parser.test.mjs"] },
      recovery: { dispatchId: recoveryRecord.id, lanes: ["standards"] } };
    await assert.rejects(() => f.runtime.dispatch(amended, undefined, f.ctx), /exhausted/);
    assert.equal(f.prompts, 3);
    assert.equal(f.runtime.plans.size, 0);
    await f.runtime.flush();
    assert.equal(f.launches.length, 2);
  });
});
