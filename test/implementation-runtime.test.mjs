import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { createImplementationRuntime } from "../lib/implementation-runtime.mjs";
import { IMPLEMENTATION_ENTRY } from "../lib/repair-contract.mjs";
import { resolveImplementationScope } from "../lib/dispatch-authorization.mjs";
import { batchOutcome } from "../lib/batch-authorization.mjs";

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
  const settle = async ({ fail = false, executionFailure = false, value = "patched\n", files = {}, findingOverride,
    workerOverride, reviews } = {}) => {
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
          } else if (reviews?.[item.key]) {
            results.push({ key: item.key, ok: true, artifactPaths: [], ...reviews[item.key] });
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

test("a user-confirmed ordinary P2 candidate has a separate terminal receipt without rewriting FAIL", async () => {
  await fixture(async f => {
    const initial = await f.runtime.dispatch(f.params, undefined, f.ctx);
    await f.runtime.flush();
    const minor = { ...finding, severity: "P2", basis: { kind: "standard", reference: "resource convention" } };
    await f.settle({ reviews: { standards: review("standards", true, minor), spec: review("spec") } });
    const accepted = await f.runtime.dispatch({ ...f.params, laneTasks: undefined,
      acceptRisk: { dispatchId: initial.details.dispatchId, findingIds: ["standards:parse"],
        reason: "bounded trade-off", evidence: "mitigation reviewed" },
    }, undefined, f.ctx);
    assert.equal(accepted.details.state, "accepted-risk");
    assert.equal(accepted.details.reviewPassed, false);
    assert.equal(f.prompts, 2, "implementation permission cannot approve risks");
    const record = f.entries.findLast(entry => entry.customType === IMPLEMENTATION_ENTRY).data;
    assert.equal(record.originalResults.find(row => row.key === "standards").structuredOutput.verdict, "FAIL");
    await f.runtime.flush();
    assert.equal(f.launches.length, 1, "acceptance does not run models or collect another Pack");
    f.reload();
    await assert.rejects(() => f.runtime.dispatch({ ...f.params,
      repair: { previousDispatchId: accepted.details.dispatchId, groups: repairGroups },
    }, undefined, f.ctx), /terminal with accepted risks/);
  });
});

test("changing a candidate during risk confirmation cannot authorize it", async () => {
  await fixture(async f => {
    const initial = await f.runtime.dispatch(f.params, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ reviews: { standards: review("standards", true, {
      ...finding, severity: "P2", basis: { kind: "standard", reference: "resource convention" },
    }), spec: review("spec") } });
    f.ctx.ui.confirm = async () => { await writeFile(join(f.ctx.cwd, "parser.mjs"), "drift\n"); return true; };
    await assert.rejects(() => f.runtime.dispatch({ ...f.params, laneTasks: undefined,
      acceptRisk: { dispatchId: initial.details.dispatchId, findingIds: ["standards:parse"],
        reason: "bounded trade-off", evidence: "reviewed" },
    }, undefined, f.ctx), /changed while confirming/);
    assert.equal(f.entries.filter(entry => entry.data?.state === "accepted-risk").length, 0);
  });
});

test("committed code review recovers only the failed axis after reload with no collector or writer rerun", async () => {
  await fixture(async f => {
    const fixedPoint = (await exec("git", ["rev-parse", "HEAD"], { cwd: f.ctx.cwd })).stdout.trim();
    const params = { workflow: "matt-code-review", task: "committed review",
      laneTasks: { standards: "standards only", spec: "acceptance only" },
      reviewScope: { kind: "committed", fixedPoint } };
    const initial = await f.runtime.dispatch(params, undefined, f.ctx);
    await f.runtime.flush();
    const failed = await f.settle({ reviews: { spec: { ok: false, error: "usage limit reached" } } });
    assert.deepEqual(failed.calls, ["evidence", "standards", "spec"]);
    assert.match(f.notices.at(-1), /spec=provider-limit/);
    assert.equal(f.prompts, 0);
    f.reload();
    const recovered = await f.runtime.dispatch({
      workflow: "matt-code-review", task: "recover acceptance reviewer",
      laneTasks: { spec: "complete original acceptance source" },
      recovery: { dispatchId: initial.details.dispatchId, lanes: ["spec"] },
    }, undefined, f.ctx);
    await f.runtime.flush();
    const settled = await f.settle();
    assert.deepEqual(settled.calls, ["spec"]);
    assert.equal(settled.status.state, "complete");
    assert.deepEqual(settled.status.workflow.value.find(row => row.key === "standards"),
      failed.status.workflow.emits.findLast(row => row.type === "pi-x-matt.stage-results").results.find(row => row.key === "standards"));
    await assert.rejects(() => f.runtime.dispatch({
      workflow: "matt-code-review", task: "do not replace valid verdicts", laneTasks: { spec: "spec" },
      recovery: { dispatchId: recovered.details.dispatchId, lanes: ["spec"] },
    }, undefined, f.ctx), /exhausted/);
  });
});

