import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { BATCH_ENTRY, batchOutcome, collectCandidateTreeProof, confirmBatchPlan, createBatchAuthorization, normalizeBatchPlan, prepareBatchPlan, verifyBatchDispatch } from "../lib/batch-authorization.mjs";
import { AUTH_ENTRY, createDispatchAuthorization } from "../lib/dispatch-authorization.mjs";
import { createImplementationRuntime } from "../lib/implementation-runtime.mjs";
import { IMPLEMENTATION_ENTRY } from "../lib/repair-contract.mjs";
import { collectReviewEvidence } from "../lib/review-evidence.mjs";

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FEATURE = ".x-matt/work/demo";
const SPEC = `${FEATURE}/spec.md`;
const T1 = `${FEATURE}/issues/01-parser.md`;
const T2 = `${FEATURE}/issues/02-second.md`;
const T3 = `${FEATURE}/issues/03-undeclared.md`;
const sha256 = value => createHash("sha256").update(value).digest("hex");

const worker = {
  status: "COMPLETE", summary: "implemented", confirmedSeams: [{ name: "parse", interface: "parse", behaviors: ["validate"] }],
  cycles: [{ test: "parse", redEvidence: "red", greenEvidence: "green", files: ["parser.mjs"] }],
  changedFiles: ["parser.mjs"], commands: [{ command: "test", phase: "GREEN", exitCode: 0, testCount: 1, outcome: "green" }],
};
const review = axis => ({ key: axis, ok: true, artifactPaths: [],
  structuredOutput: { axis, verdict: "PASS", summary: "review", findings: [], notes: [] } });

const ticket = (title, parent, blockedBy, body = "observable behavior") => [
  `# ${title}`, "", "Type: ticket", `Parent: ${parent}`, "Status: ready-for-agent",
  "Source session: pi:test-session", `Blocked by: ${blockedBy}`, "",
  "## What to build", "", body, "",
  "## Acceptance criteria", "", "- [ ] behavior is observable", "",
  "## Comments", "",
].join("\n");

const specContent = [
  "# Demo spec", "", "Type: spec", "Status: spec-ready", "Source session: pi:test-session", "",
  "## What to build", "", "A bounded two-ticket demo.", "",
].join("\n");

function batchParams(fixedPoint) {
  return { spec: SPEC, fixedPoint, tickets: [
    { ticket: T1, scope: "parser slice", allowedFiles: ["parser.mjs"] },
    { ticket: T2, scope: "second slice", allowedFiles: ["parser.mjs"] },
  ] };
}

function implementation(ticketPath) {
  const scope = ticketPath === T1 ? "parser slice" : "second slice";
  return { ticket: ticketPath, scope, allowedFiles: ["parser.mjs"] };
}

async function writeFeature(cwd, { t1 = ticket("01: parser", SPEC, "None"), t2 = ticket("02: second", SPEC, T1) } = {}) {
  await mkdir(join(cwd, ".x-matt/work/demo/issues"), { recursive: true });
  await writeFile(join(cwd, SPEC), specContent);
  await writeFile(join(cwd, T1), t1);
  await writeFile(join(cwd, T2), t2);
  await writeFile(join(cwd, T3), ticket("03: undeclared", SPEC, "None"));
}

async function resolveTicket(cwd, path, commit) {
  const content = await readFile(join(cwd, path), "utf8");
  await writeFile(join(cwd, path), content
    .replace(/^Status:.*$/m, "Status: resolved")
    .replace(/^Implementation commit:.*$/gm, "")
    .replace("## Comments\n", `## Comments\n\nImplementation commit: ${commit}\n`));
}

async function git(cwd, ...args) {
  return (await exec("git", args, { cwd, encoding: "utf8", timeout: 20_000 })).stdout.trim();
}

async function batchFixture(run) {
  const cwd = await mkdtemp(join(tmpdir(), "matt-batch-project-"));
  const artifacts = await mkdtemp(join(tmpdir(), "matt-batch-status-"));
  const entries = [], launches = [], notices = [], messages = [];
  let prompts = 0, runtime, clock = Date.now();
  const ctx = {
    cwd, hasUI: true, mode: "tui", isIdle: () => true, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "batch-session", getBranch: () => entries },
    ui: { notify() {}, confirm: async (_title, text) => { prompts++; messages.push(text); return true; } },
  };
  const pi = {
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data: structuredClone(data) }),
    events: { emit() {} }, sendUserMessage: text => notices.push(text),
  };
  const reload = (reason = "reload", overrides = {}) => {
    runtime = createImplementationRuntime(pi, ROOT, {
      now: () => clock,
      rpc: async (method, params) => {
        assert.equal(method, "spawn");
        const plan = params.workflow ? runtime.resolve(params.args) : { script: params.script };
        assert.ok(plan.script, plan.error);
        const runId = `run-${launches.length}`, asyncDir = join(artifacts, runId);
        await mkdir(asyncDir);
        await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId, state: "running" }));
        launches.push({ ...plan, runId, asyncDir });
        return { details: { runId, asyncDir } };
      },
      ...overrides,
    });
    runtime.start(ctx, reason);
    return runtime;
  };
  const settle = async ({ value = "first slice\n", files = {}, reviews, workerOverride } = {}) => {
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
            // A compliant writer accounts for exactly the finding IDs its repair handoff names.
            const findingResolutions = JSON.parse(item.task.match(/"approvedFindingIds":(\[[^\]]*\])/)?.[1] ?? "[]")
              .map(findingId => ({ findingId, cycleTest: worker.cycles[0].test, evidence: "covered by the cycle" }));
            results.push({ key: "implement", ok: true, agent: "matt-worker",
              runId: `${launch.runId}-writer`, resumability: { state: "resumable" },
              structuredOutput: findingResolutions.length ? { ...worker, findingResolutions } : worker,
              ...workerOverride });
          } else if (reviews?.[item.key]) {
            results.push({ key: item.key, ok: true, artifactPaths: [], ...reviews[item.key] });
          } else results.push(review(item.key));
        }
        return results;
      },
      host: async (key, options) => {
        calls.push(key === "implement-claim" ? "claim" : key.startsWith("pre-review") ? key : "evidence");
        return exec("/bin/sh", ["-c", options.command], { cwd });
      },
    };
    const status = { runId: launch.runId, state: "running", workflow: { emits } };
    try {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
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
    await git(cwd, "init", "-q");
    await git(cwd, "config", "user.email", "test@example.invalid");
    await git(cwd, "config", "user.name", "Test");
    await git(cwd, "add", ".");
    await git(cwd, "commit", "-qm", "baseline");
    await writeFile(join(cwd, ".git/info/exclude"), ".x-matt/\n");
    await writeFeature(cwd);
    const fixedPoint = await git(cwd, "rev-parse", "HEAD");
    reload("startup");
    await run({ ctx, pi, entries, launches, notices, fixedPoint, reload, settle,
      messages,
      get runtime() { return runtime; }, get prompts() { return prompts; },
      get clock() { return clock; }, set clock(value) { clock = value; } });
  } finally {
    const evidenceDirs = new Set(entries.filter(entry => entry.customType === IMPLEMENTATION_ENTRY)
      .map(entry => entry.data.evidence?.path).filter(Boolean).map(dirname));
    for (const path of evidenceDirs) await rm(path, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
    await rm(artifacts, { recursive: true, force: true });
  }
}

