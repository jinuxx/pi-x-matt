import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { AUTH_ENTRY, AUTH_TTL_MS, AUTH_WAIT_MS, authorizeWorkflowDispatch, createDispatchAuthorization, normalizeImplementationScope } from "../lib/dispatch-authorization.mjs";
import { createDispatchTrace, requestRpc, withDeadline } from "../lib/dispatch-runtime.mjs";
import { diagnoseRepair, prepareRepair, reviewRecovery } from "../lib/repair-contract.mjs";
import { validateReviewResult } from "../lib/review-contract.mjs";
import { normalizeDiagnosticTestFiles } from "../lib/diagnostic-workspace.mjs";

const identity = { sessionId: "session", projectRoot: "/project", branch: "main", head: "fixed" };
const scope = { ticket: "slice:parser", scope: "preserve parser contract", allowedFiles: ["parser.mjs"],
  diagnosticCommands: ["node --test parser.test.mjs"], ticketDigest: "host-digest" };
function host(now = Date.now) {
  const entries = [];
  const authorization = createDispatchAuthorization({
    now, persist: data => entries.push({ type: "custom", customType: AUTH_ENTRY, data }),
  });
  authorization.start("session");
  return { authorization, entries };
}
const authorize = (authorization, ctx, candidate = scope, signal) =>
  authorizeWorkflowDispatch("matt-tdd", signal, ctx, authorization, candidate, identity);

test("runtime confirmation is reusable across repairs and reload, not another ticket or changed scope", async () => {
  const { authorization, entries } = host();
  let prompts = 0;
  const ctx = { hasUI: true, ui: { confirm: async () => { prompts++; return true; } } };
  assert.equal(await authorize(authorization, ctx), "user-confirmed");
  assert.equal(await authorize(authorization, ctx), "reused-implement-grant");
  const restored = host().authorization;
  restored.start("session", entries);
  assert.equal(await authorize(restored, { hasUI: false }), "reused-implement-grant");
  await assert.rejects(() => authorize(restored, { hasUI: false }, { ...scope, ticket: "slice:another" }), /authorization/);
  await assert.rejects(() => authorize(restored, { hasUI: false }, { ...scope, allowedFiles: ["parser.mjs", "other.mjs"] }), /authorization/);
  assert.equal(prompts, 1);
});

test("explicit invocation binds once; revoke, fork, expiry and absent provenance fail closed", async () => {
  let now = 10;
  const { authorization, entries } = host(() => now);
  authorization.observeInput("/skill:matt-implement", "extension");
  await assert.rejects(() => authorize(authorization, { hasUI: false }), /authorization/);
  authorization.observeInput("/skill:matt-implement", "interactive");
  assert.equal(await authorize(authorization, { hasUI: false }), "user-invoked-implement");
  await assert.rejects(() => authorize(authorization, { hasUI: false }, { ...scope, scope: "expanded contract" }), /authorization/);
  now += AUTH_TTL_MS;
  await assert.rejects(() => authorize(authorization, { hasUI: false }), /authorization/);
  authorization.revoke();
  authorization.start("session", entries);
  await assert.rejects(() => authorize(authorization, { hasUI: false }), /authorization/);
  authorization.start("forked", entries, false);
  await assert.rejects(() => authorize(authorization, { hasUI: false }), /authorization/);
  await assert.rejects(() => authorizeWorkflowDispatch("matt-tdd", undefined, { hasUI: false }, authorization, scope), /reliable host/);
});

test("cancelled or aborted confirmations never create a reusable grant", async () => {
  const { authorization, entries } = host();
  await assert.rejects(() => authorize(authorization, { hasUI: true, ui: { confirm: async () => false } }), /not authorized/);
  assert.equal(authorization.current().kind, "revoked");
  const controller = new AbortController();
  await assert.rejects(() => authorize(authorization, {
    hasUI: true, ui: { confirm: async () => { controller.abort(new Error("cancel")); return true; } },
  }, scope, controller.signal), /cancel/);
  authorization.start("session", entries);
  await assert.rejects(() => authorize(authorization, { hasUI: false }), /authorization/);
});