test("committed recovery rejects a changed original Pack or moved HEAD instead of recollecting", async () => {
  await fixture(async f => {
    const fixedPoint = (await exec("git", ["rev-parse", "HEAD"], { cwd: f.ctx.cwd })).stdout.trim();
    const initial = await f.runtime.dispatch({ workflow: "matt-code-review", task: "review",
      laneTasks: { standards: "standards", spec: "acceptance" }, reviewScope: { kind: "committed", fixedPoint },
    }, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ reviews: { spec: { ok: false, error: "fetch failed" } } });
    const retry = { workflow: "matt-code-review", task: "recover", laneTasks: { spec: "acceptance" },
      recovery: { dispatchId: initial.details.dispatchId, lanes: ["spec"] } };
    const record = f.entries.findLast(entry => entry.customType === IMPLEMENTATION_ENTRY).data;
    const markdown = await readFile(record.evidence.path);
    await chmod(record.evidence.path, 0o600);
    await writeFile(record.evidence.path, "tampered");
    await assert.rejects(() => f.runtime.dispatch(retry, undefined, f.ctx), /Pack is missing or changed/);
    await writeFile(record.evidence.path, markdown);
    await exec("git", ["commit", "--allow-empty", "-qm", "moved"], { cwd: f.ctx.cwd });
    await assert.rejects(() => f.runtime.dispatch(retry, undefined, f.ctx), /HEAD changed/);
    assert.equal(f.launches.length, 1);
  });
});

test("a committed whole-spec review can be explicitly accepted with known ordinary P2 risks without claiming PASS", async () => {
  await fixture(async f => {
    const fixedPoint = (await exec("git", ["rev-parse", "HEAD"], { cwd: f.ctx.cwd })).stdout.trim();
    const initial = await f.runtime.dispatch({ workflow: "matt-code-review", task: "whole-spec review",
      laneTasks: { standards: "standards", spec: "complete spec" }, reviewScope: { kind: "committed", fixedPoint },
    }, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ reviews: { standards: review("standards", true, {
      ...finding, severity: "P2", basis: { kind: "standard", reference: "resource convention" },
    }), spec: review("spec") } });
    const accepted = await f.runtime.dispatch({ workflow: "matt-code-review", task: "accept known residual",
      acceptRisk: { dispatchId: initial.details.dispatchId, findingIds: ["standards:parse"],
        reason: "bounded trade-off", evidence: "mitigation reviewed" },
    }, undefined, f.ctx);
    assert.equal(accepted.details.state, "accepted-risk");
    assert.equal(accepted.details.reviewPassed, false);
    assert.equal(f.prompts, 1);
    assert.equal(f.launches.length, 1);
    assert.equal(f.entries.findLast(entry => entry.customType === IMPLEMENTATION_ENTRY).data.originalResults[0].structuredOutput.verdict, "FAIL");
  });
});

test("TDD follow-ups require only tasks for the selected lanes and preserve causal repair summaries", async () => {
  await fixture(async f => {
    const initial = await f.runtime.dispatch(f.params, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ reviews: { standards: review("standards", true, {
      ...finding, basis: { kind: "standard", reference: "STANDARD_BODY_NOT_FOR_SPEC" },
    }), spec: review("spec") } });
    const repaired = await f.runtime.dispatch({ ...f.params, laneTasks: { implement: "repair only" },
      repair: { previousDispatchId: initial.details.dispatchId,
        groups: [{ ...repairGroups[0], findingIds: ["standards:parse"] }] },
    }, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle();
    await f.runtime.dispatch({ ...f.params, laneTasks: { standards: "standards only", spec: "acceptance only" },
      review: { dispatchId: repaired.details.dispatchId } }, undefined, f.ctx);
    await f.runtime.flush();
    const reviewed = await f.settle();
    const task = reviewed.itemsSeen.find(row => row.key === "spec").task;
    assert.match(task, /Cross-axis causal predecessors/);
    assert.match(task, /"contract":"validate first"/);
    assert.ok(!task.includes("STANDARD_BODY_NOT_FOR_SPEC"));
    assert.ok(!task.includes("Link recurring/regression findings only to this axis"));
  });
});

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

test("scope mismatches name changed fields without exposing or silently accepting rewritten contracts", async () => {
  await fixture(async f => {
    const initial = await f.runtime.dispatch(f.params, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ fail: true });
    await assert.rejects(() => f.runtime.dispatch({
      ...f.params, implementation: { ...f.params.implementation, scope: "REWRITTEN_PRIVATE_CONTRACT" },
      repair: { previousDispatchId: initial.details.dispatchId, groups: repairGroups },
    }, undefined, f.ctx), error => /scope\.scope/.test(error.message) &&
      /exact approved scope text/.test(error.message) && !error.message.includes("REWRITTEN_PRIVATE_CONTRACT"));
    assert.equal(f.launches.length, 1);
  });
});