async function repoFixture(run) {
  const cwd = await mkdtemp(join(tmpdir(), "matt-batch-repo-"));
  try {
    await writeFile(join(cwd, "parser.mjs"), "original\n");
    await git(cwd, "init", "-q");
    await git(cwd, "config", "user.email", "test@example.invalid");
    await git(cwd, "config", "user.name", "Test");
    await git(cwd, "add", ".");
    await git(cwd, "commit", "-qm", "baseline");
    await run({ cwd, fixedPoint: await git(cwd, "rev-parse", "HEAD") });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const environmentBlocked = {
  status: "BLOCKED", summary: "Offline runner unavailable", confirmedSeams: worker.confirmedSeams,
  cycles: [], changedFiles: ["parser.mjs"], commands: [], residualRisks: [],
  environmentBlocker: { command: "node --test parser.mjs", evidence: "Test runner dependency missing before tests started" },
};

test("native spec command confirms a local plan once and survives more than 24 hours", async () => {
  await batchFixture(async f => {
    const planPath = join(f.ctx.cwd, `${SPEC}.dispatch.json`);
    const plan = batchParams(f.fixedPoint);
    plan.tickets[0].finalValidationCommands = ["grep -qx 'first slice' parser.mjs"];
    const text = JSON.stringify({ tickets: plan.tickets });
    await writeFile(planPath, text);
    await assert.rejects(() => f.runtime.beginBatchCommand(SPEC, { ...f.ctx, hasUI: false }), /explicit TUI\/RPC confirmation/);
    await f.runtime.beginBatchCommand(SPEC, f.ctx);
    assert.match(f.messages.at(-1), /Local plan SHA-256:/);
    const common = { workflow: "matt-tdd", task: "shared",
      laneTasks: { implement: "implement", standards: "standards", spec: "spec" } };
    const request = { ...common, implementation: implementation(T1), batch: batchParams(f.fixedPoint) };
    await assert.rejects(() => f.runtime.dispatch({ ...request, batch: { ...request.batch, tickets:
      request.batch.tickets.map(item => ({ ...item, diagnosticCommands: ["true"] })) } }, undefined, f.ctx), /differs from/);
    await f.runtime.dispatch(request, undefined, f.ctx);
    assert.equal(f.prompts, 1);
    await f.runtime.flush();
    const result = await f.settle();
    assert.equal(result.status.state, "complete");
    const checked = f.entries.filter(entry => entry.customType === IMPLEMENTATION_ENTRY).at(-1).data;
    assert.equal(checked.requiredValidation.ok, true);
    assert.equal(checked.requiredValidation.snapshotId, checked.snapshotId);
    await git(f.ctx.cwd, "add", "parser.mjs");
    await git(f.ctx.cwd, "commit", "-qm", "first ticket");
    await resolveTicket(f.ctx.cwd, T1, await git(f.ctx.cwd, "rev-parse", "HEAD"));
    f.clock += 25 * 60 * 60 * 1000;
    f.reload();
    await assert.rejects(() => f.runtime.dispatch({ ...common, implementation: implementation(T3) }, undefined, f.ctx),
      /not declared/);
    await writeFile(planPath, `${text}\n`);
    await assert.rejects(() => f.runtime.dispatch({ ...common, implementation: implementation(T2) }, undefined, f.ctx),
      /Local dispatch plan changed/);
    await writeFile(planPath, text);
    await f.runtime.dispatch({ ...common, implementation: implementation(T2) }, undefined, f.ctx);
    await f.runtime.flush();
    assert.equal(f.launches.length, 2);
    assert.equal((await f.settle({ value: "second slice\n" })).status.state, "complete");
    assert.equal(f.prompts, 1);
    f.runtime.revoke("user-cancelled");
    await assert.rejects(() => f.runtime.dispatch({ ...common, implementation: implementation(T2) }, undefined, f.ctx),
      /revoked or expired/);
  });
});

test("rewritable input cannot authorize a batch and a native command without a local plan still requires confirmation", async () => {
  await batchFixture(async f => {
    const params = { workflow: "matt-tdd", task: "shared", implementation: implementation(T1),
      batch: batchParams(f.fixedPoint), laneTasks: { implement: "implement", standards: "standards", spec: "spec" } };
    f.ctx.hasUI = false;
    for (const source of ["extension", "interactive", "rpc"]) {
      f.runtime.input({ text: `/skill:matt-implement-spec ${SPEC}`, source });
      await assert.rejects(() => f.runtime.dispatch(params, undefined, f.ctx), /requires one explicit/);
    }
    await f.runtime.beginBatchCommand(SPEC, { ...f.ctx, mode: "rpc" });
    await assert.rejects(() => f.runtime.dispatch(params, undefined, f.ctx), /requires one explicit/);
    assert.equal(f.launches.length, 0);
  });
});

test("revocation wins the existing writer claim even after RPC handoff", async () => {
  await batchFixture(async f => {
    const params = { workflow: "matt-tdd", task: "shared", implementation: implementation(T1),
      batch: batchParams(f.fixedPoint), laneTasks: { implement: "implement", standards: "standards", spec: "spec" } };
    await f.runtime.dispatch(params, undefined, f.ctx);
    await f.runtime.flush();
    assert.equal(f.launches.length, 1);
    f.runtime.revoke("user-cancelled");
    const { calls, status } = await f.settle();
    assert.deepEqual(calls, ["claim"]);
    assert.equal(status.state, "failed");
    assert.equal(await readFile(join(f.ctx.cwd, "parser.mjs"), "utf8"), "original\n");
    assert.equal(f.entries.filter(entry => entry.customType === IMPLEMENTATION_ENTRY).at(-1).data.state, "cancelled");
    await f.runtime.dispatch(params, undefined, f.ctx);
    await f.runtime.flush();
    assert.equal(f.launches.length, 2, "fresh real confirmation can start a writer that never claimed");
  });
});

test("initial batch launch rechecks worktree and ignored spec after queuing", async () => {
  await batchFixture(async f => {
    const params = { workflow: "matt-tdd", task: "shared", implementation: implementation(T1),
      batch: batchParams(f.fixedPoint), laneTasks: { implement: "implement", standards: "standards", spec: "spec" } };
    await f.runtime.dispatch(params, undefined, f.ctx);
    await writeFile(join(f.ctx.cwd, SPEC), `${specContent}\nChanged after queue.\n`);
    await f.runtime.flush();
    assert.equal(f.launches.length, 0);
    assert.match(f.notices.at(-1), /spec content drift/);
    await writeFile(join(f.ctx.cwd, SPEC), specContent);
    await f.runtime.dispatch(params, undefined, f.ctx);
    await writeFile(join(f.ctx.cwd, "parser.mjs"), "changed after queue\n");
    await f.runtime.flush();
    assert.equal(f.launches.length, 0);
    assert.match(f.notices.at(-1), /clean worktree|changed after admission/);
  });
});

test("initial environment BLOCKED resumes the original batch writer once without weakening delivery gates", async () => {
  await batchFixture(async f => {
    const common = { workflow: "matt-tdd", task: "shared", implementation: implementation(T1),
      laneTasks: { implement: "implement", standards: "standards", spec: "spec" } };
    const batch = batchParams(f.fixedPoint);
    const checks = ["node -e 'process.exit(0)'"];
    batch.tickets[0].preReviewCommands = common.implementation.preReviewCommands = checks;
    const first = await f.runtime.dispatch({ ...common, batch }, undefined, f.ctx);
    await f.runtime.flush();
    const failed = await f.settle({ value: "draft\n", workerOverride: { structuredOutput: environmentBlocked } });
    assert.equal(failed.status.state, "failed");
    assert.deepEqual(failed.calls, ["claim", "implement"]);
    assert.match(failed.status.error, /implement\.status/);
    const next = { ...common, implementation: implementation(T2) };
    await assert.rejects(() => f.runtime.dispatch(next, undefined, f.ctx), /must be resolved/);
    f.reload();
    const resume = { ...common, blockedRecovery: { dispatchId: first.details.dispatchId } };
    const recovered = await f.runtime.dispatch(resume, undefined, f.ctx);
    await f.runtime.flush();
    assert.equal(await readFile(join(f.ctx.cwd, "parser.mjs"), "utf8"), "draft\n");
    const clean = await f.settle();
    assert.deepEqual(clean.calls, ["claim", "implement", "pre-review", "evidence", "standards", "spec"]);
    assert.equal(clean.status.state, "complete");
    assert.equal(clean.itemsSeen[0].resume, "run-0-writer");
    assert.equal(clean.itemsSeen[0].agent, undefined);
    assert.deepEqual(clean.status.workflow.value[0].recoveryHistory[0].structuredOutput, environmentBlocked);
    const record = f.entries.filter(entry => entry.customType === IMPLEMENTATION_ENTRY).at(-1).data;
    const pack = JSON.parse(await readFile(record.evidence.snapshotPath, "utf8"));
    assert.equal(pack.baseline.head, f.fixedPoint);
    assert.deepEqual(pack.baseline.manifest, [], "review still compares against the pre-writer baseline, not the draft");
    await assert.rejects(() => f.runtime.dispatch({ ...resume, blockedRecovery: { dispatchId: recovered.details.dispatchId } },
      undefined, f.ctx), /exhausted/);
    await assert.rejects(() => f.runtime.dispatch(next, undefined, f.ctx), /must be resolved/);
    await git(f.ctx.cwd, "add", "parser.mjs");
    await git(f.ctx.cwd, "commit", "-qm", "verified first slice");
    await resolveTicket(f.ctx.cwd, T1, await git(f.ctx.cwd, "rev-parse", "HEAD"));
    await f.runtime.dispatch(next, undefined, f.ctx);
    assert.equal(f.prompts, 2, "one batch approval and one explicit environment recovery approval");
  });
});

test("overlapping completion and progress announce the sealed blocker once, never after recovery is queued", async () => {
  await batchFixture(async f => {
    const common = { workflow: "matt-tdd", task: "shared", implementation: implementation(T1),
      laneTasks: { implement: "implement", standards: "standards", spec: "spec" } };
    const first = await f.runtime.dispatch({ ...common, batch: batchParams(f.fixedPoint) }, undefined, f.ctx);
    await f.runtime.flush();
    const { runId, asyncDir } = f.launches[0];
    const result = { key: "implement", ok: true, agent: "matt-worker", runId: `${runId}-writer`,
      resumability: { state: "resumable" }, structuredOutput: { ...environmentBlocked, cycles: worker.cycles, commands: worker.commands,
        environmentBlocker: { command: "node --test", evidence: "Full suite interrupted after parser tests passed" } } };
    await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId, state: "failed", workflow: { emits: [
      { type: "pi-x-matt.recovery", lane: "implement", state: "settled", result },
      { type: "pi-x-matt.stage-results", version: 1, workflow: "matt-tdd", stage: 1, results: [result] },
    ] } }));

    const alerts = [];
    f.ctx.ui.notify = text => {
      if (text.includes("blockedRecovery")) {
        const saved = f.entries.findLast(entry => entry.customType === IMPLEMENTATION_ENTRY).data;
        assert.equal(saved.id, first.details.dispatchId);
        assert.equal(saved.state, "failed");
        assert.ok(saved.initialBlocker.snapshotId, "seal before notifying");
        assert.ok(!f.entries.some(entry => entry.data.blockedRecovery), "do not prompt for a superseded dispatch");
      }
      alerts.push(text);
    };
    // Both observers read the same failed status. Hold one evidence read across recovery admission.
    const release = Promise.withResolvers();
    let reads = 0;
    f.reload("reload", { collectEvidence: async (...args) => {
      if (++reads === 1) await release.promise;
      return collectReviewEvidence(...args);
    } });
    const observers = [f.runtime.progress(), f.runtime.completion({ runId })];
    try {
      await Promise.race(observers);
      await f.runtime.dispatch({ ...common, blockedRecovery: { dispatchId: first.details.dispatchId } }, undefined, f.ctx);
    } finally {
      release.resolve();
      await Promise.all(observers);
    }
    await f.runtime.completion({ runId });
    const blockers = [...alerts, ...f.notices].filter(text => text.includes("blockedRecovery"));
    assert.equal(blockers.length, 1);
    assert.match(blockers[0], /BLOCKED/);
    assert.doesNotMatch(blockers[0], /before the test runner started/);
    assert.equal(alerts.filter(text => text.includes("settlement=complete")).length, 1);
    assert.deepEqual(f.notices, [], "progress and human recovery guidance must not enqueue parent turns");
  });
});