test("diagnostic file permission extends the exact scope without changing the default approved shape", () => {
  const base = { ticket: "slice:parser", scope: "preserve parser contract",
    allowedFiles: ["parser.mjs", "parser.test.mjs"], diagnosticCommands: ["node parser.test.mjs"] };
  assert.deepEqual(Object.keys(normalizeImplementationScope(base)),
    ["ticket", "scope", "allowedFiles", "diagnosticCommands"]);
  assert.deepEqual(normalizeImplementationScope({ ...base, diagnosticFiles: ["parser.test.mjs", "parser.test.mjs"] })
    .diagnosticFiles, ["parser.test.mjs"]);
  assert.throws(() => normalizeImplementationScope({ ...base, diagnosticFiles: ["other.test.mjs"] }),
    /subset of allowedFiles/);
  assert.throws(() => normalizeImplementationScope({ ...base, diagnosticFiles: ["../parser.test.mjs"] }),
    /project-relative/);
  assert.throws(() => normalizeImplementationScope({ ...base, diagnosticFiles: "/tmp/parser.test.mjs" }),
    /project-relative/);
  assert.throws(() => normalizeImplementationScope({ ...base, diagnosticFiles: "parser.test.mjs" }),
    /diagnosticFiles/);
});

test("production source paths never receive isolated diagnostic write permission", () => {
  const approved = { ticket: "slice:parser", scope: "preserve parser contract",
    allowedFiles: ["src/parser.mjs", "parser.test.mjs"], diagnosticCommands: ["node src/parser.mjs"],
    diagnosticFiles: ["src/parser.mjs"] };
  assert.throws(() => normalizeImplementationScope(approved), /test or fixture/);
  assert.throws(() => normalizeDiagnosticTestFiles({ diagnosticFiles: ["src/parser.mjs"] },
    [{ path: "src/parser.mjs", content: 'console.error("target regression"); process.exit(1);\n' }]),
  /test or fixture/);
  assert.deepEqual(normalizeImplementationScope({ ...approved, diagnosticFiles: ["parser.test.mjs"] })
    .diagnosticFiles, ["parser.test.mjs"]);
});

test("the authorization dialog shows isolated diagnostic files and the grant binds them exactly", async () => {
  const { authorization, entries } = host();
  let message;
  const extended = { ...scope, allowedFiles: ["parser.mjs", "parser.test.mjs"], diagnosticFiles: ["parser.test.mjs"] };
  const ctx = { hasUI: true, ui: { confirm: async (_title, text) => { message = text; return true; } } };
  assert.equal(await authorize(authorization, ctx, extended), "user-confirmed");
  assert.match(message, /Diagnostic files.*parser\.test\.mjs/);
  const restored = host().authorization;
  restored.start("session", entries);
  assert.equal(await authorize(restored, { hasUI: false }, extended), "reused-implement-grant");
  await assert.rejects(() => authorize(restored, { hasUI: false }), /authorization/);
});

test("a late confirmation cannot grant or revoke authorization in a replacement session", async () => {
  const { authorization, entries } = host();
  let reply;
  const pending = authorize(authorization, { hasUI: true, ui: { confirm: () => new Promise(resolve => { reply = resolve; }) } });
  await Promise.resolve();
  authorization.start("replacement", []);
  authorization.observeInput("/skill:matt-implement", "interactive");
  const count = entries.length;
  reply(true);
  await assert.rejects(() => pending, /lifecycle changed/);
  assert.equal(entries.length, count);
  assert.equal(authorization.current().sessionId, "replacement");
  assert.equal(authorization.current().kind, "intent");
});

function fakeClock() {
  let callback, time = 0, cleared = false;
  return {
    now: () => time,
    setTimeout(fn) { callback = fn; return 1; },
    clearTimeout() { cleared = true; },
    tick(ms) { time += ms; callback?.(); },
    get cleared() { return cleared; },
  };
}