test("a retained host-rejected report can be revalidated after upgrade with an exhausted correction budget", async () => {
  await fixture(async f => {
    const initial = await f.runtime.dispatch(f.params, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ fail: true });
    const repair = await f.runtime.dispatch({ ...f.params,
      repair: { previousDispatchId: initial.details.dispatchId, groups: repairGroups },
    }, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ value: "candidate\n" });
    const formal = await f.runtime.dispatch({ ...f.params, review: { dispatchId: repair.details.dispatchId } }, undefined, f.ctx);
    await f.runtime.flush();
    const reviewed = await f.settle({ fail: true, findingOverride: {
      ...finding, id: "range", rootCauseId: "range-response", classification: "independent",
      locations: ["parser.mjs:1-2"],
    } });
    // Retained v0.2.30 host rejection: same trusted candidate/report, not a fresh reviewer response.
    const retained = f.entries.findLast(entry => entry.customType === IMPLEMENTATION_ENTRY).data;
    const legacy = reviewed.status.workflow.emits.findLast(row => row.type === "pi-x-matt.stage-results").results[2];
    legacy.ok = false;
    legacy.contractError = { kind: "review-evidence", message: "unchanged reviewed content has no evidenced dependency impact" };
    legacy.error = "Review evidence contract invalid: unchanged reviewed content has no evidenced dependency impact";
    retained.reviewMeta.correctionCounts = { spec: 2 };
    await writeFile(join(f.launches.at(-1).asyncDir, "status.json"), JSON.stringify(reviewed.status));
    f.reload();
    const recovered = await f.runtime.dispatch({ ...f.params,
      recovery: { dispatchId: formal.details.dispatchId, lanes: ["spec"] },
    }, undefined, f.ctx);
    await f.runtime.flush();
    const revalidated = await f.settle();
    assert.deepEqual(revalidated.calls, [], "no writer, collector or reviewer may run for a host revalidation");
    const current = revalidated.status.workflow.emits.findLast(row => row.type === "pi-x-matt.stage-results").results[2];
    assert.equal(current.ok, true);
    assert.equal(current.structuredOutput.verdict, "FAIL", "revalidation never erases a real blocker");
    assert.equal(current.contractError, undefined);
    assert.deepEqual(current.revalidationHistory[0].original, legacy);
    assert.equal(revalidated.status.state, "failed", "delivery still requires dual PASS");
    assert.equal(batchOutcome(revalidated.status).resultsValid, false);
    assert.ok(revalidated.status.workflow.emits.some(row => row.type === "pi-x-matt.report-revalidated"));
    const record = f.entries.findLast(entry => entry.customType === IMPLEMENTATION_ENTRY).data;
    assert.deepEqual(record.reviewMeta.correctionCounts, { spec: 2 });
    assert.deepEqual(record.repair.counts, { parser: 1 });
    f.reload();
    const next = await f.runtime.dispatch({ ...f.params, repair: {
      previousDispatchId: recovered.details.dispatchId,
      groups: [{ ...repairGroups[0], id: "range", findingIds: ["spec:range"] }],
    } }, undefined, f.ctx);
    assert.equal(next.details.reviewPending, true);
    await f.runtime.flush();
    const fixed = await f.settle({ value: "final\n" });
    assert.equal(fixed.itemsSeen[0].resume, "run-1-writer");
    assert.equal(fixed.status.state, "complete");
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
    assert.match(specTask, /permitted predecessor IDs = \["spec:parse"\]/);
    assert.match(standardsTask, /Cross-axis causal predecessors = \[\{"id":"spec:parse","rootCauseId":"parse-order","title":/);
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

const axisFinding = (axis, id, overrides = {}) => ({
  ...finding, id, rootCauseId: `root-${id}`, title: `${axis} ${id}`,
  basis: axis === "spec" ? { kind: "acceptance", reference: "AC1" } : { kind: "standard", reference: "repository standard" },
  ...overrides,
});
const axisReview = (axis, verdict, findings = []) => ({
  structuredOutput: { axis, verdict, summary: `${axis} ${verdict}`, findings, notes: [] },
});
const decisions = (axis, items) => ({
  structuredOutput: { axis, decisions: items.map(([findingId, decision]) => ({
    findingId, decision, justification: `${decision} justified`, evidence: `${decision} evidence`,
  })) },
});

test("initial reviewer tasks include conditional recurrence guidance without inventing predecessor IDs", async () => {
  await fixture(async f => {
    const initial = await f.runtime.dispatch(f.params, undefined, f.ctx);
    for (const axis of ["standards", "spec"]) {
      const task = initial.details.lanes.find(lane => lane.key === axis).task;
      assert.match(task, /permitted predecessor IDs = \[\]/);
      assert.match(task, /Conditional recurring example/);
      assert.match(task, /Correct independent example/);
      assert.match(task, /do not claim.*recurrence/);
    }
  });
});

test("reconsideration withdraws only challenged findings without launching writer, evidence or the other axis", async () => {
  await fixture(async f => {
    const initial = await f.runtime.dispatch(f.params, undefined, f.ctx);
    await f.runtime.flush();
    const failed = await f.settle({ reviews: {
      standards: axisReview("standards", "PASS"),
      spec: axisReview("spec", "FAIL", [axisFinding("spec", "parse"), axisFinding("spec", "order")]),
    } });
    assert.equal(failed.status.state, "failed");
    f.reload();
    const reconsider = await f.runtime.dispatch({ ...f.params, reconsider: {
      dispatchId: initial.details.dispatchId,
      findings: [{ findingId: "spec:parse", reason: "conflicts with accepted behavior", evidence: "ticket AC1" }],
    } }, undefined, f.ctx);
    assert.equal(reconsider.details.authorization, "reused-implement-grant");
    assert.equal(reconsider.details.reviewPending, false);
    assert.deepEqual(reconsider.details.lanes.map(lane => lane.key), ["spec"]);
    const task = reconsider.details.lanes.find(lane => lane.key === "spec").task;
    assert.match(task, /spec:parse/);
    assert.match(task, /uphold/i);
    assert.match(task, /null reaches normalize/, "the original finding evidence is supplied, not replaced by the challenge");
    assert.match(task, /ticket AC1/, "the parent's challenge evidence remains separate");
    assert.doesNotMatch(task, /standards:/);
    await f.runtime.flush();
    const adjudicated = await f.settle({ reviews: {
      spec: decisions("spec", [["spec:parse", "withdraw"]]),
    } });
    assert.deepEqual(adjudicated.calls, ["spec"]);
    assert.equal(adjudicated.status.state, "complete", "the decisions completed, not the delivery review");
    assert.equal(batchOutcome(adjudicated.status).resultsValid, false, "a retained blocker cannot advance a batch");
    assert.deepEqual(adjudicated.status.workflow.emits.find(row => row.type === "pi-x-matt.reconsideration-complete"), {
      type: "pi-x-matt.reconsideration-complete", version: 1, reviewPassed: false, remainingFindingIds: ["spec:order"],
    });
    const results = adjudicated.status.workflow.emits
      .findLast(emit => emit.type === "pi-x-matt.stage-results").results;
    assert.deepEqual(results.map(result => result.key), ["implement", "standards", "spec"]);
    assert.equal(results[1].structuredOutput.verdict, "PASS");
    assert.deepEqual(results[1].structuredOutput.findings, []);
    assert.equal(results[2].ok, true);
    assert.equal(results[2].structuredOutput.verdict, "FAIL");
    assert.deepEqual(results[2].structuredOutput.findings.map(item => item.id), ["order"]);
    assert.deepEqual(results[2].reconsiderationHistory[0].original.findings.map(item => item.id), ["parse", "order"]);
    const record = f.entries.findLast(entry => entry.customType === IMPLEMENTATION_ENTRY).data;
    assert.equal(record.state, "complete");
    assert.equal(record.recoveryAttempt, 0);
    assert.deepEqual(record.reviewMeta.reconsiderCounts, { spec: 1 });
    f.reload();
    const regranted = { ...f.params, implementation: { ...f.params.implementation,
      diagnosticCommands: ["node --test parser.test.mjs"] } };
    await assert.rejects(() => f.runtime.dispatch({ ...regranted, reconsider: {
      dispatchId: record.id,
      findings: [{ findingId: "spec:order", reason: "also disputed", evidence: "ticket AC1" }],
    } }, undefined, f.ctx), /reconsideration.*exhausted/i);
    assert.equal(f.runtime.plans.size, 0);
    await f.runtime.flush();
    assert.equal(f.launches.length, 2);
  });
});

test("upheld reconsideration keeps a valid FAIL and the next repair uses only effective findings", async () => {
  await fixture(async f => {
    const initial = await f.runtime.dispatch(f.params, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ reviews: {
      standards: axisReview("standards", "PASS"),
      spec: axisReview("spec", "FAIL", [axisFinding("spec", "parse"), axisFinding("spec", "order")]),
    } });
    const reconsider = await f.runtime.dispatch({ ...f.params, reconsider: {
      dispatchId: initial.details.dispatchId,
      findings: [
        { findingId: "spec:parse", reason: "disputed behavior", evidence: "ticket AC1" },
        { findingId: "spec:order", reason: "disputed order", evidence: "ticket AC1" },
      ],
    } }, undefined, f.ctx);
    await f.runtime.flush();
    const adjudicated = await f.settle({ reviews: {
      spec: decisions("spec", [["spec:parse", "withdraw"], ["spec:order", "uphold"]]),
    } });
    assert.deepEqual(adjudicated.calls, ["spec"]);
    assert.equal(adjudicated.status.state, "complete");
    assert.equal(batchOutcome(adjudicated.status).resultsValid, false);
    const effective = adjudicated.status.workflow.emits
      .findLast(emit => emit.type === "pi-x-matt.stage-results").results[2];
    assert.equal(effective.ok, true);
    assert.equal(effective.structuredOutput.verdict, "FAIL");
    assert.deepEqual(effective.structuredOutput.findings.map(item => item.id), ["order"]);
    const reviewRecord = f.entries.findLast(entry => entry.customType === IMPLEMENTATION_ENTRY).data;
    assert.equal(reviewRecord.id, reconsider.details.dispatchId);
    await assert.rejects(() => f.runtime.dispatch({ ...f.params, repair: {
      previousDispatchId: reviewRecord.id,
      groups: [{ ...repairGroups[0], findingIds: ["spec:parse"] }],
    } }, undefined, f.ctx), /Unknown or non-blocking|Unknown or repeated|omitted/i);
    const repair = await f.runtime.dispatch({ ...f.params, repair: {
      previousDispatchId: reviewRecord.id,
      groups: [{ ...repairGroups[0], findingIds: ["spec:order"] }],
    } }, undefined, f.ctx);
    assert.equal(repair.details.reviewPending, true);
    assert.deepEqual(repair.details.lanes.map(lane => lane.key), ["implement"]);
    await f.runtime.flush();
    const repaired = await f.settle({ value: "fixed\n" });
    assert.equal(repaired.status.state, "complete");
    assert.equal(repaired.itemsSeen[0].resume, "run-0-writer");
    const repairRecord = f.entries.findLast(entry => entry.customType === IMPLEMENTATION_ENTRY).data;
    assert.deepEqual(repairRecord.repair.approvedFindingIds, ["spec:order"]);
    assert.equal(repairRecord.reviewSourceId, reviewRecord.id);
    assert.equal(repairRecord.repair.counts.parser, 1);
    f.reload();
    const review = await f.runtime.dispatch({ ...f.params,
      review: { dispatchId: repairRecord.id } }, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ reviews: {
      standards: axisReview("standards", "PASS"),
      spec: axisReview("spec", "FAIL", [axisFinding("spec", "parse", {
        classification: "independent", affectedBy: ["parser.mjs"],
      })]),
    } });
    const nextReview = f.entries.findLast(entry => entry.customType === IMPLEMENTATION_ENTRY).data;
    assert.equal(nextReview.id, review.details.dispatchId);
    assert.deepEqual(nextReview.reviewMeta.reconsiderCounts, {}, "a new writer candidate establishes a new budget");
    const nextReconsider = await f.runtime.dispatch({ ...f.params, reconsider: {
      dispatchId: nextReview.id,
      findings: [{ findingId: "spec:parse", reason: "new candidate dispute", evidence: "ticket AC1" }],
    } }, undefined, f.ctx);
    assert.deepEqual(nextReconsider.details.lanes.map(lane => lane.key), ["spec"]);
  });
});

test("reconsideration rejects pending candidates, stale snapshots and unknown targets", async () => {
  await fixture(async f => {
    const initial = await f.runtime.dispatch(f.params, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ reviews: {
      standards: axisReview("standards", "PASS"),
      spec: axisReview("spec", "FAIL", [axisFinding("spec", "parse")]),
    } });
    const repair = await f.runtime.dispatch({ ...f.params, repair: {
      previousDispatchId: initial.details.dispatchId, groups: repairGroups,
    } }, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ value: "fixed\n" });
    await assert.rejects(() => f.runtime.dispatch({ ...f.params, reconsider: {
      dispatchId: repair.details.dispatchId,
      findings: [{ findingId: "spec:parse", reason: "disputed", evidence: "ticket" }],
    } }, undefined, f.ctx), /pending|formal review|completed review/i);
    const review = await f.runtime.dispatch({ ...f.params,
      review: { dispatchId: repair.details.dispatchId } }, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ reviews: {
      standards: axisReview("standards", "PASS"),
      spec: axisReview("spec", "FAIL", [axisFinding("spec", "parse", { relatedFindingIds: ["spec:parse"] })]),
    } });
    const reviewed = f.entries.findLast(entry => entry.customType === IMPLEMENTATION_ENTRY).data;
    assert.equal(reviewed.id, review.details.dispatchId);
    await assert.rejects(() => f.runtime.dispatch({ ...f.params, reconsider: {
      dispatchId: reviewed.id,
      findings: [{ findingId: "spec:absent", reason: "disputed", evidence: "ticket" }],
    } }, undefined, f.ctx), /unknown.*target/i);
    await writeFile(join(f.ctx.cwd, "parser.mjs"), "external change\n");
    await assert.rejects(() => f.runtime.dispatch({ ...f.params, reconsider: {
      dispatchId: reviewed.id,
      findings: [{ findingId: "spec:parse", reason: "disputed", evidence: "ticket" }],
    } }, undefined, f.ctx), /snapshot.*stale|snapshot.*match/i);
    assert.equal(f.runtime.plans.size, 0);
    await f.runtime.flush();
    assert.equal(f.launches.length, 3);
  });
  await fixture(async f => {
    const initial = await f.runtime.dispatch(f.params, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ reviews: {
      standards: axisReview("standards", "PASS"),
      spec: axisReview("spec", "FAIL", [axisFinding("spec", "parse")]),
    } });
    const repair = await f.runtime.dispatch({ ...f.params, repair: {
      previousDispatchId: initial.details.dispatchId, groups: repairGroups,
    } }, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ workerOverride: { structuredOutput: { ...worker, status: "BLOCKED" } } });
    await assert.rejects(() => f.runtime.dispatch({ ...f.params, reconsider: {
      dispatchId: repair.details.dispatchId,
      findings: [{ findingId: "spec:parse", reason: "disputed", evidence: "ticket" }],
    } }, undefined, f.ctx), /pending|formal review|completed review/i);
    assert.equal(f.runtime.plans.size, 0);
    await f.runtime.flush();
    assert.equal(f.launches.length, 2);
  });
});