test("initial environment BLOCKED recovery refuses unproven, changed, or unapproved state", async () => {
  await batchFixture(async f => {
    const common = { workflow: "matt-tdd", task: "shared", implementation: implementation(T1),
      laneTasks: { implement: "implement", standards: "standards", spec: "spec" } };
    const first = await f.runtime.dispatch({ ...common, batch: batchParams(f.fixedPoint) }, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ value: "draft\n", workerOverride: { structuredOutput: environmentBlocked } });
    const resume = { ...common, blockedRecovery: { dispatchId: first.details.dispatchId } };
    const paths = { ...resume, implementation: { ...resume.implementation, allowedFiles: ["parser.mjs", "extra.mjs"] } };
    await assert.rejects(() => f.runtime.dispatch(paths, undefined, f.ctx), /exact.*envelope/i);
    f.ctx.ui.confirm = async () => false;
    await assert.rejects(() => f.runtime.dispatch(resume, undefined, f.ctx), /not approved/);
    f.ctx.ui.confirm = async () => true;
    await writeFile(join(f.ctx.cwd, "parser.mjs"), "changed\n");
    await assert.rejects(() => f.runtime.dispatch(resume, undefined, f.ctx), /snapshot.*stale/);
    await writeFile(join(f.ctx.cwd, "parser.mjs"), "draft\n");
    await git(f.ctx.cwd, "add", "parser.mjs");
    await assert.rejects(() => f.runtime.dispatch(resume, undefined, f.ctx), /snapshot.*stale/);
    await git(f.ctx.cwd, "restore", "--staged", "parser.mjs");
    await f.runtime.dispatch(resume, undefined, f.ctx);
    await writeFile(join(f.ctx.cwd, SPEC), `${specContent}\nChanged acceptance.\n`);
    await f.runtime.flush();
    assert.equal(f.launches.length, 1);
    assert.match(f.notices.at(-1), /spec content drift/i);
  });

  await batchFixture(async f => {
    const common = { workflow: "matt-tdd", task: "shared", implementation: implementation(T1),
      laneTasks: { implement: "implement", standards: "standards", spec: "spec" } };
    const first = await f.runtime.dispatch({ ...common, batch: batchParams(f.fixedPoint) }, undefined, f.ctx);
    await f.runtime.flush();
    const { environmentBlocker, ...businessBlocked } = environmentBlocked;
    await f.settle({ workerOverride: { structuredOutput: businessBlocked } });
    await assert.rejects(() => f.runtime.dispatch({ ...common, blockedRecovery: { dispatchId: first.details.dispatchId } },
      undefined, f.ctx), /no sealed environment blocker/i);
    assert.equal(f.launches.length, 1);
  });
});

test("a risk-accepted batch candidate needs its exact commit and tracker acceptance receipt before advancing", async () => {
  await batchFixture(async f => {
    const params = { workflow: "matt-tdd", task: "shared", implementation: implementation(T1),
      laneTasks: { implement: "implement", standards: "standards", spec: "spec" },
      batch: batchParams(f.fixedPoint) };
    const initial = await f.runtime.dispatch(params, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ reviews: { standards: { ...review("standards"), structuredOutput: {
      axis: "standards", verdict: "FAIL", summary: "minor residual", notes: [], findings: [{
        id: "minor", rootCauseId: "cleanup", severity: "P2", title: "cleanup convention",
        basis: { kind: "standard", reference: "convention" }, evidence: "cleanup order",
        expected: "release first", actual: "mark first", locations: ["parser.mjs:1"],
        classification: "original", relatedFindingIds: [], affectedBy: [], recommendation: "release first",
      }],
    } } } });
    const accepted = await f.runtime.dispatch({ ...params, batch: undefined, laneTasks: undefined,
      acceptRisk: { dispatchId: initial.details.dispatchId, findingIds: ["standards:minor"],
        reason: "bounded known risk", evidence: "mitigation reviewed" },
    }, undefined, f.ctx);
    assert.equal(f.prompts, 2, "batch permission must not accept risks");
    await git(f.ctx.cwd, "add", "parser.mjs");
    await git(f.ctx.cwd, "commit", "-qm", "candidate");
    await resolveTicket(f.ctx.cwd, T1, await git(f.ctx.cwd, "rev-parse", "HEAD"));
    const next = { ...params, batch: undefined, implementation: implementation(T2) };
    await assert.rejects(() => f.runtime.dispatch(next, undefined, f.ctx), /exact host Risk acceptance ID/);
    const content = await readFile(join(f.ctx.cwd, T1), "utf8");
    await writeFile(join(f.ctx.cwd, T1), `${content}\nRisk acceptance: ${accepted.details.dispatchId}\n`);
    f.reload();
    await f.runtime.dispatch(next, undefined, f.ctx);
    await f.runtime.flush();
    assert.equal(f.launches.length, 2);
    assert.equal(f.prompts, 2);
  });
});

test("a batch needs one genuine confirmation of the sealed plan", async () => {
  await batchFixture(async f => {
    const params = { workflow: "matt-tdd", task: "shared", implementation: implementation(T1),
      laneTasks: { implement: "implement", standards: "standards", spec: "spec" },
      batch: batchParams(f.fixedPoint) };
    const records = () => f.entries.filter(entry => entry.customType === BATCH_ENTRY).length;
    await assert.rejects(() => f.runtime.dispatch(params, undefined, { ...f.ctx, hasUI: false }),
      /confirmation.*no workflow was queued/i);
    assert.equal(records(), 0);
    assert.equal(f.runtime.plans.size, 0);
    await assert.rejects(() => f.runtime.dispatch(params, undefined,
      { ...f.ctx, ui: { confirm: async () => false } }), /not authorized|no workflow was queued/i);
    assert.equal(records(), 0);
    assert.equal(f.prompts, 0, "the explicit denial path never persists a capability");
    const queued = await f.runtime.dispatch(params, undefined, f.ctx);
    assert.equal(queued.details.authorization, "batch-plan");
    assert.equal(f.prompts, 1);
    const message = f.messages.join("\n");
    for (const value of [SPEC, f.fixedPoint, T1, T2, "parser slice", "second slice", "parser.mjs"]) {
      assert.ok(message.includes(value), value);
    }
    assert.equal(f.entries.filter(entry => entry.customType === BATCH_ENTRY).at(-1).data.kind, "batch");
    assert.equal(f.runtime.authorization.current().source, "batch-confirmed-plan");
    await assert.rejects(() => f.runtime.dispatch({ workflow: "matt-research", task: "research",
      batch: batchParams(f.fixedPoint) }, undefined, f.ctx), /only apply to matt-tdd|only.*matt-tdd/i);
  });
});

test("one confirmation runs two declared tickets serially and requires the exact reviewed commit plus tracker writeback", async () => {
  await batchFixture(async f => {
    const base = { workflow: "matt-tdd", task: "shared",
      laneTasks: { implement: "implement", standards: "standards", spec: "spec" } };
    const first = await f.runtime.dispatch({ ...base, implementation: implementation(T1),
      batch: batchParams(f.fixedPoint) }, undefined, f.ctx);
    assert.equal(first.details.authorization, "batch-plan");
    await f.runtime.flush();
    const settled = await f.settle();
    assert.deepEqual(settled.calls, ["claim", "implement", "evidence", "standards", "spec"]);
    assert.equal(settled.status.state, "complete");
    const firstRecord = f.entries.filter(entry => entry.customType === IMPLEMENTATION_ENTRY).at(-1).data;
    assert.equal(firstRecord.batch.ticket, T1);
    assert.equal(firstRecord.batchOutcome.complete, true);
    assert.match(firstRecord.batchOutcome.candidate.tree, /^[0-9a-f]{40}$/);
    assert.equal(firstRecord.batchOutcome.candidate.snapshotId, firstRecord.snapshotId);
    await assert.rejects(() => f.runtime.dispatch({ ...base, implementation: implementation(T2) },
      undefined, { ...f.ctx, hasUI: false }), /no workflow was queued/i);
    assert.equal(f.runtime.plans.size, 0);
    await assert.rejects(() => f.runtime.dispatch({ ...base, implementation: implementation(T2),
      batch: batchParams(f.fixedPoint) }, undefined, { ...f.ctx, hasUI: false }), /no workflow was queued/i);
    assert.equal(f.prompts, 1);
    await git(f.ctx.cwd, "add", "parser.mjs");
    await git(f.ctx.cwd, "commit", "-qm", "reviewed candidate");
    const commit = await git(f.ctx.cwd, "rev-parse", "HEAD");
    assert.equal(await git(f.ctx.cwd, "rev-parse", "HEAD^{tree}"), firstRecord.batchOutcome.candidate.tree);
    await resolveTicket(f.ctx.cwd, T1, commit);
    f.reload();
    const second = await f.runtime.dispatch({ ...base, implementation: implementation(T2) },
      undefined, { ...f.ctx, hasUI: false });
    assert.equal(second.details.authorization, "batch-plan", "the restored same-session batch issues the next ticket grant");
    assert.equal(f.prompts, 1, "no second confirmation for a declared ticket");
    await f.runtime.flush();
    const secondRun = await f.settle({ value: "second slice\n" });
    assert.equal(secondRun.status.state, "complete");
    assert.deepEqual(secondRun.calls, ["claim", "implement", "evidence", "standards", "spec"]);
  });
});