test("unanswered authorization-style work has a bounded cancellable deadline with a controllable clock", async () => {
  const clock = fakeClock();
  let aborted = false;
  const pending = withDeadline(signal => {
    signal.addEventListener("abort", () => { aborted = true; });
    return new Promise(() => {});
  }, { timeoutMs: 300000, clock });
  await Promise.resolve();
  clock.tick(300000);
  await assert.rejects(() => pending, error => error.code === "phase_timeout");
  assert.equal(aborted, true);
  assert.equal(clock.cleared, true);
});

test("the actual unanswered authorization dialog expires without persisting a grant", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { authorization, entries } = host();
  const pending = authorize(authorization, { hasUI: true, ui: { confirm: () => new Promise(() => {}) } });
  await Promise.resolve();
  context.mock.timers.tick(AUTH_WAIT_MS);
  await assert.rejects(() => pending, error => error.code === "phase_timeout");
  authorization.start("session", entries);
  assert.equal(authorization.current().kind, "revoked");
});

test("cancellation before a deferred phase starts cannot emit RPC or open a dialog", async () => {
  const controller = new AbortController();
  let started = false;
  const pending = withDeadline(() => { started = true; }, { timeoutMs: 10000, signal: controller.signal });
  controller.abort(new Error("cancelled"));
  await assert.rejects(() => pending, /cancelled/);
  assert.equal(started, false);
});

function bus() {
  const emitter = new EventEmitter();
  return { on(name, fn) { emitter.on(name, fn); return () => emitter.off(name, fn); },
    emit: (name, value) => emitter.emit(name, value), emitter };
}

test("RPC distinguishes 401, network failure and unknown timeout acceptance; never retries spawn", async () => {
  for (const [code, message] of [["401", "unauthorized"], ["network_error", "fetch failed"]]) {
    const events = bus();
    let calls = 0;
    events.on("subagents:rpc:v1:request", request => {
      calls++;
      events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
        version: 1, requestId: request.requestId, success: false, error: { code, message },
      });
    });
    await assert.rejects(() => requestRpc(events, "spawn", {}, { requestId: "r" }),
      error => error.code === code && error.message === message);
    assert.equal(calls, 1);
  }
  const events = bus(), clock = fakeClock();
  const result = requestRpc(events, "spawn", {}, { requestId: "lost", clock });
  await Promise.resolve();
  clock.tick(10000);
  await assert.rejects(() => result, error => error.code === "rpc_acceptance_unknown" && error.cause.code === "phase_timeout");
  assert.equal(events.emitter.listenerCount("subagents:rpc:v1:reply:lost"), 0);
});

test("phase accounting separates authorization, evidence and RPC without wall-clock sleeps", async () => {
  let now = 0;
  const emitted = [];
  const trace = createDispatchTrace({ id: "dispatch", now: () => now, emit: event => emitted.push(event) });
  await trace.step("authorization", async () => { now += 200000; });
  await trace.step("evidence", async () => { now += 20; });
  await assert.rejects(() => trace.step("rpc", async () => { now += 10; throw new Error("401"); }), /401/);
  assert.deepEqual(emitted.filter(event => event.durationMs !== undefined).map(event =>
    [event.phase, event.durationMs]), [["authorization", 200000], ["evidence", 20], ["rpc", 10]]);
});

const finding = (classification = "original", relatedFindingIds = []) => ({
  id: "parse", rootCauseId: "parse-order", evidence: "parse(null) throws before validation",
  basis: { kind: "acceptance", reference: "AC1" }, expected: "reject null", actual: "throws",
  locations: ["parser.mjs:1"], classification, relatedFindingIds,
});
const reviews = item => ["standards", "spec"].map(axis => ({
  key: axis, ok: true, structuredOutput: { axis, verdict: axis === "spec" ? "FAIL" : "PASS", findings: axis === "spec" ? [item] : [] },
}));
const group = { id: "parser", findingIds: ["spec:parse"], contract: "validate before normalize",
  preserve: ["valid text"], validationOrder: "validate -> normalize -> parse", callPath: ["public -> parse"],
  examples: ["null rejects; valid text remains valid"] };