test("review report correction keeps two attempts separate from execution recovery and preserves failure chains", async () => {
  await fixture(async f => {
    const initial = await f.runtime.dispatch(f.params, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ reviews: {
      standards: axisReview("standards", "PASS"),
      spec: { ok: false, error: "fetch failed" },
    } });
    const recovery = await f.runtime.dispatch({ ...f.params,
      recovery: { dispatchId: initial.details.dispatchId, lanes: ["spec"] } }, undefined, f.ctx);
    assert.match(recovery.details.lanes.find(lane => lane.key === "spec").task,
      /permitted predecessor IDs = \[\]/);
    await f.runtime.flush();
    await f.settle({ reviews: {
      spec: axisReview("spec", "FAIL", [axisFinding("spec", "parse", { relatedFindingIds: ["standards:old"] })]),
    } });
    const firstCorrection = f.entries.findLast(entry => entry.customType === IMPLEMENTATION_ENTRY).data;
    assert.equal(firstCorrection.id, recovery.details.dispatchId);
    assert.equal(firstCorrection.recoveryAttempt, 1);
    assert.deepEqual(firstCorrection.reviewMeta.correctionCounts, {});
    const invalidResult = firstCorrection.state === "failed";
    assert.equal(invalidResult, true);
    const correctionOne = await f.runtime.dispatch({ ...f.params,
      recovery: { dispatchId: firstCorrection.id, lanes: ["spec"] } }, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ reviews: {
      spec: axisReview("spec", "FAIL", [axisFinding("spec", "parse", { relatedFindingIds: ["standards:old"] })]),
    } });
    const one = f.entries.findLast(entry => entry.customType === IMPLEMENTATION_ENTRY).data;
    assert.equal(one.id, correctionOne.details.dispatchId);
    assert.equal(one.recoveryAttempt, 1);
    assert.deepEqual(one.reviewMeta.correctionCounts, { spec: 1 });
    f.reload();
    const correctionTwo = await f.runtime.dispatch({ ...f.params,
      recovery: { dispatchId: one.id, lanes: ["spec"] } }, undefined, f.ctx);
    await f.runtime.flush();
    const corrected = await f.settle({ reviews: {
      spec: axisReview("spec", "FAIL", [axisFinding("spec", "parse")]),
    } });
    assert.equal(corrected.status.state, "failed");
    const correctedResult = corrected.status.workflow.emits
      .findLast(emit => emit.type === "pi-x-matt.stage-results").results[2];
    assert.equal(correctedResult.correctionHistory.length, 2);
    assert.equal(correctedResult.correctionHistory.at(-1).contractError.kind, "review-evidence");
    const two = f.entries.findLast(entry => entry.customType === IMPLEMENTATION_ENTRY).data;
    assert.equal(two.id, correctionTwo.details.dispatchId);
    assert.equal(two.recoveryAttempt, 1);
    assert.deepEqual(two.reviewMeta.correctionCounts, { spec: 2 });
    assert.equal(two.state, "failed");
    await assert.rejects(() => f.runtime.dispatch({ ...f.params,
      recovery: { dispatchId: two.id, lanes: ["spec"] } }, undefined, f.ctx),
      /execution recovery.*exhausted|valid verdict.*reconsider|correction.*exhausted/i);
    assert.equal(f.runtime.plans.size, 0);
    await f.runtime.flush();
    assert.equal(f.launches.length, 4);
  });
});