test("batch progression rejects pending review, missing dual PASS, wrong or excess commits, forged trackers and drift", async () => {
  const base = { workflow: "matt-tdd", task: "shared",
    laneTasks: { implement: "implement", standards: "standards", spec: "spec" } };
  await batchFixture(async f => {
    await f.runtime.dispatch({ ...base, implementation: implementation(T1),
      batch: batchParams(f.fixedPoint) }, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle();
    await git(f.ctx.cwd, "add", "parser.mjs");
    await git(f.ctx.cwd, "commit", "-qm", "reviewed candidate");
    const commit = await git(f.ctx.cwd, "rev-parse", "HEAD");
    await resolveTicket(f.ctx.cwd, T1, commit);
    await git(f.ctx.cwd, "commit", "-q", "--allow-empty", "-m", "unrelated extra commit");
    await assert.rejects(() => f.runtime.dispatch({ ...base, implementation: implementation(T2) },
      undefined, { ...f.ctx, hasUI: false }), /no workflow was queued/i);
    assert.equal(f.runtime.plans.size, 0);
  });
  await batchFixture(async f => {
    await f.runtime.dispatch({ ...base, implementation: implementation(T1),
      batch: batchParams(f.fixedPoint) }, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ reviews: {
      standards: review("standards"),
      spec: { key: "spec", ok: true, structuredOutput: { axis: "spec", verdict: "FAIL", summary: "blocked",
        findings: [{ id: "parse", rootCauseId: "parser", severity: "P1", title: "acceptance",
          basis: { kind: "acceptance", reference: "AC1" }, evidence: "missing behavior", expected: "works",
          actual: "missing", locations: ["parser.mjs:1"], classification: "original",
          relatedFindingIds: [], affectedBy: [], recommendation: "implement it" }], notes: [] } },
    } });
    const record = f.entries.filter(entry => entry.customType === IMPLEMENTATION_ENTRY).at(-1).data;
    assert.equal(record.batchOutcome.complete, false);
    await git(f.ctx.cwd, "add", "parser.mjs");
    await git(f.ctx.cwd, "commit", "-qm", "candidate without PASS");
    await resolveTicket(f.ctx.cwd, T1, await git(f.ctx.cwd, "rev-parse", "HEAD"));
    await assert.rejects(() => f.runtime.dispatch({ ...base, implementation: implementation(T2) },
      undefined, { ...f.ctx, hasUI: false }), /no workflow was queued/i);
  });
  await batchFixture(async f => {
    await f.runtime.dispatch({ ...base, implementation: implementation(T1),
      batch: batchParams(f.fixedPoint) }, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle();
    await git(f.ctx.cwd, "add", "parser.mjs");
    await git(f.ctx.cwd, "commit", "-qm", "reviewed candidate");
    await resolveTicket(f.ctx.cwd, T1, f.fixedPoint);
    await assert.rejects(() => f.runtime.dispatch({ ...base, implementation: implementation(T2) },
      undefined, { ...f.ctx, hasUI: false }), /no workflow was queued/i);
  });
  await batchFixture(async f => {
    await f.runtime.dispatch({ ...base, implementation: implementation(T1),
      batch: batchParams(f.fixedPoint) }, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle();
    await git(f.ctx.cwd, "add", "parser.mjs");
    await git(f.ctx.cwd, "commit", "-qm", "reviewed candidate");
    const commit = await git(f.ctx.cwd, "rev-parse", "HEAD");
    await resolveTicket(f.ctx.cwd, T1, commit);
    await writeFile(join(f.ctx.cwd, T2), ticket("02: second", SPEC, T1, "changed requirement"));
    await assert.rejects(() => f.runtime.dispatch({ ...base, implementation: implementation(T2) },
      undefined, { ...f.ctx, hasUI: false }), /drift|changed|no workflow was queued/i);
  });
});

test("queued batch work is cancelled by revocation and neither fork nor a new session inherits the capability", async () => {
  const base = { workflow: "matt-tdd", task: "shared",
    laneTasks: { implement: "implement", standards: "standards", spec: "spec" } };
  await batchFixture(async f => {
    await f.runtime.dispatch({ ...base, implementation: implementation(T1),
      batch: batchParams(f.fixedPoint) }, undefined, f.ctx);
    f.runtime.revoke("session-tree-changed");
    await f.runtime.flush();
    assert.equal(f.launches.length, 0, "cancelled queued work cannot launch a writer");
    await assert.rejects(() => f.runtime.dispatch({ ...base, implementation: implementation(T1),
      batch: batchParams(f.fixedPoint) }, undefined, { ...f.ctx, hasUI: false }),
    /confirmation.*no workflow was queued/i);
    const reapproved = await f.runtime.dispatch({ ...base, implementation: implementation(T1),
      batch: batchParams(f.fixedPoint) }, undefined, f.ctx);
    assert.equal(reapproved.details.authorization, "batch-plan");
    f.reload("fork");
    await assert.rejects(() => f.runtime.dispatch({ ...base, implementation: implementation(T1) },
      undefined, { ...f.ctx, hasUI: false }), /no workflow was queued/i);
    f.reload("new");
    await assert.rejects(() => f.runtime.dispatch({ ...base, implementation: implementation(T1) },
      undefined, { ...f.ctx, hasUI: false }), /no workflow was queued/i);
  });
});

test("undeclared tickets, files outside the approved envelope and new follow-up files cannot silently expand a batch", async () => {
  const base = { workflow: "matt-tdd", task: "shared",
    laneTasks: { implement: "implement", standards: "standards", spec: "spec" } };
  await batchFixture(async f => {
    await assert.rejects(() => f.runtime.dispatch({ ...base,
      implementation: implementation(T3), batch: batchParams(f.fixedPoint) }, undefined, f.ctx),
      /not declared|undeclared|no workflow was queued/i);
    await assert.rejects(() => f.runtime.dispatch({ ...base,
      implementation: { ...implementation(T1), allowedFiles: ["parser.mjs", "other.mjs"] },
      batch: batchParams(f.fixedPoint) }, undefined, f.ctx),
      /envelope|approved|no workflow was queued/i);
    assert.equal(f.runtime.plans.size, 0);
    const queued = await f.runtime.dispatch({ ...base, implementation: implementation(T1),
      batch: batchParams(f.fixedPoint) }, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ reviews: {
      standards: review("standards"),
      spec: { key: "spec", ok: true, structuredOutput: { axis: "spec", verdict: "FAIL", summary: "blocked",
        findings: [{ id: "parse", rootCauseId: "parser", severity: "P1", title: "acceptance",
          basis: { kind: "acceptance", reference: "AC1" }, evidence: "missing behavior", expected: "works",
          actual: "missing", locations: ["parser.mjs:1"], classification: "original",
          relatedFindingIds: [], affectedBy: [], recommendation: "implement it" }], notes: [] } },
    } });
    const repair = { previousDispatchId: queued.details.dispatchId,
      groups: [{ id: "parser", findingIds: ["spec:parse"], contract: "implement behavior",
        preserve: ["original parser contract"], validationOrder: "validate -> parse",
        callPath: ["public -> parser"], examples: ["works"] }] };
    const followUp = await f.runtime.dispatch({ ...base, implementation: implementation(T1),
      repair }, undefined, { ...f.ctx, hasUI: false });
    assert.equal(followUp.details.authorization, "batch-plan",
      "an omitted batch parameter keeps the trusted host batch binding for the same ticket");
    const followUpRecord = f.entries.filter(entry => entry.customType === IMPLEMENTATION_ENTRY).at(-1).data;
    assert.equal(followUpRecord.batch.ticket, T1);
    await f.runtime.flush();
    await f.settle({ value: "repaired\n" });
    const widened = { ...implementation(T1), allowedFiles: ["parser.mjs", "extra.txt"] };
    await assert.rejects(() => f.runtime.dispatch({ ...base, implementation: widened,
      repair: { ...repair, previousDispatchId: followUpRecord.id } }, undefined, { ...f.ctx, hasUI: false }),
    /no workflow was queued/i);
    const amended = await f.runtime.dispatch({ ...base,
      implementation: widened, repair: { ...repair, previousDispatchId: followUpRecord.id } },
    undefined, f.ctx);
    assert.equal(amended.details.authorization, "user-confirmed");
    assert.equal(f.prompts, 2, "additive same-ticket reapproval is explicit, never a silent batch expansion");
  });
});

test("preapproved final regression revokes old PASS without prompting and resumes the same writer before fresh review", async () => {
  await batchFixture(async f => {
    const common = { workflow: "matt-tdd", task: "shared", implementation: implementation(T1) };
    const command = "if grep -qx 'first slice' parser.mjs; then echo 'parser regression'; exit 1; fi";
    const plan = batchParams(f.fixedPoint);
    plan.tickets[0].finalValidationCommands = [command];
    await writeFile(join(f.ctx.cwd, `${SPEC}.dispatch.json`), JSON.stringify({ tickets: plan.tickets }));
    await f.runtime.beginBatchCommand(SPEC, f.ctx);
    const initial = await f.runtime.dispatch({ ...common,
      laneTasks: { implement: "implement", standards: "standards", spec: "spec" } }, undefined, f.ctx);
    await f.runtime.flush();
    assert.equal((await f.settle()).status.state, "complete");
    const request = { ...common, laneTasks: { implement: "fix the regression" }, finalValidationRepair: {
      dispatchId: initial.details.dispatchId,
      command,
      expectedFailure: "parser regression",
    } };
    const failedGate = f.entries.filter(entry => entry.customType === IMPLEMENTATION_ENTRY).at(-1).data;
    assert.equal(failedGate.batchOutcome.resultsValid, true);
    assert.equal(failedGate.batchOutcome.complete, false);
    assert.equal(failedGate.requiredValidation.ok, false);
    const formalReview = dispatchId => ({ ...common, review: { dispatchId },
      laneTasks: { standards: "fresh standards", spec: "fresh spec" } });
    await assert.rejects(() => f.runtime.dispatch({ ...request, finalValidationRepair: {
      ...request.finalValidationRepair, command: `${command}; true`,
    } }, undefined, { ...f.ctx, hasUI: false }), /confirmation/i);
    const queued = await f.runtime.dispatch(request, undefined, { ...f.ctx, hasUI: false });
    assert.equal(queued.details.reviewPending, true);
    assert.equal(f.prompts, 1);
    // Reload cancels a plan that was never launched, but must not undo the observed regression.
    f.reload();
    const record = () => f.entries.filter(entry => entry.customType === IMPLEMENTATION_ENTRY).at(-1).data;
    const source = f.entries.filter(entry => entry.customType === IMPLEMENTATION_ENTRY &&
      entry.data.id === initial.details.dispatchId).at(-1).data;
    assert.equal(source.batchOutcome.complete, false);
    assert.equal(source.finalValidation.failure.exitCode, 1);
    const retry = { ...request, finalValidationRepair: { dispatchId: source.id } };
    const cancelledByDrift = await f.runtime.dispatch(retry, undefined, { ...f.ctx, hasUI: false });
    await git(f.ctx.cwd, "add", "parser.mjs");
    await f.runtime.flush();
    assert.equal(f.launches.length, 1);
    assert.equal(record().id, cancelledByDrift.details.dispatchId);
    assert.equal(record().state, "cancelled");
    await git(f.ctx.cwd, "restore", "--staged", "parser.mjs");
    const pending = await f.runtime.dispatch(retry, undefined, { ...f.ctx, hasUI: false });
    await f.runtime.flush();
    const repaired = await f.settle({ value: "first slice\nincomplete repair\n" });
    assert.equal(repaired.itemsSeen[0].resume, "run-0-writer");
    assert.deepEqual(repaired.calls, ["claim", "implement", "evidence"]);
    assert.equal(record().batchOutcome.complete, false);
    f.reload();
    await assert.rejects(() => f.runtime.dispatch(formalReview(pending.details.dispatchId), undefined, f.ctx), /still fails/);
    assert.equal(f.runtime.plans.size, 0);
    const second = await f.runtime.dispatch({ ...retry, finalValidationRepair: { dispatchId: pending.details.dispatchId } },
      undefined, { ...f.ctx, hasUI: false });
    await f.runtime.flush();
    const corrected = await f.settle({ value: "corrected slice\n" });
    assert.equal(corrected.itemsSeen[0].resume, "run-1-writer");
    await f.runtime.dispatch(formalReview(second.details.dispatchId), undefined, { ...f.ctx, hasUI: false });
    await f.runtime.flush();
    const reviewed = await f.settle();
    assert.deepEqual(reviewed.calls, ["standards", "spec"]);
    assert.equal(record().batchOutcome.complete, true);
    assert.equal(record().finalValidationPass.snapshotId, record().snapshotId);
    const { cwd } = f.ctx;
    await git(cwd, "add", "parser.mjs");
    await git(cwd, "commit", "-qm", "fixed");
    const commit = await git(cwd, "rev-parse", "HEAD");
    const next = { ...common, implementation: implementation(T2),
      laneTasks: { implement: "next", standards: "standards", spec: "spec" } };
    await assert.rejects(() => f.runtime.dispatch(next, undefined, f.ctx), /must be resolved/);
    await resolveTicket(cwd, T1, commit);
    await f.runtime.dispatch(next, undefined, f.ctx);
    assert.equal(f.prompts, 1);
  });
});

for (const reintroduceFirst of [false, true]) {
  test(`a second final check after fresh dual PASS ${reintroduceFirst ? "cannot regress the first check" : "preserves the first check and shared repair budget"}`, async () => {
    await batchFixture(async f => {
      const common = { workflow: "matt-tdd", task: "shared", implementation: implementation(T1) };
      const request = (dispatchId, marker) => ({ ...common, laneTasks: { implement: "fix the regression" },
        finalValidationRepair: { dispatchId,
          command: `if grep -qx '${marker}' parser.mjs; then echo '${marker} regression'; exit 1; fi`,
          expectedFailure: `${marker} regression` } });
      const send = params => f.runtime.dispatch(params, undefined, f.ctx);
      const reviewCandidate = dispatchId => send({ ...common, review: { dispatchId },
        laneTasks: { standards: "fresh standards", spec: "fresh spec" } });
      const record = id => f.entries.findLast(entry =>
        entry.customType === IMPLEMENTATION_ENTRY && entry.data.id === id).data;
      const initial = await send({ ...common, batch: batchParams(f.fixedPoint),
        laneTasks: { implement: "implement", standards: "standards", spec: "spec" } });
      await f.runtime.flush();
      await f.settle({ value: "first\nsecond\nthird\n" });
      const first = await send(request(initial.details.dispatchId, "first"));
      await f.runtime.flush();
      await f.settle({ value: "second\nthird\n" });
      await assert.rejects(() => send(request(first.details.dispatchId, "second")), /dual PASS|dual-PASS/i);
      assert.equal(f.prompts, 2, "an unresolved validation cannot be replaced");
      const firstReview = await reviewCandidate(first.details.dispatchId);
      await f.runtime.flush();
      await f.settle();
      const firstReviewId = firstReview.details.dispatchId;
      const firstProof = structuredClone(record(firstReviewId).finalValidation);
      assert.equal(record(firstReviewId).batchOutcome.complete, true);
      if (!reintroduceFirst) {
        // Simulate an already-reviewed v0.2.44 receipt restored from this session.
        const pass = record(firstReviewId).finalValidationPass;
        [pass.result] = pass.results;
        delete pass.results;
      }
      f.reload();
      await assert.rejects(() => send(request(firstReviewId, "first")), /must differ/);
      const nextRequest = request(firstReviewId, "second");
      await assert.rejects(() => f.runtime.dispatch(nextRequest, undefined, { ...f.ctx, hasUI: false }), /confirmation/);
      assert.equal(record(firstReviewId).batchOutcome.complete, true);
      const second = await send(nextRequest);
      assert.equal(f.prompts, 3);
      assert.equal(record(firstReviewId).batchOutcome.complete, false);
      await f.runtime.flush();
      const repaired = await f.settle({ value: reintroduceFirst ? "first\nthird\n" : "third\n" });
      assert.equal(repaired.itemsSeen[0].resume, "run-1-writer");
      const pending = record(second.details.dispatchId);
      assert.equal(pending.finalValidation.attempts, 2);
      assert.equal(pending.finalValidation.priorChecks[0].failure.outputSha256, firstProof.failure.outputSha256);
      assert.equal(pending.finalValidation.priorChecks[0].sourceId, firstProof.sourceId);
      f.reload();
      if (reintroduceFirst) {
        await assert.rejects(() => reviewCandidate(pending.id), /previously registered final validation/i);
        assert.equal(f.runtime.plans.size, 0);
        assert.equal(record(pending.id).batchOutcome.complete, false);
        return;
      }
      const final = await reviewCandidate(pending.id);
      await f.runtime.flush();
      assert.deepEqual((await f.settle()).calls, ["standards", "spec"]);
      const delivered = record(final.details.dispatchId);
      assert.equal(delivered.batchOutcome.complete, true);
      assert.deepEqual(delivered.finalValidationPass.results.map(row => [row.sourceId, row.exitCode]), [
        [initial.details.dispatchId, 0], [firstReviewId, 0],
      ]);
      await assert.rejects(() => send(request(delivered.id, "third")), /budget exhausted/);
      assert.equal(f.prompts, 3, "a fresh command cannot reset the ticket-wide repair budget");
    });
  });
}

test("final regression must pass on the parent and match the candidate symptom; proven red stays locked without a writer", async () => {
  await batchFixture(async f => {
    const common = { workflow: "matt-tdd", task: "shared", implementation: implementation(T1) };
    const initial = await f.runtime.dispatch({ ...common, batch: batchParams(f.fixedPoint),
      laneTasks: { implement: "implement", standards: "standards", spec: "spec" } }, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ workerOverride: { resumability: { state: "unavailable" } } });
    const source = () => f.entries.filter(entry => entry.customType === IMPLEMENTATION_ENTRY &&
      entry.data.id === initial.details.dispatchId).at(-1).data;
    const request = command => ({ ...common, laneTasks: { implement: "fix" }, finalValidationRepair: {
      dispatchId: initial.details.dispatchId, command, expectedFailure: "parser regression",
    } });
    await assert.rejects(() => f.runtime.dispatch(request("echo 'parser regression'; exit 1"), undefined, f.ctx), /clean parent/);
    await assert.rejects(() => f.runtime.dispatch(request(
      "if grep -qx 'first slice' parser.mjs; then echo 'different failure'; exit 1; fi"), undefined, f.ctx), /expected text/);
    await assert.rejects(() => f.runtime.dispatch(request(
      "if grep -qx 'first slice' parser.mjs; then touch output.tmp; echo 'parser regression'; exit 1; fi"), undefined, f.ctx),
    /modified the isolated checkout/);
    assert.equal(source().batchOutcome.complete, true, "an unproven failure must not replace the review outcome");
    await assert.rejects(() => f.runtime.dispatch(request(
      "if grep -qx 'first slice' parser.mjs; then echo 'parser regression'; exit 1; fi"), undefined, f.ctx), /writer is unavailable/);
    assert.equal(source().batchOutcome.complete, false);
    const { cwd } = f.ctx;
    await git(cwd, "add", "parser.mjs");
    await git(cwd, "commit", "-qm", "premature delivery");
    await resolveTicket(cwd, T1, await git(cwd, "rev-parse", "HEAD"));
    f.reload();
    await assert.rejects(() => f.runtime.dispatch({ ...common, implementation: implementation(T2),
      laneTasks: { implement: "next", standards: "standards", spec: "spec" } }, undefined, f.ctx), /final validation/i);
    assert.equal(f.launches.length, 1);
  });
});