test("two failed patches to one parsing root cause require diagnosis before the third writer", async () => {
  let previous = { id: "initial", snapshotId: "snapshot" };
  for (let attempt = 1; attempt <= 3; attempt++) {
    const repair = prepareRepair(previous, { previousDispatchId: previous.id, groups: [group] },
      reviews(finding("original", previous.repair ? ["spec:parse"] : [])));
    if (attempt <= 2) {
      assert.deepEqual(repair.needsDiagnosis, []);
    } else {
      await assert.rejects(() => diagnoseRepair(repair, undefined, scope, "/project"), /DIAGNOSIS_REQUIRED/);
      let commands = 0;
      const diagnosed = await diagnoseRepair(repair, {
        rootCauseIds: ["parser"], explanation: "shared validation order", prediction: "null reaches normalize",
        command: scope.diagnosticCommands[0], expectedFailure: "null reaches normalize",
      }, scope, "/project", undefined, async () => {
        commands++;
        throw Object.assign(new Error("red"), { code: 1, stdout: "null reaches normalize" });
      });
      assert.equal(commands, 1);
      assert.equal(diagnosed.diagnosis.exitCode, 1);
    }
    previous = { id: `repair-${attempt}`, snapshotId: "snapshot", repair };
  }
});

test("a related regression diagnoses immediately; renaming a recurring group or omitting evidence is rejected", () => {
  const previous = { id: "repair", snapshotId: "s", repair: { groups: [group], counts: { parser: 1 } } };
  const request = { previousDispatchId: previous.id, groups: [group] };
  assert.deepEqual(prepareRepair(previous, request, reviews(finding("regression", ["spec:parse"]))).needsDiagnosis, ["parser"]);
  assert.throws(() => prepareRepair(previous, { ...request, groups: [{ ...group, id: "renamed" }] },
    reviews(finding("original", ["spec:parse"]))), /cannot be renamed/);
  assert.throws(() => prepareRepair(previous, request, reviews({ ...finding(), basis: null })), /verifiable/);
});

test("recovery selects only failed reviewers, preserves valid verdicts and cannot rerun a writer", () => {
  const results = [{ key: "implement", ok: true, structuredOutput: { status: "COMPLETE" } },
    { key: "standards", ok: true, structuredOutput: { verdict: "PASS" } },
    { key: "spec", ok: false, error: "fetch failed" }];
  assert.deepEqual(reviewRecovery(results, ["spec"]).keys, ["spec"]);
  assert.throws(() => reviewRecovery(results, ["implement"]), /only accepts/);
  assert.throws(() => reviewRecovery(results, ["standards"]), /valid verdict/);
  assert.throws(() => reviewRecovery(results, ["spec"], 1), /exhausted/);
});

test("incremental review rejects unimpacted old opinions but preserves regressions and new real safety findings", () => {
  const boundary = { incremental: true, changedPaths: ["shared.mjs"], approvedFindingIds: ["spec:old"] };
  const result = item => ({ key: "spec", ok: true,
    structuredOutput: { axis: "spec", verdict: "FAIL", findings: [item] } });
  const old = { ...finding("independent"), affectedBy: [], locations: ["unchanged.mjs:1"] };
  assert.equal(validateReviewResult(result(old), boundary).ok, false);
  assert.equal(validateReviewResult(result({ ...old, affectedBy: ["shared.mjs"],
    evidence: "changed shared validator reaches this caller" }), boundary).ok, true);
  assert.equal(validateReviewResult(result({ ...old, classification: "regression",
    relatedFindingIds: ["spec:old"] }), boundary).ok, true);
  const safety = { ...result({ ...old, basis: { kind: "safety", reference: "authorization boundary" } }),
    key: "standards" };
  safety.structuredOutput.axis = "standards";
  assert.equal(validateReviewResult(safety, boundary).ok, true);
  assert.equal(validateReviewResult(result({ ...old, severity: "P0", evidence: "" }), boundary).ok, false,
    "severity cannot replace evidence");
  assert.equal(validateReviewResult(result({ ...old, basis: { kind: "standard", reference: "personal preference" } }),
    boundary).ok, false, "spec cannot cite out-of-axis standards");
});