test("an invalid reconsideration decision report remains correctable within the same target contract", async () => {
  await fixture(async f => {
    const initial = await f.runtime.dispatch(f.params, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ reviews: {
      standards: axisReview("standards", "PASS"),
      spec: axisReview("spec", "FAIL", [axisFinding("spec", "parse")]),
    } });
    const reconsider = await f.runtime.dispatch({ ...f.params, reconsider: {
      dispatchId: initial.details.dispatchId,
      findings: [{ findingId: "spec:parse", reason: "disputed", evidence: "ticket AC1" }],
    } }, undefined, f.ctx);
    await f.runtime.flush();
    const malformed = await f.settle({ reviews: {
      spec: decisions("spec", [["spec:absent", "withdraw"]]),
    } });
    assert.deepEqual(malformed.calls, ["spec"]);
    assert.equal(malformed.status.state, "failed");
    const failedResult = malformed.status.workflow.emits
      .findLast(emit => emit.type === "pi-x-matt.stage-results").results[2];
    assert.equal(failedResult.ok, false);
    assert.equal(failedResult.contractError.kind, "reconsideration");
    const invalidRecord = f.entries.findLast(entry => entry.customType === IMPLEMENTATION_ENTRY).data;
    assert.equal(invalidRecord.id, reconsider.details.dispatchId);
    assert.deepEqual(invalidRecord.reviewMeta.reconsiderCounts, { spec: 1 });
    assert.deepEqual(invalidRecord.reviewMeta.correctionCounts, {});
    assert.equal(invalidRecord.recoveryAttempt, 0);
    const correction = await f.runtime.dispatch({ ...f.params,
      recovery: { dispatchId: invalidRecord.id, lanes: ["spec"] } }, undefined, f.ctx);
    await f.runtime.flush();
    const fixed = await f.settle({ reviews: {
      spec: decisions("spec", [["spec:parse", "withdraw"]]),
    } });
    assert.deepEqual(fixed.calls, ["spec"]);
    assert.equal(fixed.status.state, "complete");
    const results = fixed.status.workflow.emits
      .findLast(emit => emit.type === "pi-x-matt.stage-results").results;
    assert.equal(results[2].ok, true);
    assert.equal(results[2].structuredOutput.verdict, "PASS");
    assert.deepEqual(results[2].structuredOutput.findings, []);
    assert.equal(results[2].reconsiderationHistory.length, 2);
    assert.equal(results[2].reconsiderationHistory[0].decisionError.length > 0, true);
    assert.equal(results[2].reconsiderationHistory[1].effectiveVerdict, "PASS");
    const correctedRecord = f.entries.findLast(entry => entry.customType === IMPLEMENTATION_ENTRY).data;
    assert.equal(correctedRecord.id, correction.details.dispatchId);
    assert.equal(correctedRecord.recoveryAttempt, 0);
    assert.deepEqual(correctedRecord.reviewMeta.reconsiderCounts, { spec: 1 });
    assert.deepEqual(correctedRecord.reviewMeta.correctionCounts, { spec: 1 });
    assert.deepEqual(correctedRecord.reconsider.targets.map(target => target.id), ["spec:parse"]);
    assert.equal(correctedRecord.state, "complete");
  });
});