test("batch envelope recollection runs only the collector and preserves candidate commit and tracker gates", async () => {
  await batchFixture(async f => {
    const base = { workflow: "matt-tdd", task: "shared",
      laneTasks: { implement: "implement", standards: "standards", spec: "spec" } };
    const initial = await f.runtime.dispatch({ ...base, implementation: implementation(T1),
      batch: batchParams(f.fixedPoint) }, undefined, f.ctx);
    await f.runtime.flush();
    const failed = await f.settle({ files: { "response.mjs": "export const candidates = [];\n" } });
    assert.equal(failed.status.state, "failed");
    assert.deepEqual(failed.calls, ["claim", "implement", "evidence"]);
    const source = f.entries.filter(entry => entry.customType === IMPLEMENTATION_ENTRY).at(-1).data;
    assert.deepEqual(source.envelopeViolation.paths, ["response.mjs"]);
    assert.equal(source.batchOutcome.complete, false);
    const scope = { ...implementation(T1), allowedFiles: ["parser.mjs", "response.mjs"] };
    const recollected = await f.runtime.dispatch({ ...base, laneTasks: {}, implementation: scope,
      recollect: { dispatchId: initial.details.dispatchId } }, undefined, f.ctx);
    assert.equal(recollected.details.authorization, "user-confirmed");
    assert.equal(f.prompts, 2);
    await f.runtime.flush();
    const captured = await f.settle();
    assert.deepEqual(captured.calls, ["evidence"]);
    assert.equal(captured.status.state, "complete");
    const pending = f.entries.filter(entry => entry.customType === IMPLEMENTATION_ENTRY).at(-1).data;
    assert.equal(pending.batch.id, source.batch.id);
    assert.equal(pending.batchOutcome.complete, false);
    assert.ok(pending.batchOutcome.candidate.tree);
    await assert.rejects(() => f.runtime.dispatch({ ...base, implementation: implementation(T2) },
      undefined, f.ctx), /must be resolved/);
    await f.runtime.dispatch({ ...base, laneTasks: { standards: "standards", spec: "spec" },
      implementation: scope, review: { dispatchId: pending.id } }, undefined, f.ctx);
    await f.runtime.flush();
    const reviewed = await f.settle();
    assert.deepEqual(reviewed.calls, ["standards", "spec"]);
    assert.equal(reviewed.status.state, "complete");
    const final = f.entries.filter(entry => entry.customType === IMPLEMENTATION_ENTRY).at(-1).data;
    assert.equal(final.batchOutcome.complete, true);
    const cwd = f.ctx.cwd;
    await git(cwd, "add", "parser.mjs", "response.mjs");
    await git(cwd, "commit", "-qm", "implemented");
    const commit = await git(cwd, "rev-parse", "HEAD");
    assert.equal(await git(cwd, "rev-parse", "HEAD^{tree}"), final.batchOutcome.candidate.tree);
    assert.equal(await git(cwd, "rev-parse", "HEAD^"), final.batchOutcome.candidate.head);
    await assert.rejects(() => f.runtime.dispatch({ ...base, implementation: implementation(T2) },
      undefined, f.ctx), /must be resolved/);
    await resolveTicket(cwd, T1, commit);
    await f.runtime.dispatch({ ...base, implementation: implementation(T2) }, undefined, f.ctx);
    assert.equal(f.prompts, 2, "the original batch plan still authorizes the next declared ticket");
  });
});

