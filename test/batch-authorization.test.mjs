import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { BATCH_ENTRY, collectCandidateTreeProof, confirmBatchPlan, createBatchAuthorization, normalizeBatchPlan, prepareBatchPlan, verifyBatchDispatch } from "../lib/batch-authorization.mjs";
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
    cwd, hasUI: true, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "batch-session", getBranch: () => entries },
    ui: { confirm: async (_title, text) => { prompts++; messages.push(text); return true; } },
  };
  const pi = {
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data: structuredClone(data) }),
    events: { emit() {} }, sendUserMessage: text => notices.push(text),
  };
  const reload = (reason = "reload") => {
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
    });
    runtime.start(ctx, reason);
    return runtime;
  };
  const settle = async ({ value = "first slice\n", files = {}, reviews } = {}) => {
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
              runId: `${launch.runId}-writer`, resumability: { state: "resumable" }, structuredOutput: worker });
          } else if (reviews?.[item.key]) {
            results.push({ key: item.key, ok: true, artifactPaths: [], ...reviews[item.key] });
          } else results.push(review(item.key));
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

test("a batch needs one genuine confirmation of the sealed plan and no single-ticket intent can bypass it", async () => {
  await batchFixture(async f => {
    const params = { workflow: "matt-tdd", task: "shared", implementation: implementation(T1),
      laneTasks: { implement: "implement", standards: "standards", spec: "spec" },
      batch: batchParams(f.fixedPoint) };
    const records = () => f.entries.filter(entry => entry.customType === BATCH_ENTRY).length;
    f.runtime.input({ text: "/skill:matt-implement", source: "interactive" });
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
    assert.equal(f.prompts, 1, "the explicit matt-implement intent never replaces the batch confirmation");
    const message = f.messages.join("\n");
    for (const value of [SPEC, f.fixedPoint, T1, T2, "parser slice", "second slice", "parser.mjs"]) {
      assert.ok(message.includes(value), value);
    }
    assert.equal(f.entries.filter(entry => entry.customType === BATCH_ENTRY).at(-1).data.kind, "batch");
    assert.equal(f.runtime.authorization.current().source, "batch-plan");
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

test("batch state restores on reload, survives matt-implement-spec, and revokes on other skills, expiry, fork and cancellation", async () => {
  let now = 1_000;
  const entries = [];
  const store = createBatchAuthorization({ now: () => now,
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
  assert.equal(restored.active("batch-1"), false);
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
    assert.equal(f.launches.length, 1);
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
  }, sealed, controller.signal, store, { now });
  await Promise.resolve();
  store.start("new-session", []);
  store.establish({ ...sealed, sessionId: "new-session", invocationId: "new-batch" });
  controller.abort(new Error("old dialog replaced"));
  resolveDialog(true);
  await assert.rejects(() => pending, /replaced|cancel|lifecycle/i);
  assert.equal(store.current().kind, "batch", "the old callback cannot rewrite the replacement session state");
  assert.equal(store.active("new-batch"), true);
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