test("schema-rejected reconsideration reports consume correction quota, not execution recovery", async () => {
  await fixture(async f => {
    const initial = await f.runtime.dispatch(f.params, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ reviews: {
      standards: axisReview("standards", "PASS"),
      spec: axisReview("spec", "FAIL", [axisFinding("spec", "parse")]),
    } });
    const reconsider = await f.runtime.dispatch({ ...f.params, reconsider: {
      dispatchId: initial.details.dispatchId,
      findings: [{ findingId: "spec:parse", reason: "accepted behavior", evidence: "AC1" }],
    } }, undefined, f.ctx);
    await f.runtime.flush();
    const invalid = { ok: false, error: "Structured output validation failed: invalid decision",
      results: [{ structuredOutputFailed: true, exitCode: 1 }] };
    const rejected = await f.settle({ reviews: { spec: invalid } });
    const rejectedSpec = rejected.status.workflow.emits.findLast(e => e.type === "pi-x-matt.stage-results").results[2];
    assert.equal(rejectedSpec.contractError.kind, "structured-output");
    let dispatchId = reconsider.details.dispatchId;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const correction = await f.runtime.dispatch({ ...f.params,
        recovery: { dispatchId, lanes: ["spec"] } }, undefined, f.ctx);
      await f.runtime.flush();
      const failed = await f.settle({ reviews: { spec: invalid } });
      assert.deepEqual(failed.calls, ["spec"]);
      const record = f.entries.findLast(entry => entry.customType === IMPLEMENTATION_ENTRY).data;
      assert.equal(record.recoveryAttempt, 0);
      assert.equal(record.reviewMeta.correctionCounts.spec, attempt);
      dispatchId = correction.details.dispatchId;
      f.reload();
    }
    await assert.rejects(() => f.runtime.dispatch({ ...f.params,
      recovery: { dispatchId, lanes: ["spec"] } }, undefined, f.ctx), /correction.*exhausted/i);
  });
});