test("batch state restores on reload, survives matt-implement-spec, and revokes on other skills, expiry, fork and cancellation", async () => {
  let now = 1_000;
  const entries = [];
  const store = createBatchAuthorization({ now: () => now, uuid: () => "batch-1",
    persist: data => entries.push({ type: "custom", customType: BATCH_ENTRY, data }) });
  store.start("session", []);
  const sealed = { version: 1, kind: "batch", sessionId: "session", invocationId: "batch-1",
    identity: { sessionId: "session", projectRoot: "/project", branch: "main", head: "a".repeat(40) },
    fixedPoint: "b".repeat(40), spec: { path: SPEC, digest: "spec-digest" }, tickets: [],
    at: now, expiresAt: now + 1_000 };
  store.establish(sealed);
  assert.equal(store.active("batch-1"), true);
  store.observeInput("/skill:matt-implement-spec .x-matt/work/demo/spec.md", "interactive");
  assert.equal(store.active("batch-1"), true, "the batch entry skill cannot revoke its own trusted capability");
  store.observeInput("/skill:matt-grilling", "interactive");
  assert.equal(store.active("batch-1"), false);
  assert.equal(store.current().kind, "revoked");
  store.start("session", entries);
  assert.equal(store.current().kind, "revoked");
  store.start("session", entries, false);
  assert.equal(store.current(), null);

  const restored = createBatchAuthorization({ now: () => now, persist: () => {} });
  restored.start("session", entries.filter(entry => entry.data.kind === "batch"));
  assert.equal(restored.active("batch-1"), true);
  now += 24 * 60 * 60 * 1000 + 1;
  assert.equal(restored.active("batch-1"), true);
  restored.start("session", [{ type: "custom", customType: BATCH_ENTRY, data: sealed }]);
  assert.equal(restored.active("batch-1"), false, "legacy confirmed authorization still expires");
  restored.start("other-session", entries.filter(entry => entry.data.kind === "batch"));
  assert.equal(restored.active("batch-1"), false, "another session cannot inherit a batch grant");
  const singles = createDispatchAuthorization();
  singles.start("session", entries);
  assert.equal(singles.current(), null, "batch entries never become single-ticket grants");
  const normal = [];
  const single = createDispatchAuthorization({ persist: data => normal.push({ type: "custom", customType: AUTH_ENTRY, data }) });
  single.start("session", []);
  single.grant({ sessionId: "session", projectRoot: "/project", branch: "main", head: "a".repeat(40) },
    normalizeBatchPlan(batchParams("b".repeat(40))).tickets[0], "batch-plan");
  const batchStore = createBatchAuthorization({ persist: () => {} });
  batchStore.start("session", normal);
  assert.equal(batchStore.current(), null, "ordinary grants never become batch capabilities");
});

test("batch validation rejects invalid Parent/type/status paths, self cycles and unresolved startup blockers", async () => {
  await repoFixture(async ({ cwd, fixedPoint }) => {
    await writeFile(join(cwd, ".git/info/exclude"), ".x-matt/\n");
    const identity = { sessionId: "session", projectRoot: cwd, branch: "main", head: fixedPoint };
    const plan = batchParams(fixedPoint);
    await writeFeature(cwd);
    const sealed = await prepareBatchPlan(cwd, plan, identity);
    assert.deepEqual(sealed.tickets.map(item => item.ticket), [T1, T2]);
    assert.equal(sealed.spec.path, SPEC);
    assert.match(sealed.spec.digest, /^[0-9a-f]{64}$/);
    await assert.rejects(() => prepareBatchPlan(cwd,
      { ...plan, tickets: [...plan.tickets].reverse() }, identity), /place unresolved blocker/);
    for (const [content, error] of [
      [ticket("01: parser", ".x-matt/work/other/spec.md", "None"), /Parent/],
      [ticket("01: parser", SPEC, "None").replace("Type: ticket", "Type: spec"), /Type/],
      [ticket("01: parser", SPEC, "None").replace("Status: ready-for-agent", "Status: draft"), /Status/],
      [ticket("01: parser", SPEC, T1), /cycle|self/i],
      [ticket("01: parser", SPEC, ".x-matt/work/demo/issues/99-missing.md"), /resolved|read/i],
    ]) {
      await writeFile(join(cwd, T1), content);
      await assert.rejects(() => prepareBatchPlan(cwd, plan, identity), error);
    }
    await writeFeature(cwd);
    await writeFile(join(cwd, T1), ticket("01: parser", SPEC, T2));
    await assert.rejects(() => prepareBatchPlan(cwd, plan, identity), /cycle/i);
    await writeFeature(cwd);
    await resolveTicket(cwd, T3, fixedPoint);
    await writeFile(join(cwd, T1), ticket("01: parser", SPEC, T3));
    const resumed = await prepareBatchPlan(cwd, plan, identity);
    assert.deepEqual(resumed.externalBlockers.map(item => item.ticket), [T3]);
    await writeFeature(cwd);
    await writeFile(join(cwd, "parser.mjs"), "dirty\n");
    await assert.rejects(() => prepareBatchPlan(cwd, plan, identity), /clean worktree/i);
    await git(cwd, "checkout", "--", "parser.mjs");
    await assert.rejects(() => prepareBatchPlan(cwd,
      { ...plan, fixedPoint: "not-a-commit" }, identity), /fixed.?point|full commit/i);
    await assert.rejects(() => prepareBatchPlan(cwd,
      { ...plan, tickets: [...plan.tickets, plan.tickets[0]] }, identity), /more than once|duplicate/i);
    assert.throws(() => normalizeBatchPlan({ ...plan, tickets: [] }), /tickets/);
    assert.throws(() => normalizeBatchPlan({ ...plan, tickets: [{ ...plan.tickets[0], allowedFiles: ["../outside"] }] }),
      /allowedFiles/);
    assert.throws(() => normalizeBatchPlan({ ...plan, tickets: [{ ...plan.tickets[0], ticketDigest: "model" }] }),
      /unsupported|ticketDigest|host/i);
  });
});

test("candidate tree proof uses an isolated index/object store without touching the real repo and binds modes and new files", async () => {
  await repoFixture(async ({ cwd, fixedPoint }) => {
    await writeFile(join(cwd, "parser.mjs"), "patched\n");
    await writeFile(join(cwd, "run.sh"), "#!/bin/sh\necho reviewed\n");
    await chmod(join(cwd, "run.sh"), 0o755);
    await writeFile(join(cwd, "extra.txt"), "extra\n");
    const pack = await collectReviewEvidence(cwd);
    await writeFile(join(cwd, "parser.mjs"), "unreviewed replacement\n");
    await assert.rejects(() => collectCandidateTreeProof(cwd, pack,
      { allowedFiles: ["parser.mjs", "run.sh", "extra.txt"], batch: { fixedPoint } }),
    /content|drift|match/i, "the same M status cannot rebind later content to the reviewed snapshot");
    await writeFile(join(cwd, "parser.mjs"), "patched\n");
    const index = await readFile(join(cwd, ".git/index"));
    const objects = (await readdir(join(cwd, ".git/objects"), { recursive: true })).sort();
    const status = await git(cwd, "status", "--porcelain=v1");
    await assert.rejects(() => collectCandidateTreeProof(cwd, pack,
      { allowedFiles: ["parser.mjs", "run.sh"], batch: { fixedPoint } }), /approved|outside/i);
    const proof = await collectCandidateTreeProof(cwd, pack,
      { allowedFiles: ["parser.mjs", "run.sh", "extra.txt"], batch: { fixedPoint } });
    assert.equal(proof.head, pack.head);
    assert.equal(proof.snapshotId, pack.snapshotId);
    assert.equal(proof.fixedPoint, fixedPoint);
    assert.match(proof.tree, /^[0-9a-f]{40}$/);
    assert.deepEqual(proof.files.find(file => file.path === "run.sh"),
      { path: "run.sh", mode: "100755", sha256: sha256("#!/bin/sh\necho reviewed\n") });
    assert.deepEqual(proof.files.find(file => file.path === "parser.mjs"),
      { path: "parser.mjs", mode: "100644", sha256: sha256("patched\n") });
    assert.deepEqual(await readFile(join(cwd, ".git/index")), index);
    assert.deepEqual((await readdir(join(cwd, ".git/objects"), { recursive: true })).sort(), objects);
    assert.equal(await git(cwd, "rev-parse", "HEAD"), pack.head);
    assert.equal(await git(cwd, "status", "--porcelain=v1"), status);
    await git(cwd, "add", "parser.mjs", "run.sh", "extra.txt");
    await git(cwd, "commit", "-qm", "reviewed candidate");
    assert.equal(await git(cwd, "rev-parse", "HEAD^{tree}"), proof.tree);
    assert.match(await git(cwd, "ls-tree", "HEAD", "run.sh"), /^100755 /);
    await writeFile(join(cwd, "sneaky.txt"), "sneaky\n");
    await git(cwd, "add", "sneaky.txt");
    await git(cwd, "commit", "-qm", "unreviewed extra file");
    assert.notEqual(await git(cwd, "rev-parse", "HEAD^{tree}"), proof.tree,
      "an extra staged file produces a different tree and cannot pass the commit check");
    assert.equal(sha256("reviewed\n").length, 64);
  });
});

test("candidate proof binds deletion, rename and live file type to the reviewed Pack", async () => {
  await repoFixture(async ({ cwd, fixedPoint }) => {
    await writeFile(join(cwd, "old.txt"), "moved content\n");
    await git(cwd, "add", "old.txt");
    await git(cwd, "commit", "-qm", "rename baseline");
    await rename(join(cwd, "old.txt"), join(cwd, "new.txt"));
    await git(cwd, "add", "-A");
    const pack = await collectReviewEvidence(cwd);
    const proof = await collectCandidateTreeProof(cwd, pack,
      { allowedFiles: ["old.txt", "new.txt"], batch: { fixedPoint } });
    assert.deepEqual(proof.renames, [{ from: "old.txt", to: "new.txt" }]);
    assert.ok(proof.files.some(file => file.path === "new.txt" && file.mode === "100644"));
    await writeFile(join(cwd, "old.txt"), "recreated unreviewed path\n");
    await assert.rejects(() => collectCandidateTreeProof(cwd, pack,
      { allowedFiles: ["old.txt", "new.txt"], batch: { fixedPoint } }), /content|drift|exists|match/i);
    await rm(join(cwd, "old.txt"));
    await rm(join(cwd, "new.txt"));
    await symlink("old.txt", join(cwd, "new.txt"));
    await assert.rejects(() => collectCandidateTreeProof(cwd, pack,
      { allowedFiles: ["old.txt", "new.txt"], batch: { fixedPoint } }), /type|symlink|drift/i);
  });
});

test("candidate proof binds a symlink target to the reviewed Pack, not a live retarget", async () => {
  await repoFixture(async ({ cwd, fixedPoint }) => {
    await symlink("b", join(cwd, "link"));
    const pack = await collectReviewEvidence(cwd);
    const proof = await collectCandidateTreeProof(cwd, pack,
      { allowedFiles: ["link"], batch: { fixedPoint } });
    assert.ok(proof.files.some(file =>
      file.path === "link" && file.mode === "120000" && file.sha256 === sha256("b")));
    await rm(join(cwd, "link"));
    await symlink("c", join(cwd, "link"));
    await assert.rejects(() => collectCandidateTreeProof(cwd, pack,
      { allowedFiles: ["link"], batch: { fixedPoint } }), /content|drift|symlink|match/i,
    "the same M status cannot rebind a retargeted symlink to the reviewed Pack");
    await rm(join(cwd, "link"));
    await symlink("b", join(cwd, "link"));
    const verified = await collectCandidateTreeProof(cwd, pack,
      { allowedFiles: ["link"], batch: { fixedPoint } });
    await git(cwd, "add", "link");
    await git(cwd, "commit", "-qm", "reviewed symlink");
    assert.equal(await git(cwd, "rev-parse", "HEAD^{tree}"), verified.tree);
  });
});

test("candidate proof binds reviewed Git mode for modified and untracked files, not a later chmod", async () => {
  await repoFixture(async ({ cwd, fixedPoint }) => {
    await writeFile(join(cwd, "parser.mjs"), "patched\n");
    await writeFile(join(cwd, "run.sh"), "#!/bin/sh\necho reviewed\n");
    const pack = await collectReviewEvidence(cwd);
    assert.equal(pack.manifest.find(entry => entry.path === "parser.mjs").mode, "100644");
    assert.equal(pack.manifest.find(entry => entry.path === "run.sh").mode, "100644");
    const legacy = structuredClone(pack);
    for (const entry of legacy.manifest) delete entry.mode;
    await assert.rejects(() => collectCandidateTreeProof(cwd, legacy,
      { allowedFiles: ["parser.mjs", "run.sh"], batch: { fixedPoint } }), /reviewed Git mode|lacks.*mode/i,
    "legacy packs without reviewed mode fail closed instead of using live mode");
    await chmod(join(cwd, "parser.mjs"), 0o755);
    await assert.rejects(() => collectCandidateTreeProof(cwd, pack,
      { allowedFiles: ["parser.mjs", "run.sh"], batch: { fixedPoint } }), /mode drift|reviewed Git mode/i,
    "a chmod after Pack capture cannot rebind a modified tracked file");
    await chmod(join(cwd, "parser.mjs"), 0o644);
    await chmod(join(cwd, "run.sh"), 0o755);
    await assert.rejects(() => collectCandidateTreeProof(cwd, pack,
      { allowedFiles: ["parser.mjs", "run.sh"], batch: { fixedPoint } }), /mode drift|reviewed Git mode/i,
    "a chmod after Pack capture cannot rebind an untracked file");
    await chmod(join(cwd, "run.sh"), 0o644);
    await chmod(join(cwd, "parser.mjs"), 0o755);
    const executablePack = await collectReviewEvidence(cwd);
    const proof = await collectCandidateTreeProof(cwd, executablePack,
      { allowedFiles: ["parser.mjs", "run.sh"], batch: { fixedPoint } });
    assert.deepEqual(proof.files.find(file => file.path === "parser.mjs"),
      { path: "parser.mjs", mode: "100755", sha256: sha256("patched\n") });
    await git(cwd, "add", "parser.mjs", "run.sh");
    await git(cwd, "commit", "-qm", "reviewed executable mode");
    assert.equal(await git(cwd, "rev-parse", "HEAD^{tree}"), proof.tree);
    assert.match(await git(cwd, "ls-tree", "HEAD", "parser.mjs"), /^100755 /);
  });
});

test("preresolved and external blockers must be ancestors of the approved starting HEAD, not a future sibling", async () => {
  await repoFixture(async ({ cwd, fixedPoint }) => {
    await writeFile(join(cwd, ".git/info/exclude"), ".x-matt/\n");
    await writeFeature(cwd);
    await writeFile(join(cwd, "later.txt"), "starting head moved\n");
    await git(cwd, "add", "later.txt");
    await git(cwd, "commit", "-qm", "approved starting head");
    const startingHead = await git(cwd, "rev-parse", "HEAD");
    const future = (await git(cwd, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "future sibling")).trim();
    const identity = { sessionId: "session", projectRoot: cwd, branch: "main", head: startingHead };
    const plan = batchParams(fixedPoint);
    await resolveTicket(cwd, T1, fixedPoint);
    const sealed = await prepareBatchPlan(cwd, plan, identity);
    assert.equal(sealed.tickets[0].preresolved.commit, fixedPoint,
      "an older real ancestor of the approved starting HEAD remains valid");
    await resolveTicket(cwd, T1, future);
    await assert.rejects(() => prepareBatchPlan(cwd, plan, identity),
      /ancestor|contained|starting HEAD/i, "a future sibling commit cannot be a completed declared ticket");

    await writeFeature(cwd);
    await resolveTicket(cwd, T3, fixedPoint);
    await writeFile(join(cwd, T1), ticket("01: parser", SPEC, T3));
    const external = await prepareBatchPlan(cwd, plan, identity);
    assert.equal(external.externalBlockers[0].commit, fixedPoint,
      "an older external blocker commit is accepted in the correct commit->starting-HEAD direction");
    const scope = normalizeBatchPlan(plan).tickets[0];
    assert.equal((await verifyBatchDispatch(cwd, external, identity, scope, {})).entry.ticket, T1);
    await resolveTicket(cwd, T3, future);
    await assert.rejects(() => prepareBatchPlan(cwd, plan, identity),
      /ancestor|contained|starting HEAD/i, "a future external blocker cannot unlock an active ticket");
    await assert.rejects(() => verifyBatchDispatch(cwd, external, identity, scope, {}),
      /drift|ancestor|commit/i, "revalidation also keeps the frozen blocker commit bound");
  });
});

test("candidate proof preserves the primary proof failure when owned cleanup also fails", async () => {
  await repoFixture(async ({ cwd, fixedPoint }) => {
    await writeFile(join(cwd, "parser.mjs"), "patched\n");
    const pack = await collectReviewEvidence(cwd);
    await writeFile(join(cwd, "parser.mjs"), "drifted after pack\n");
    const remove = async (path, options) => {
      await rm(path, options);
      throw new Error("cleanup boom");
    };
    await assert.rejects(() => collectCandidateTreeProof(cwd, pack,
      { allowedFiles: ["parser.mjs"], batch: { fixedPoint } }, { remove }),
    error => error instanceof AggregateError && /content|drift|match/i.test(error.cause?.message ?? "") &&
      /cleanup boom/.test(error.message));
    await writeFile(join(cwd, "parser.mjs"), "patched\n");
    const clean = await collectReviewEvidence(cwd);
    await assert.rejects(() => collectCandidateTreeProof(cwd, clean,
      { allowedFiles: ["parser.mjs"], batch: { fixedPoint } }, { remove }), /cleanup boom/,
    "a successful tree with failed cleanup is not a successful proof");
  });
});

test("a repair-only proof survives same-snapshot formal review and reviewer recovery, then unlocks the next ticket", async () => {
  const base = { workflow: "matt-tdd", task: "shared",
    laneTasks: { implement: "implement", standards: "standards", spec: "spec" } };
  const acceptanceFinding = {
    id: "parse", rootCauseId: "parser", severity: "P1", title: "acceptance",
    basis: { kind: "acceptance", reference: "AC1" }, evidence: "missing behavior", expected: "works",
    actual: "missing", locations: ["parser.mjs:1"], classification: "original",
    relatedFindingIds: [], affectedBy: [], recommendation: "implement it",
  };
  const specFail = { key: "spec", ok: true, structuredOutput: {
    axis: "spec", verdict: "FAIL", summary: "blocked", findings: [acceptanceFinding], notes: [],
  } };
  await batchFixture(async f => {
    const initial = await f.runtime.dispatch({ ...base, implementation: implementation(T1),
      batch: batchParams(f.fixedPoint) }, undefined, f.ctx);
    await f.runtime.flush();
    await f.settle({ reviews: { standards: review("standards"), spec: specFail } });
    const repair = await f.runtime.dispatch({ ...base, implementation: implementation(T1),
      repair: { previousDispatchId: initial.details.dispatchId,
        groups: [{ id: "parser", findingIds: ["spec:parse"], contract: "implement behavior",
          preserve: ["original parser contract"], validationOrder: "validate -> parse",
          callPath: ["public -> parser"], examples: ["works"] }] } }, undefined, { ...f.ctx, hasUI: false });
    assert.equal(repair.details.authorization, "batch-plan");
    await f.runtime.flush();
    const repaired = await f.settle({ value: "repaired\n" });
    assert.deepEqual(repaired.calls, ["claim", "implement", "evidence"]);
    const repairRecord = f.entries.filter(entry => entry.customType === IMPLEMENTATION_ENTRY).at(-1).data;
    assert.ok(repairRecord.batchOutcome.candidate);
    assert.equal(repairRecord.batchOutcome.complete, false);
    const reviewDispatch = await f.runtime.dispatch({ ...base, implementation: implementation(T1),
      review: { dispatchId: repairRecord.id } }, undefined, { ...f.ctx, hasUI: false });
    assert.equal(reviewDispatch.details.authorization, "batch-plan");
    await f.runtime.flush();
    const reviewed = await f.settle();
    assert.deepEqual(reviewed.calls, ["standards", "spec"], "formal review never reruns writer or collector");
    const reviewRecord = f.entries.filter(entry => entry.customType === IMPLEMENTATION_ENTRY).at(-1).data;
    assert.equal(reviewRecord.batchOutcome.complete, true);
    assert.deepEqual(reviewRecord.batchOutcome.candidate, repairRecord.batchOutcome.candidate);
    await git(f.ctx.cwd, "add", "parser.mjs");
    await git(f.ctx.cwd, "commit", "-qm", "reviewed repair");
    await resolveTicket(f.ctx.cwd, T1, await git(f.ctx.cwd, "rev-parse", "HEAD"));
    const next = await f.runtime.dispatch({ ...base, implementation: implementation(T2) },
      undefined, { ...f.ctx, hasUI: false });
    assert.equal(next.details.authorization, "batch-plan");
    assert.equal(f.prompts, 1);
  });
  await batchFixture(async f => {
    const initial = await f.runtime.dispatch({ ...base, implementation: implementation(T1),
      batch: batchParams(f.fixedPoint) }, undefined, f.ctx);
    await f.runtime.flush();
    const failed = await f.settle({ reviews: { spec: { key: "spec", ok: false, error: "fetch failed" } } });
    assert.equal(failed.status.state, "failed");
    const failedRecord = f.entries.filter(entry => entry.customType === IMPLEMENTATION_ENTRY).at(-1).data;
    assert.ok(failedRecord.batchOutcome.candidate);
    assert.equal(failedRecord.batchOutcome.complete, false);
    const recovery = await f.runtime.dispatch({ ...base, implementation: implementation(T1),
      recovery: { dispatchId: initial.details.dispatchId, lanes: ["spec"] } },
    undefined, { ...f.ctx, hasUI: false });
    assert.equal(recovery.details.authorization, "batch-plan");
    await f.runtime.flush();
    const recovered = await f.settle();
    assert.deepEqual(recovered.calls, ["spec"]);
    const recoveredRecord = f.entries.filter(entry => entry.customType === IMPLEMENTATION_ENTRY).at(-1).data;
    assert.equal(recoveredRecord.batchOutcome.complete, true);
    assert.deepEqual(recoveredRecord.batchOutcome.candidate, failedRecord.batchOutcome.candidate);
  });
});