test("reconsideration correction preserves the other axis's effective verdict and full failure report", async () => {
  await fixture(async f => {
    const initial = await f.runtime.dispatch(f.params, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ reviews: {
      standards: axisReview("standards", "FAIL", [axisFinding("standards", "rule")]),
      spec: axisReview("spec", "FAIL", [axisFinding("spec", "parse")]),
    } });
    const reconsider = await f.runtime.dispatch({ ...f.params, reconsider: {
      dispatchId: initial.details.dispatchId,
      findings: [
        { findingId: "standards:rule", reason: "rule does not apply", evidence: "standard scope" },
        { findingId: "spec:parse", reason: "accepted behavior", evidence: "AC1" },
      ],
    } }, undefined, f.ctx);
    await f.runtime.flush();
    const partial = await f.settle({ reviews: {
      standards: decisions("standards", [["standards:rule", "withdraw"]]),
      spec: decisions("spec", [["spec:unknown", "withdraw"]]),
    } });
    const prior = partial.status.workflow.emits.findLast(e => e.type === "pi-x-matt.stage-results").results;
    assert.equal(prior[1].structuredOutput.verdict, "PASS");
    const correction = await f.runtime.dispatch({ ...f.params,
      recovery: { dispatchId: reconsider.details.dispatchId, lanes: ["spec"] } }, undefined, f.ctx);
    await f.runtime.flush();
    const fixed = await f.settle({ reviews: { spec: decisions("spec", [["spec:parse", "withdraw"]]) } });
    assert.deepEqual(fixed.calls, ["spec"]);
    assert.equal(fixed.status.state, "complete");
    const results = fixed.status.workflow.value;
    assert.deepEqual(results[1], prior[1], "the corrected axis cannot reopen the other's adjudicated PASS");
    assert.deepEqual(results[2].correctionHistory[0], prior[2], "keep the complete failed decision report");
    assert.equal(correction.details.reviewPending, false);
  });
});

test("separate corrections retain both reconsideration target contracts until each axis is settled", async () => {
  await fixture(async f => {
    const initial = await f.runtime.dispatch(f.params, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ reviews: {
      standards: axisReview("standards", "FAIL", [axisFinding("standards", "rule")]),
      spec: axisReview("spec", "FAIL", [axisFinding("spec", "parse")]),
    } });
    const reconsider = await f.runtime.dispatch({ ...f.params, reconsider: {
      dispatchId: initial.details.dispatchId,
      findings: [
        { findingId: "standards:rule", reason: "rule scope", evidence: "standard" },
        { findingId: "spec:parse", reason: "accepted behavior", evidence: "AC1" },
      ],
    } }, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ reviews: {
      standards: decisions("standards", [["standards:unknown", "withdraw"]]),
      spec: decisions("spec", [["spec:unknown", "withdraw"]]),
    } });
    let dispatchId = reconsider.details.dispatchId;
    for (const [axis, id] of [["spec", "parse"], ["standards", "rule"]]) {
      f.reload();
      const correction = await f.runtime.dispatch({ ...f.params,
        recovery: { dispatchId, lanes: [axis] } }, undefined, f.ctx);
      await f.runtime.flush();
      const corrected = await f.settle({ reviews: { [axis]: decisions(axis, [[`${axis}:${id}`, "withdraw"]]) } });
      assert.deepEqual(corrected.calls, [axis]);
      if (axis === "standards") assert.equal(corrected.status.state, "complete");
      dispatchId = correction.details.dispatchId;
    }
    const record = f.entries.findLast(entry => entry.customType === IMPLEMENTATION_ENTRY).data;
    assert.deepEqual(record.reviewMeta.correctionCounts, { spec: 1, standards: 1 });
    assert.deepEqual(record.reviewMeta.reconsiderCounts, { standards: 1, spec: 1 });
  });
});

test("explicit reconsideration execution recovery preserves its failure without another settlement", async () => {
  await fixture(async f => {
    const initial = await f.runtime.dispatch(f.params, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ reviews: {
      standards: axisReview("standards", "PASS"),
      spec: axisReview("spec", "FAIL", [axisFinding("spec", "parse")]),
    } });
    const reconsider = await f.runtime.dispatch({ ...f.params, reconsider: {
      dispatchId: initial.details.dispatchId,
      findings: [{ findingId: "spec:parse", reason: "accepted behavior", evidence: "AC1" }],
    } }, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ reviews: { spec: { ok: false, error: "fetch failed" } } });
    const recovery = await f.runtime.dispatch({ ...f.params,
      recovery: { dispatchId: reconsider.details.dispatchId, lanes: ["spec"] } }, undefined, f.ctx);
    await f.runtime.flush();
    const failed = await f.settle({ reviews: {
      spec: { ok: false, error: "Subagent timed out", timedOut: true, runId: "failed-reviewer",
        resumability: { state: "resumable" } },
    } });
    assert.deepEqual(failed.calls, ["spec"], "an explicit recovery cannot stack an automatic settlement");
    const results = failed.status.workflow.emits.findLast(e => e.type === "pi-x-matt.stage-results").results;
    assert.equal(results[2].recoveryHistory[0].error, "fetch failed");
    await assert.rejects(() => f.runtime.dispatch({ ...f.params,
      recovery: { dispatchId: recovery.details.dispatchId, lanes: ["spec"] } }, undefined, f.ctx), /exhausted|Settlement/);
  });
});