test("a failed reviewer with residual structured PASS cannot make a carried batch candidate complete", async () => {
  const base = { workflow: "matt-tdd", task: "shared",
    laneTasks: { implement: "implement", standards: "standards", spec: "spec" } };
  await batchFixture(async f => {
    const initial = await f.runtime.dispatch({ ...base, implementation: implementation(T1),
      batch: batchParams(f.fixedPoint) }, undefined, f.ctx);
    await f.runtime.flush();
    const failed = await f.settle({ reviews: {
      standards: { key: "standards", ok: false, error: "transport aborted after output",
        structuredOutput: { axis: "standards", verdict: "PASS", summary: "residual", findings: [], notes: [] } },
    } });
    assert.equal(failed.status.state, "failed");
    const record = f.entries.filter(entry => entry.customType === IMPLEMENTATION_ENTRY).at(-1).data;
    assert.ok(record.batchOutcome.candidate);
    assert.equal(record.batchOutcome.complete, false,
      "candidate proof exists, but the reviewer execution result is invalid");
    await git(f.ctx.cwd, "add", "parser.mjs");
    await git(f.ctx.cwd, "commit", "-qm", "candidate with failed reviewer");
    await resolveTicket(f.ctx.cwd, T1, await git(f.ctx.cwd, "rev-parse", "HEAD"));
    await assert.rejects(() => f.runtime.dispatch({ ...base, implementation: implementation(T2) },
      undefined, { ...f.ctx, hasUI: false }), /no workflow was queued/i);
    assert.equal(f.runtime.plans.size, 0);
  });
});

test("post-seal Blocked by drift queues nothing on the public dispatch path", async () => {
  const base = { workflow: "matt-tdd", task: "shared",
    laneTasks: { implement: "implement", standards: "standards", spec: "spec" } };
  await batchFixture(async f => {
    const first = await f.runtime.dispatch({ ...base, implementation: implementation(T1),
      batch: batchParams(f.fixedPoint) }, undefined, f.ctx);
    assert.equal(f.runtime.plans.size, 1);
    await writeFile(join(f.ctx.cwd, T2), ticket("02: second", SPEC, "None"));
    await assert.rejects(() => f.runtime.dispatch({ ...base, implementation: implementation(T1),
      review: { dispatchId: first.details.dispatchId } }, undefined, { ...f.ctx, hasUI: false }),
    /drift|no workflow was queued/i);
    assert.equal(f.runtime.plans.size, 1, "the drifted dispatch adds no queued work");
    await f.runtime.flush();
    assert.equal(f.launches.length, 0, "the previously queued writer must not start after dependency drift");
    assert.equal(f.runtime.plans.size, 0);
    assert.match(f.notices.at(-1), /requirement drift/);
  });
});

test("duplicate metadata keys hiding an unresolved blocker are rejected before batch confirmation", async () => {
  const base = { workflow: "matt-tdd", task: "shared",
    laneTasks: { implement: "implement", standards: "standards", spec: "spec" } };
  await batchFixture(async f => {
    await writeFile(join(f.ctx.cwd, T1),
      ticket("01: parser", SPEC, T3).replace(`Blocked by: ${T3}`, `Blocked by: ${T3}\nBlocked by: None`));
    await assert.rejects(() => f.runtime.dispatch({ ...base, implementation: implementation(T1),
      batch: batchParams(f.fixedPoint) }, undefined, f.ctx),
    /duplicate metadata/i, "a repeated Blocked by cannot overwrite the earlier unresolved blocker");
    assert.equal(f.prompts, 0, "the invalid artifact is rejected before batch confirmation");
    assert.equal(f.entries.filter(entry => entry.customType === BATCH_ENTRY).length, 0,
      "no batch capability is persisted");
    assert.equal(f.runtime.plans.size, 0, "no plan is queued");
    await f.runtime.flush();
    assert.equal(f.launches.length, 0, "no RPC workflow is launched");
  });
});

test("whitespace-aliased metadata keys hiding an unresolved blocker are rejected before batch confirmation", async () => {
  const base = { workflow: "matt-tdd", task: "shared",
    laneTasks: { implement: "implement", standards: "standards", spec: "spec" } };
  await batchFixture(async f => {
    await writeFile(join(f.ctx.cwd, T1),
      ticket("01: parser", SPEC, T3).replace(`Blocked by: ${T3}`, `Blocked by : ${T3}\nBlocked by: None`));
    await assert.rejects(() => f.runtime.dispatch({ ...base, implementation: implementation(T1),
      batch: batchParams(f.fixedPoint) }, undefined, f.ctx),
    /invalid metadata key/i, "a whitespace alias of Blocked by cannot hide the earlier unresolved blocker");
    assert.equal(f.prompts, 0, "the invalid artifact is rejected before batch confirmation");
    assert.equal(f.entries.filter(entry => entry.customType === BATCH_ENTRY).length, 0,
      "no batch capability is persisted");
    assert.equal(f.runtime.plans.size, 0, "no plan is queued");
    await f.runtime.flush();
    assert.equal(f.launches.length, 0, "no RPC workflow is launched");
  });
});

test("a stale batch confirmation cannot revoke a newer session capability", async () => {
  let now = 1_000;
  const entries = [];
  const store = createBatchAuthorization({ now: () => now,
    persist: data => entries.push({ type: "custom", customType: BATCH_ENTRY, data }) });
  store.start("old-session", []);
  const sealed = { version: 1, kind: "batch", sessionId: "old-session", invocationId: "old-batch",
    identity: { sessionId: "old-session", projectRoot: "/project", branch: "main", head: "a".repeat(40) },
    fixedPoint: "b".repeat(40), spec: { path: SPEC, digest: "spec-digest" }, tickets: [],
    at: now, expiresAt: now + 1_000 };
  let resolveDialog;
  const controller = new AbortController();
  const pending = confirmBatchPlan({
    hasUI: true, ui: { confirm: () => new Promise(resolve => { resolveDialog = resolve; }) },
  }, sealed, controller.signal, store);
  await Promise.resolve();
  store.start("new-session", []);
  const replacement = store.establish({ ...sealed, sessionId: "new-session" });
  controller.abort(new Error("old dialog replaced"));
  resolveDialog(true);
  await assert.rejects(() => pending, /replaced|cancel|lifecycle/i);
  assert.equal(store.current().kind, "batch", "the old callback cannot rewrite the replacement session state");
  assert.equal(store.active(replacement.invocationId), true);
  assert.equal(store.active("old-batch"), false);
});

test("tree navigation revokes a pending batch confirmation before it can queue", async () => {
  const base = { workflow: "matt-tdd", task: "shared",
    laneTasks: { implement: "implement", standards: "standards", spec: "spec" } };
  await batchFixture(async f => {
    let resolveDialog, openedResolve;
    const opened = new Promise(resolve => { openedResolve = resolve; });
    const deferred = { ...f.ctx, ui: { confirm: () => {
      openedResolve();
      return new Promise(resolve => { resolveDialog = resolve; });
    } } };
    const pending = f.runtime.dispatch({ ...base, implementation: implementation(T1),
      batch: batchParams(f.fixedPoint) }, undefined, deferred);
    await opened;
    f.runtime.revoke("session-tree-changed");
    resolveDialog(true);
    await assert.rejects(() => pending, /lifecycle|authorization|no workflow|revoked/i);
    assert.equal(f.runtime.plans.size, 0, "no workflow is queued after the pending confirmation is revoked");
    assert.equal(f.entries.some(entry => entry.customType === BATCH_ENTRY && entry.data.kind === "batch"), false);
    await f.runtime.flush();
    assert.equal(f.launches.length, 0, "no RPC/writer starts for the revoked confirmation");
  });
});

test("a host-measured pre-review failure keeps a dual-PASS ticket out of the batch unless the user withdrew it", () => {
  const sha = "a".repeat(40);
  const outcome = hostVerification => batchOutcome({ state: "complete", workflow: {
    value: [
      { key: "implement", ok: true, structuredOutput: { status: "COMPLETE" }, ...(hostVerification ? { hostVerification } : {}) },
      ...["standards", "spec"].map(axis => ({ key: axis, ok: true, structuredOutput: { axis, verdict: "PASS" } })),
    ],
    emits: [{ type: "pi-x-matt.batch-candidate", version: 1,
      candidate: { tree: sha, head: sha, fixedPoint: sha, snapshotId: "s".repeat(32) } }],
  } });
  assert.equal(outcome().complete, true);
  assert.equal(outcome({ version: 1, ok: true, preReview: { ok: true } }).complete, true);
  const failed = outcome({ version: 1, ok: false, preReview: { ok: false, results: [{ command: "npm test", ok: false }] } });
  assert.deepEqual([failed.complete, failed.resultsValid, failed.implementComplete, Boolean(failed.candidate)],
    [false, false, true, true], "reviewer PASS cannot outvote a failing approved command");
  assert.equal(outcome({ version: 1, ok: false, waived: "pre-review-command-withdrawn",
    preReview: { ok: false, results: [] } }).complete, true);
  assert.equal(outcome({ version: 1, ok: false, accounting: { ok: false, unresolvedFindingIds: ["spec:F1"] } }).complete, true,
    "accounting is writer paperwork: formal review already judged the candidate itself");
});