const reviewParams = laneTasks => ({ workflow: "matt-code-review", task: "shared review facts", laneTasks });

async function commitFeature(cwd, content) {
  await writeFile(join(cwd, "parser.mjs"), content);
  await exec("git", ["add", "parser.mjs"], { cwd });
  await exec("git", ["commit", "-qm", "feature"], { cwd });
  return (await exec("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
}

test("committed reviewScope is host-resolved at admission and captures one object pack before both reviewers", async () => {
  await fixture(async f => {
    const fixedPoint = (await exec("git", ["rev-parse", "HEAD"], { cwd: f.ctx.cwd })).stdout.trim();
    const head = await commitFeature(f.ctx.cwd, "committed change\n");
    const queued = await f.runtime.dispatch({ ...reviewParams({
      standards: "Standards evidence only", spec: "Spec inline source: AC1 committed review",
    }), reviewScope: { kind: "committed", fixedPoint } }, undefined, f.ctx);
    assert.equal(queued.details.workflow, "matt-code-review");
    assert.deepEqual(queued.details.lanes.map(lane => lane.key), ["standards", "spec"]);
    assert.equal(f.prompts, 0);
    assert.match(queued.details.reviewEvidencePath, /review\.md$/);
    await f.runtime.flush();
    const launch = f.launches.at(-1);
    assert.equal(launch.script.includes("implement"), false);
    const { calls, itemsSeen, status } = await f.settle();
    assert.equal(status.state, "complete");
    assert.deepEqual(calls, ["evidence", "standards", "spec"], "one host capture must precede both read-only reviewers");
    assert.ok(itemsSeen.every(item => item.task.includes(queued.details.reviewEvidencePath)));
    assert.match(itemsSeen.find(item => item.key === "spec").task, /Spec inline source: AC1 committed review/);
    assert.doesNotMatch(itemsSeen.find(item => item.key === "standards").task, /Spec inline source/);
    assert.ok(status.workflow.value.every(result => result.artifactPaths.includes(queued.details.reviewEvidencePath)));
    const pack = JSON.parse(await readFile(queued.details.reviewEvidencePath.replace(/\.md$/, ".json"), "utf8"));
    assert.equal(pack.reviewKind, "committed");
    assert.equal(pack.fixedPoint, fixedPoint);
    assert.equal(pack.head, head);
    assert.equal(pack.manifest.find(entry => entry.path === "parser.mjs").content, "committed change\n");

    const manual = await f.runtime.dispatch(reviewParams({
      standards: "Standards evidence only", spec: "Spec evidence only",
    }), undefined, f.ctx);
    assert.equal(manual.details.reviewEvidencePath, undefined);
    await f.runtime.flush();
    const manualRun = await f.settle();
    assert.deepEqual(manualRun.calls, ["standards", "spec"], "omitting reviewScope preserves the manual worktree review path");
  });
});

test("committed admission rejects invalid scope and later history movement before any reviewer", async () => {
  await fixture(async f => {
    const fixedPoint = (await exec("git", ["rev-parse", "HEAD"], { cwd: f.ctx.cwd })).stdout.trim();
    const branch = (await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: f.ctx.cwd })).stdout.trim();
    await exec("git", ["checkout", "-q", "-b", "side", fixedPoint], { cwd: f.ctx.cwd });
    await writeFile(join(f.ctx.cwd, "side.txt"), "side\n");
    await exec("git", ["add", "side.txt"], { cwd: f.ctx.cwd });
    await exec("git", ["commit", "-qm", "side"], { cwd: f.ctx.cwd });
    const side = (await exec("git", ["rev-parse", "HEAD"], { cwd: f.ctx.cwd })).stdout.trim();
    await exec("git", ["checkout", "-q", branch], { cwd: f.ctx.cwd });
    const laneTasks = { standards: "Standards evidence only", spec: "Spec evidence only" };

    await assert.rejects(() => f.runtime.dispatch({ ...reviewParams(laneTasks),
      reviewScope: { kind: "worktree", fixedPoint } }, undefined, f.ctx), /reviewScope\.kind/);
    await assert.rejects(() => f.runtime.dispatch({ ...reviewParams(laneTasks),
      reviewScope: { kind: "committed", fixedPoint, head: side } }, undefined, f.ctx), /only kind and fixedPoint/);
    await assert.rejects(() => f.runtime.dispatch({ ...reviewParams(laneTasks),
      reviewScope: { kind: "committed", fixedPoint: side } }, undefined, f.ctx), /ancestor/);
    await assert.rejects(() => f.runtime.dispatch({ workflow: "matt-research", task: "research",
      reviewScope: { kind: "committed", fixedPoint } }, undefined, f.ctx), /only applies to matt-code-review/);
    assert.equal(f.runtime.plans.size, 0);
    assert.equal(f.launches.length, 0);

    const queued = await f.runtime.dispatch({ ...reviewParams(laneTasks),
      reviewScope: { kind: "committed", fixedPoint } }, undefined, f.ctx);
    await f.runtime.flush();
    await exec("git", ["commit", "--allow-empty", "-qm", "moved after admission"], { cwd: f.ctx.cwd });
    const { calls, itemsSeen, status } = await f.settle();
    assert.equal(status.state, "failed");
    assert.match(status.error, /HEAD changed since admission/);
    assert.deepEqual(calls, ["evidence"], "no reviewer launches after a drifted committed capture");
    assert.equal(itemsSeen.length, 0);
    assert.ok(queued.details.reviewEvidencePath);
  });
});
