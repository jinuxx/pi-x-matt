import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { BATCH_ENTRY, batchOutcome, collectCandidateTreeProof, confirmBatchPlan, createBatchAuthorization, durableBatch, normalizeBatchPlan, prepareBatchPlan, readBatchCommandPlan, verifyBatchDispatch } from "./batch-authorization.mjs";
import { admitCommittedReview, assertCommittedReviewFresh, normalizeCommittedReviewScope } from "./committed-review-evidence.mjs";
import { AUTH_ENTRY, AUTH_WAIT_MS, authorizeWorkflowDispatch, createDispatchAuthorization, resolveImplementationScope } from "./dispatch-authorization.mjs";
import { buildDispatchRequest, CORRECTION_TIMEOUT_MS, findProjectRoot, loadCurrentRegistry, PRE_REVIEW_HOST_TIMEOUT_MS, prepareDispatchRequest } from "./dispatcher-core.mjs";
import { createDispatchTrace, DISPATCH_EVENT, requestRpc, withDeadline, workflowReceipt } from "./dispatch-runtime.mjs";
import { confirmFinalValidation, FINAL_REPAIR_LIMIT, finalValidationChecks, hasFinalValidationPass, measureFinalValidation,
  recheckFinalValidation, runFinalValidationChecks, validateFinalRepairRequest } from "./final-validation.mjs";
import { IMPLEMENTATION_ENTRY, completedImplementation, diagnoseRepair, prepareReconsideration, prepareRepair, recoverableWriter, retainedWriter, reviewRecovery, reviewReportCorrections, stageResults } from "./repair-contract.mjs";
import { collectReviewEvidence, envelopeViolationMessage, indexChanges, renderReviewEvidence, repairDelta } from "./review-evidence.mjs";
import { revalidateReviewReports } from "./review-contract.mjs";
import { confirmRiskAcceptance } from "./risk-acceptance.mjs";
import { prepareCommittedReviewEvidence, prepareTddEvidence, resolveReviewWorkflow } from "./review-workflow.mjs";

const exec = promisify(execFile);
const ACTIVE = new Set(["queued", "rpc-pending", "acceptance-unknown", "running"]);
const digest = value => createHash("sha256").update(value).digest("hex");

function blockedWriter(status) {
  const checkpoint = status.workflow?.emits?.findLast(row => row.type === "pi-x-matt.stage-results");
  const results = checkpoint?.results;
  const result = results?.[0];
  const blocker = result?.structuredOutput?.environmentBlocker;
  if (status.state === "failed" && checkpoint?.workflow === "matt-tdd" && checkpoint.version === 1 &&
      checkpoint.stage === 1 && Array.isArray(results) && results.length === 1 && result?.key === "implement" && result.ok === true &&
      result.agent === "matt-worker" && typeof result.runId === "string" && result.runId.trim() && result.resumability?.state === "resumable" &&
      result.structuredOutput?.status === "BLOCKED" && [blocker?.command, blocker?.evidence]
        .every(value => typeof value === "string" && value.trim())) return result;
}

const batchPlanView = batch => ({
  spec: batch.spec.path,
  fixedPoint: batch.fixedPoint,
  tickets: batch.tickets.map(ticket => ({
    ticket: ticket.ticket, scope: ticket.scope, allowedFiles: ticket.allowedFiles,
    diagnosticFiles: ticket.diagnosticFiles ?? [], diagnosticCommands: ticket.diagnosticCommands ?? [],
    preReviewCommands: ticket.preReviewCommands ?? [],
    delivery: ticket.delivery,
  })),
});

const assertSameBatchPlan = (batch, plan) => {
  const requested = {
    spec: plan.spec, fixedPoint: plan.fixedPoint,
    tickets: plan.tickets.map(ticket => ({
      ticket: ticket.ticket, scope: ticket.scope, allowedFiles: ticket.allowedFiles,
      diagnosticFiles: ticket.diagnosticFiles ?? [], diagnosticCommands: ticket.diagnosticCommands ?? [],
      preReviewCommands: ticket.preReviewCommands ?? [],
      delivery: ticket.delivery,
    })),
  };
  if (JSON.stringify(batchPlanView(batch)) !== JSON.stringify(requested)) {
    throw new Error(
      "Batch metadata differs from the approved host-read batch capability; no workflow was queued. " +
      "Submit one new explicit batch confirmation for a changed plan.",
    );
  }
};

/** A regrant may add files or refresh diagnostic allowances for one ticket; behavior and identity stay fixed. */
const assertSameLineage = (previous, identity, scope) => {
  const prior = previous.scope ?? {};
  const changed = ["sessionId", "projectRoot", "branch", "head"]
    .filter(key => previous.identity?.[key] !== identity[key]).map(key => `identity.${key}`);
  for (const key of ["ticket", "scope", "ticketDigest", "delivery"]) {
    if (prior[key] !== scope[key]) changed.push(`scope.${key}`);
  }
  if (!(prior.allowedFiles ?? []).every(path => scope.allowedFiles.includes(path))) changed.push("scope.allowedFiles (removed files)");
  if (changed.length) throw new Error(
    `Repair baseline or approved envelope changed: ${changed.join(", ")}. ` +
    "Reuse the exact approved scope text (outer whitespace is already trimmed); keep all approved files. " +
    "Changed behavior or ticket content needs a new decision, not a rewritten follow-up scope.",
  );
};

/** Budgets are keyed by the reviewed candidate snapshot, never by dispatch or authorization identity. */
const reviewMetaFor = (previous, candidateSnapshotId) => {
  const prior = previous?.reviewMeta;
  if (prior?.candidateSnapshotId === candidateSnapshotId) {
    return {
      candidateSnapshotId,
      reconsiderCounts: { ...prior.reconsiderCounts },
      correctionCounts: { ...prior.correctionCounts },
    };
  }
  return { candidateSnapshotId, reconsiderCounts: {}, correctionCounts: {} };
};

const reviewStageResults = results => results.filter(result => ["standards", "spec"].includes(result.key));

function legacyEvidenceReceiptFailure(record, status, results) {
  const last = status.workflow?.trace?.at(-1);
  return status.state === "failed" && !record.evidence.resultPath &&
    results.length === 1 && results[0].key === "implement" &&
    results[0].ok === true && results[0].structuredOutput?.status === "COMPLETE" &&
    last?.operation === "host" && last.key === "review-evidence" && last.state === "completed" &&
    /JSON/.test(status.error ?? "") && /SyntaxError|Unexpected|Unterminated/.test(status.error ?? "");
}

async function verifyLegacyEvidenceReceipt(previous, pack, text, current, sealed, baselineSnapshotId) {
  const { baseline, control } = sealed;
  const increment = repairDelta(baseline, current, {
    ...control, allowedFiles: previous.scope.allowedFiles,
    approvedFindingIds: previous.repair?.approvedFindingIds ?? [], groups: previous.repair?.groups ?? [],
  });
  if (pack.version !== 1 || pack.source !== "workflow-git-collector" || pack.reviewKind !== "worktree" ||
      !current.complete || pack.cwd !== current.cwd || pack.gitRoot !== current.gitRoot ||
      pack.head !== previous.identity.head || pack.status !== current.status || pack.index !== current.index ||
      pack.fixedPoint !== baseline.head || baseline.snapshotId !== baselineSnapshotId ||
      digest(JSON.stringify({ head: baseline.head, cwd: baseline.cwd, manifest: baseline.manifest, diff: baseline.diff })) !== baselineSnapshotId ||
      pack.diffSha256 !== digest(pack.diff) ||
      digest(JSON.stringify({ head: pack.head, cwd: pack.cwd, manifest: pack.manifest, diff: pack.diff })) !== current.snapshotId ||
      JSON.stringify(pack.baseline) !== JSON.stringify(baseline) ||
      JSON.stringify(pack.restoredFiles) !== JSON.stringify(current.restoredFiles) ||
      JSON.stringify(pack.incremental) !== JSON.stringify(increment)) {
    throw new Error("Evidence receipt recovery requires complete, unchanged host-bound evidence");
  }
  const markdown = await readFile(previous.evidence.path, "utf8");
  if (markdown !== renderReviewEvidence(pack)) throw new Error("Evidence receipt recovery Markdown differs from its complete Pack");
  if (previous.batch) {
    const candidate = await collectCandidateTreeProof(previous.identity.projectRoot, current, {
      allowedFiles: previous.scope.allowedFiles, batch: { fixedPoint: previous.batch.fixedPoint },
    });
    if (JSON.stringify(pack.batchCandidate) !== JSON.stringify(candidate)) {
      throw new Error("Evidence receipt recovery batch candidate differs from the approved tree");
    }
  }
  return {
    dispatchId: previous.id, runId: previous.runId, snapshotId: current.snapshotId, indexId: digest(current.index),
    packDigest: digest(text), markdownDigest: digest(markdown),
  };
}

async function assertRecoveryFiles(projectRoot, scope) {
  try {
    await exec("git", ["check-ignore", "--", ...scope.allowedFiles], { cwd: projectRoot, timeout: 10_000 });
  } catch (error) {
    if (error.code === 1) return; // check-ignore: no ignored paths.
    throw error;
  }
  throw new Error("Writer recovery cannot review ignored approved files; preserve private files without tracking them");
}

async function assertRecoveryIndex(projectRoot, baseline, current, scope) {
  let changed;
  if (baseline.index !== undefined) {
    changed = indexChanges(baseline.index, current.index);
  } else {
    // Older Packs did not record index blobs. A clean baseline index can be
    // reconstructed from HEAD; staged outside-envelope bytes cannot be proven.
    if (baseline.manifest.some(entry => entry.status !== "??" && entry.status[0] !== " " &&
        !scope.allowedFiles.includes(entry.path))) {
      throw new Error("Legacy review lacks index evidence for pre-existing staged files outside the approved envelope");
    }
    changed = (await exec("git", ["diff", "--cached", "--name-only", "-z", "--relative", baseline.head, "--", "."],
      { cwd: projectRoot, timeout: 10_000 })).stdout.split("\0").filter(Boolean);
  }
  if (changed.some(path => !scope.allowedFiles.includes(path))) {
    throw new Error("Implementation changed index paths outside the approved envelope");
  }
}

export function createImplementationRuntime(pi, packageRoot, {
  rpc = (method, params, options) => requestRpc(pi.events, method, params, options),
  now = Date.now, diagnose = diagnoseRepair, collectEvidence = collectReviewEvidence,
} = {}) {
  const pending = [];
  const records = new Map();
  const plans = new Map();
  const traces = new Map();
  const traceOffsets = new Map();
  const finalChecks = new Map();
  let progressing = false;
  let checkingFinal = false, finalGeneration = 0;
  let active = false, epoch = 0, lifecycle = new AbortController();
  let approval = new AbortController();
  let sessionId, ui;
  const authorization = createDispatchAuthorization({ persist: data => {
    if (!active) throw new Error("Dispatch runtime is no longer active");
    pi.appendEntry(AUTH_ENTRY, data);
  }, now });
  const batchAuthorization = createBatchAuthorization({ persist: data => {
    if (!active) throw new Error("Dispatch runtime is no longer active");
    pi.appendEntry(BATCH_ENTRY, data);
  }, now });
  const save = (record, { latchFinalValidation = false } = {}) => {
    if (!active || record.sessionId !== sessionId) throw new Error("Dispatch session changed");
    const prior = records.get(record.id);
    if (prior?.state === "cancelled") return;
    if (prior?.writerFailureSnapshotId) {
      record = { ...record, writerFailureSnapshotId: prior.writerFailureSnapshotId,
        writerFailureIndexId: prior.writerFailureIndexId };
    }
    if (prior && Object.hasOwn(prior, "initialBlocker")) record = { ...record, initialBlocker: prior.initialBlocker };
    // A refresh that started before a new red was latched cannot restore the prior active check.
    if (prior?.finalValidation && !latchFinalValidation) record = { ...record, finalValidation: prior.finalValidation };
    if (record.finalValidation && record.batchOutcome?.complete && !hasFinalValidationPass(record)) {
      record = { ...record, batchOutcome: { ...record.batchOutcome, complete: false } };
    }
    records.set(record.id, record);
    pi.appendEntry(IMPLEMENTATION_ENTRY, record);
    // Only the refresh that first seals the blocker may announce it. Notify inline:
    // a queued parent follow-up could arrive after the user already approved recovery.
    if (record.initialBlocker && !prior?.initialBlocker) ui?.notify(
      `[pi_matt_dispatch] ${record.id}: initial writer reported BLOCKED by the external test environment. Failure snapshot sealed. ` +
      "Preserve the worktree and index. After fixing the environment, explicitly request blockedRecovery for this dispatch.",
      "warning",
    );
  };
  const traceFor = id => {
    if (!traces.has(id)) {
      const owner = epoch;
      traces.set(id, createDispatchTrace({
        id, now,
        persist: event => { if (active && owner === epoch) pi.appendEntry("pi-x-matt.dispatch-phase", event); },
        emit: event => { if (active && owner === epoch) pi.events.emit(DISPATCH_EVENT, event); },
      }));
    }
    return traces.get(id);
  };
  const identityFor = async projectRoot => {
    const git = async (...args) => (await exec("git", args, { cwd: projectRoot, timeout: 10_000 })).stdout.trim();
    return { sessionId, projectRoot: await realpath(projectRoot),
      branch: await git("rev-parse", "--abbrev-ref", "HEAD"), head: await git("rev-parse", "--verify", "HEAD") };
  };
  const latestFor = (identity, scope) => [...records.values()].filter(record =>
    record.state !== "cancelled" && record.sessionId === identity.sessionId &&
    record.identity?.projectRoot === identity.projectRoot && record.scope?.ticket === scope.ticket).at(-1);
  const assertFinalSnapshot = async (projectRoot, binding) => {
    const current = await collectEvidence(projectRoot);
    if (!current.complete || current.snapshotId !== binding.snapshotId || digest(current.index) !== binding.indexId) {
      throw new Error("Final validation candidate or index is stale or incomplete");
    }
    return current;
  };
  const bindFinalSnapshot = async (record, pack, packText) => {
    const markdown = await readFile(record.evidence.path, "utf8");
    if (typeof pack.index !== "string" || markdown !== renderReviewEvidence(pack)) {
      throw new Error("Final validation requires an intact host Pack with index evidence");
    }
    return { snapshotId: pack.snapshotId, indexId: digest(pack.index),
      packDigest: digest(packText), markdownDigest: digest(markdown) };
  };
  const verifyRequiredFinal = (record, pack, signal) => {
    const saved = records.get(record.id)?.requiredValidation;
    if (saved?.snapshotId === pack.snapshotId) return saved;
    if (!finalChecks.has(record.id)) {
      const verify = async () => {
        const binding = { snapshotId: pack.snapshotId, indexId: digest(pack.index) };
        try {
          if (!batchAuthorization.active(record.batch.id)) throw new Error("Batch authorization is no longer active");
          const candidate = await assertFinalSnapshot(record.identity.projectRoot, binding);
          const pass = record.finalValidationPass;
          const measured = pass?.snapshotId === binding.snapshotId && pass.indexId === binding.indexId
            ? finalValidationChecks(record.finalValidation).filter(check =>
              pass.results?.some(row => row.sourceId === check.sourceId && row.exitCode === 0)).map(check => check.command) : [];
          const commands = record.requiredFinalCommands.filter(command => !measured.includes(command));
          const results = commands.length ? await runFinalValidationChecks(record.identity.projectRoot, candidate,
            commands.map((command, index) => ({ command, sourceId: index })), signal) : [];
          await assertFinalSnapshot(record.identity.projectRoot, binding);
          signal.throwIfAborted();
          const failed = results.find(row => row.exitCode !== 0);
          return { ...binding, ok: !failed, ...(failed ? { error: `Failed: ${commands[failed.sourceId]}` } : {}) };
        } catch (error) {
          return { ...binding, ok: false, error: error.message };
        }
      };
      finalChecks.set(record.id, verify());
    }
    return finalChecks.get(record.id);
  };
  const recordNativeTrace = (record, status) => {
    const trace = status.workflow?.trace ?? [];
    for (let index = traceOffsets.get(record.id) ?? 0; index < trace.length; index++) {
      const row = trace[index];
      if (!["run", "host"].includes(row.operation)) continue;
      const preReview = row.operation === "host" && row.key?.startsWith("pre-review");
      const correction = row.operation === "run" && row.key === "implement-correction";
      traceFor(record.id).record(row.operation === "host"
        ? (row.key === "implement-claim" ? "admission" : preReview ? "verification" : "evidence")
        : correction ? "correction" : row.key?.endsWith("-settlement") ? "settlement" : "execution", row.state, {
        nativeTraceIndex: index, lane: row.key, durationMs: row.durationMs,
        configuredTimeoutMs: row.operation === "host"
          ? (row.key === "implement-claim" ? 10000 : preReview ? PRE_REVIEW_HOST_TIMEOUT_MS : 120000)
          : correction ? CORRECTION_TIMEOUT_MS : row.key?.endsWith("-settlement") ? 300000 : record.laneTimeouts?.[row.key],
        timingScope: "native-run-operation", ...(row.error ? { error: { message: row.error } } : {}),
      });
    }
    traceOffsets.set(record.id, trace.length);
  };
  const refresh = async record => {
    const owner = epoch;
    if (!record.asyncDir) throw new Error(`Dispatch ${record.id}: acceptance unknown; reconcile rpc-spawn-${record.requestId}, never repeat writer`);
    const status = JSON.parse(await readFile(join(record.asyncDir, "status.json"), "utf8"));
    if (!active || owner !== epoch) return status;
    record = records.get(record.id);
    if (record.state === "cancelled") return status;
    if (status.runId !== record.runId) throw new Error("Workflow status identity mismatch");
    recordNativeTrace(record, status);
    const receipt = workflowReceipt(status);
    if (JSON.stringify(receipt) !== JSON.stringify(record.receipt)) {
      if (receipt.settlement && receipt.settlement !== record.receipt?.settlement) ui?.notify(
        `[pi_matt_dispatch] ${record.id}: implement settlement=${receipt.settlement} (300s execution budget; supervisor waits excluded).`,
        "info",
      );
      // Only the dispatch that ran the writer reports it; review, recovery and reconsideration carry the settled result.
      if (receipt.verification?.ok === false && record.receipt?.verification?.ok !== false &&
          record.laneTimeouts?.implement !== undefined) pi.sendUserMessage(
        `[pi_matt_dispatch] ${record.id}: host verification failed after the writer returned COMPLETE (` + [
          ...(receipt.verification.unresolvedFindingIds?.length
            ? [`unaccounted approved findings: ${receipt.verification.unresolvedFindingIds.join(", ")}`] : []),
          ...(receipt.verification.preReviewOk === false ? ["approved pre-review command failed"] : []),
          `in-workflow correction: ${receipt.verification.correction ?? "not attempted"}`,
        ].join("; ") + "). This is host-measured, not a review verdict or a worker claim. " + (record.scope?.delivery
          ? "No new reviewer was launched; do not commit a candidate with a failed check. "
          : record.reviewPending
          ? "Formal review is refused while the retained writer can still correct it: dispatch a further repair for the same approved findings. "
          : "Reviewers were told; the candidate is not deliverable until a repair passes host verification, even on dual PASS. ") +
        (record.scope?.delivery ? "Preserve the candidate and stop for user direction; do not remove the failing check." :
          "If a pre-review command fails for reasons unrelated to this change, stop and let the user re-approve the scope without it; never edit tests or widen scope to satisfy it."),
        { deliverAs: "followUp" },
      );
      const unavailable = receipt.failures.filter(row => ["provider-limit", "infrastructure", "execution"].includes(row.kind));
      if (["complete", "failed"].includes(status.state) && unavailable.length) pi.sendUserMessage(
        `[pi_matt_dispatch] ${record.id}: reviewer execution unavailable (${unavailable.map(row => `${row.lane}=${row.kind}`).join(", ")}), not a code FAIL. ` +
        "No automatic retry. Resolve the provider/environment failure, then use bounded recovery for failed axes; committed review reuses its original Pack.",
        { deliverAs: "followUp" },
      );
      record = { ...record, receipt };
      save(record);
    }
    if (["complete", "failed", "stopped", "paused"].includes(status.state)) {
      const next = { ...record, state: status.state };
      if (record.initialBatch && status.state === "failed" && !Object.hasOwn(record, "initialBlocker")) {
        const result = blockedWriter(status);
        const partial = result && await collectEvidence(record.identity.projectRoot);
        next.initialBlocker = partial?.complete && partial.head === record.identity.head ? {
          snapshotId: partial.snapshotId, indexId: digest(partial.index), resultId: digest(JSON.stringify(result)),
        } : null;
      }
      if (status.state === "failed" && record.reviewPending && !record.recollect && !record.writerFailureSnapshotId) {
        // A failed writer may have partial changes and no post-implementation Pack.
        // Pin the first observed terminal worktree; later refreshes must not bless drift.
        const failure = await collectEvidence(record.identity.projectRoot);
        next.writerFailureSnapshotId = failure.snapshotId;
        next.writerFailureIndexId = digest(failure.index);
      }
      let pack;
      if (record.evidence?.snapshotPath) {
        try {
          const text = await readFile(record.evidence.snapshotPath, "utf8");
          pack = JSON.parse(text);
          next.snapshotId = pack.snapshotId;
          if (status.state === "failed" && pack.complete && pack.envelopeViolation && !record.envelopeViolation) {
            next.envelopeViolation = {
              ...pack.envelopeViolation, snapshotId: pack.snapshotId, indexId: digest(pack.index),
              packDigest: digest(text), markdownDigest: digest(await readFile(record.evidence.path)),
            };
          }
          if (record.workflowName === "matt-code-review" && pack.complete && !record.packDigest) {
            next.packDigest = digest(await readFile(record.evidence.snapshotPath));
            next.markdownDigest = digest(await readFile(record.evidence.path));
          }
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      let validationNotice;
      if (record.batch) {
        const outcome = batchOutcome(status, record.scope.delivery, record.batchCandidate ?? record.batchOutcome?.candidate);
        const carried = outcome.candidate;
        const candidate = carried && carried.snapshotId === next.snapshotId &&
          (record.scope.delivery !== "verified" || pack?.complete) &&
          (!pack || carried.head === pack.head) ? carried : null;
        next.batchOutcome = {
          ...outcome, candidate,
          complete: Boolean(outcome.resultsValid && candidate && !record.reviewPending),
        };
        if (next.batchOutcome.complete && record.requiredFinalCommands?.length) {
          const signal = AbortSignal.any([lifecycle.signal, approval.signal]);
          const receipt = pack ? await verifyRequiredFinal(record, pack, signal)
            : { snapshotId: next.snapshotId, ok: false, error: "Required validation needs an intact evidence Pack" };
          next.batchOutcome.complete = receipt.ok;
          next.requiredValidation = receipt;
          if (!records.get(record.id)?.requiredValidation) {
            validationNotice = receipt.ok ? "PASS for this candidate." : `did not pass; do not commit. ${receipt.error}`;
          }
        }
      }
      if (!active || owner !== epoch) return status;
      save(next);
      if (validationNotice) pi.sendUserMessage(`[pi_matt_dispatch] ${record.id}: required final validation ${validationNotice}`,
        { deliverAs: "followUp" });
    }
    return status;
  };
  const correlate = async record => {
    const owner = epoch;
    const reply = await traceFor(record.id).step("reconcile", () =>
      rpc("status", { id: `rpc-spawn-${record.requestId}` }));
    if (!active || owner !== epoch) throw new Error("Dispatch session changed during reconciliation");
    const details = reply?.details;
    if (!details?.runId || !details.asyncDir) throw new Error("No reliable spawn acceptance proof; do not redispatch");
    const next = { ...record, runId: details.runId, asyncDir: details.asyncDir, state: "running" };
    save(next);
    return next;
  };
  return {
    plans,
    authorization,
    isActive() { return active; },
    start(ctx, reason) {
      lifecycle.abort(new Error("Dispatch session replaced"));
      lifecycle = new AbortController();
      active = true;
      epoch++;
      checkingFinal = false;
      finalGeneration++;
      sessionId = ctx.sessionManager.getSessionId();
      ui = ctx.hasUI ? ctx.ui : undefined;
      pending.splice(0);
      plans.clear();
      records.clear();
      traces.clear();
      traceOffsets.clear();
      finalChecks.clear();
      const entries = ctx.sessionManager.getBranch();
      authorization.start(sessionId, entries, !["new", "fork"].includes(reason));
      batchAuthorization.start(sessionId, entries, !["new", "fork"].includes(reason));
      for (const entry of entries) {
        if (entry.type === "custom" && entry.customType === "pi-x-matt.dispatch-phase" &&
            Number.isInteger(entry.data?.nativeTraceIndex)) {
          traceOffsets.set(entry.data.dispatchId, entry.data.nativeTraceIndex + 1);
        }
        const record = entry.type === "custom" && entry.customType === IMPLEMENTATION_ENTRY ? entry.data : null;
        if (record?.version === 1 && record.sessionId === sessionId && typeof record.id === "string") records.set(record.id, record);
      }
      // A queued plan was never handed to RPC; never silently replay it after reload.
      for (const record of records.values()) {
        if (record.state === "queued") save({ ...record, state: "cancelled" });
      }
    },
    shutdown() {
      active = false;
      epoch++;
      lifecycle.abort(new Error("Dispatch runtime shutdown"));
      plans.clear();
      pending.splice(0);
    },
    input(event) {
      authorization.observeInput(event.text, event.source);
      batchAuthorization.observeInput(event.text, event.source);
    },
    async beginBatchCommand(args, ctx) {
      if (!["tui", "rpc"].includes(ctx.mode) || !ctx.isProjectTrusted()) {
        throw new Error("Implementation command requires a trusted TUI/RPC session");
      }
      if (!ctx.isIdle()) throw new Error("Wait for the current parent turn to settle before starting implementation");
      const match = args.trim().match(/^(\S+)(?:\s+([0-9a-f]{40}|[0-9a-f]{64}))?$/);
      if (!match) throw new Error("Usage: /skill:matt-implement-spec <exact-active-spec-path> [original-fixed-point-SHA]");
      const [, spec, fixedPoint] = match;
      const batch = batchAuthorization.current();
      if (batch?.spec?.path === spec && (!fixedPoint || fixedPoint === batch.fixedPoint) &&
          batchAuthorization.active(batch.invocationId)) return batch;
      this.revoke("new-spec-command");
      const token = batchAuthorization.token();
      const signal = AbortSignal.any([lifecycle.signal, approval.signal]);
      const projectRoot = await findProjectRoot(ctx.cwd);
      const identity = await identityFor(projectRoot);
      const sealed = await readBatchCommandPlan(projectRoot, spec, fixedPoint, identity);
      if (sealed) {
        if (JSON.stringify(identity) !== JSON.stringify(await identityFor(projectRoot))) {
          throw new Error("Project baseline changed while reading the local dispatch plan");
        }
        if (token !== batchAuthorization.token()) throw new Error("Batch authorization changed while preparing the local plan");
        return confirmBatchPlan(ctx, sealed, signal, batchAuthorization);
      }
    },
    revoke(reason) {
      authorization.revoke(reason);
      batchAuthorization.revoke(reason);
      approval.abort(new Error(`Implementation authorization revoked: ${reason}`));
      approval = new AbortController();
      for (const record of records.values()) {
        if (!ACTIVE.has(record.state) || !record.launchClaimPath) continue;
        // Compete with the writer's existing exclusive claim: whichever writes first wins.
        try {
          writeFileSync(record.launchClaimPath, JSON.stringify({ revoked: true }), { flag: "wx", mode: 0o400 });
          plans.delete(record.id);
          save({ ...record, state: "cancelled" });
          traceFor(record.id).record("queue", "cancelled");
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
      }
      for (const dispatch of pending.splice(0)) {
        plans.delete(dispatch.id);
        if (records.has(dispatch.id)) save({ ...records.get(dispatch.id), state: "cancelled" });
        if (!records.get(dispatch.id)?.launchClaimPath) traceFor(dispatch.id).record("queue", "cancelled");
      }
    },
    resolve(args) { return resolveReviewWorkflow(plans, args); },
    async completion(event) {
      const owner = epoch;
      const record = [...records.values()].find(item => item.runId === (event.parentWorkflowRunId ?? event.runId));
      if (!record) return;
      const status = await refresh(record);
      if (!active || owner !== epoch) return;
      if (!event.awaitedByWorkflow) traceFor(record.id).record("workflow", status.state, { runId: record.runId });
    },
    async progress() {
      if (!active || progressing) return;
      progressing = true;
      try {
        for (const record of records.values()) {
          if (record.state === "running" && record.asyncDir) await refresh(record);
        }
      } finally { progressing = false; }
    },
    childStatus(event) {
      const record = [...records.values()].find(item => item.runId === event.runId);
      if (!record) return;
      const key = event.workflowKey ?? event.childId;
      traceFor(record.id).record(String(key).endsWith("-settlement") ? "settlement" :
        key === "implement-correction" ? "correction" : "execution",
        event.status, { lane: key, runId: event.childRunId, at: event.ts ?? now() });
    },
    async flush() {
      const owner = epoch;
      for (const dispatch of pending.splice(0)) {
        const trace = traceFor(dispatch.id);
        let record = records.get(dispatch.id);
        if (record && dispatch.signal?.aborted) {
          authorization.revoke("parent-aborted");
          if (record.batch && batchAuthorization.active(record.batch.id)) batchAuthorization.revoke("parent-aborted");
        }
        if (record && (dispatch.signal?.aborted || (record.workflowName !== "matt-code-review" && !authorization.matches(record.identity, record.scope)) ||
            (record.batch && !batchAuthorization.active(record.batch.id)))) {
          plans.delete(dispatch.id);
          save({ ...record, state: "cancelled" });
          trace.record("queue", "cancelled");
          continue;
        }
        if (record) save({ ...record, state: "rpc-pending" });
        let rpcStarted = false;
        try {
          if (record?.launchSnapshot) {
            const { projectRoot } = record.identity;
            const identity = await identityFor(projectRoot);
            const scope = await resolveImplementationScope(projectRoot, record.scope);
            assertSameLineage(record, identity, scope);
            if (record.batch) {
              const batch = batchAuthorization.current();
              if (!batchAuthorization.active(record.batch.id)) throw new Error("Batch authorization was revoked before launch");
              const previous = records.get(record.launchPreviousId);
              await verifyBatchDispatch(projectRoot, batch, identity, scope, { previous, records, now });
            }
            const current = await collectEvidence(projectRoot);
            if (current.snapshotId !== record.launchSnapshot.id || digest(current.index) !== record.launchSnapshot.indexId) {
              throw new Error("Worktree or index changed after admission; no workflow was launched");
            }
          }
          const finalBinding = record?.finalRepairStart ?? (record?.finalValidationPass && record.finalValidationPass);
          if (finalBinding) {
            const { projectRoot } = record.identity;
            const scope = await resolveImplementationScope(projectRoot, record.scope);
            const identity = await identityFor(projectRoot);
            assertSameLineage(record, identity, scope);
            const batch = batchAuthorization.current();
            if (batch?.invocationId !== record.batch.id) throw new Error("Final validation batch is no longer authorized");
            await verifyBatchDispatch(projectRoot, batch, identity, scope, { previous: record, records, now });
            await assertFinalSnapshot(projectRoot, finalBinding);
            const evidence = record.finalRepairStart ? records.get(finalBinding.dispatchId).evidence : record.evidence;
            if (digest(await readFile(evidence.snapshotPath)) !== finalBinding.packDigest ||
                digest(await readFile(evidence.path)) !== finalBinding.markdownDigest ||
                (record.finalRepairStart && digest(await readFile(record.evidence.baselinePath)) !== record.evidence.baselineDigest) ||
                !authorization.matches(identity, scope) || !batchAuthorization.active(record.batch.id)) {
              throw new Error("Final validation evidence or approval changed before launch");
            }
            dispatch.signal?.throwIfAborted();
          }
          if (record?.writerRecovery || record?.blockedRecovery || record?.evidenceRecovery || record?.recollect) {
            const binding = record.writerRecovery ?? record.blockedRecovery ?? record.evidenceRecovery ?? record.recollect;
            const boundEvidence = record.recollect ?? record.evidence;
            await assertRecoveryFiles(record.identity.projectRoot, record.scope);
            const scope = await resolveImplementationScope(record.identity.projectRoot, record.scope);
            const identity = await identityFor(record.identity.projectRoot);
            assertSameLineage(record, identity, scope);
            if (record.blockedRecovery) {
              const batch = batchAuthorization.current();
              if (batch?.invocationId !== record.batch.id || !(await verifyBatchDispatch(
                record.identity.projectRoot, batch, identity, scope, { previous: record, records, now },
              )).envelopeMatches) throw new Error("Original batch or approved envelope changed; no writer was resumed");
              const source = records.get(binding.dispatchId);
              const result = blockedWriter(await refresh(source));
              if (!result || digest(JSON.stringify(result)) !== binding.resultId ||
                  digest(await readFile(source.evidence.baselinePath)) !== source.evidence.baselineDigest ||
                  digest(await readFile(record.evidence.baselinePath)) !== record.evidence.baselineDigest) {
                throw new Error("Original blocked writer result or recovery baseline changed; no writer was resumed");
              }
            }
            const current = await collectEvidence(record.identity.projectRoot);
            if (!active || owner !== epoch) continue;
            if ((record.blockedRecovery && !current.complete) ||
                current.snapshotId !== binding.snapshotId || digest(current.index) !== binding.indexId ||
                ((record.evidenceRecovery || record.recollect) && (digest(await readFile(boundEvidence.snapshotPath)) !== binding.packDigest ||
                  digest(await readFile(boundEvidence.path)) !== binding.markdownDigest)) ||
                dispatch.signal?.aborted || !authorization.matches(identity, scope) ||
                (record.batch && !batchAuthorization.active(record.batch.id))) {
              plans.delete(dispatch.id);
              save({ ...record, state: "cancelled" });
              trace.record("queue", "cancelled");
              pi.sendUserMessage(`[pi_matt_dispatch] ${dispatch.id}: ` + (record.recollect
                ? "Envelope recollection candidate or artifacts are stale, or authorization changed; no collector was launched."
                : record.evidenceRecovery
                ? "Evidence receipt recovery snapshot or artifacts are stale, or authorization changed; no reviewer was launched."
                : "Writer failure snapshot is stale or authorization changed; no writer recovery was launched."),
                { deliverAs: "followUp" });
              continue;
            }
          }
          dispatch.signal?.throwIfAborted();
          if (!active || owner !== epoch || records.get(dispatch.id)?.state === "cancelled") continue;
          if (record?.scope && (!authorization.matches(record.identity, record.scope) ||
              record.batch && !batchAuthorization.active(record.batch.id))) {
            throw new Error("Implementation authorization changed before launch");
          }
          rpcStarted = true;
          const reply = await trace.step("rpc", () => rpc("spawn", dispatch.rpcParams, { requestId: dispatch.requestId, signal: dispatch.signal }));
          if (!active || owner !== epoch || records.get(dispatch.id)?.state === "cancelled") continue;
          if (record) {
            const details = reply?.details;
            record = { ...record, state: details?.runId && details.asyncDir ? "running" : "acceptance-unknown",
              runId: details?.runId, asyncDir: details?.asyncDir };
            save(record);
          }
        } catch (error) {
          if (!active || owner !== epoch) continue;
          if ((record?.launchSnapshot || record?.writerRecovery || record?.blockedRecovery || record?.evidenceRecovery || record?.recollect ||
              record?.finalRepairStart || record?.finalValidationPass) && !rpcStarted) {
            plans.delete(dispatch.id);
            save({ ...record, state: "cancelled" });
            trace.record("queue", "cancelled");
          } else if (record) save({ ...record, state: error.code === "rpc_acceptance_unknown" ? "acceptance-unknown" : "failed" });
          pi.sendUserMessage(`[pi_matt_dispatch] ${dispatch.id}: ${error.message}. No automatic redispatch.`, { deliverAs: "followUp" });
        }
      }
    },
    async dispatch(params, signal, ctx) {
      if (!active) throw new Error("Dispatch runtime is not active");
      signal = AbortSignal.any([lifecycle.signal, ...(params.workflow === "matt-tdd" ? [approval.signal] : []), ...(signal ? [signal] : [])]);
      signal?.throwIfAborted();
      let finalAdmissionGeneration = finalGeneration;
      if (checkingFinal) throw new Error("A final validation admission is in progress; no workflow was queued");
      if (params.finalValidationRepair !== undefined) {
        validateFinalRepairRequest(params.finalValidationRepair);
        if (params.workflow !== "matt-tdd" || params.batch !== undefined) {
          throw new Error("finalValidationRepair only applies to matt-tdd with the original active batch; omit batch");
        }
        if (Object.keys(params.laneTasks ?? {}).length !== 1 || !Object.hasOwn(params.laneTasks, "implement")) {
          throw new Error("finalValidationRepair accepts only laneTasks.implement");
        }
      }
      if (params.writerRecovery && (!params.laneTasks || Object.keys(params.laneTasks).length !== 1 ||
          !Object.hasOwn(params.laneTasks, "implement"))) {
        throw new Error("writerRecovery accepts only laneTasks.implement");
      }
      if (params.recollect && Object.keys(params.laneTasks ?? {}).length) {
        throw new Error("recollect runs only the host collector; omit laneTasks");
      }
      if (!ctx.isProjectTrusted()) throw new Error("pi-matt-dispatch refuses untrusted project configuration");
      const projectRoot = await findProjectRoot(ctx.cwd);
      const registry = await loadCurrentRegistry(packageRoot);
      const workflow = registry.skills[params.workflow];
      if (!workflow) throw new Error(`Unknown Pi-native workflow '${params.workflow}'`);
      if (params.reviewScope !== undefined && workflow.name !== "matt-code-review") {
        throw new Error("reviewScope only applies to matt-code-review");
      }
      const verifiedDelivery = workflow.name === "matt-tdd" && params.implementation?.delivery === "verified";
      if (verifiedDelivery && (params.repair || params.recovery || params.reconsider || params.acceptRisk)) {
        throw new Error("Verified delivery has no reviewer findings to repair, recover, reconsider or waive");
      }
      const requiredLanes = (params.acceptRisk || params.recollect || (verifiedDelivery && params.review)) ? [] :
        (verifiedDelivery || params.repair || params.writerRecovery || params.finalValidationRepair) ? ["implement"] :
        params.review ? ["standards", "spec"] : params.recovery?.lanes ??
        (params.reconsider?.findings ? [...new Set(params.reconsider.findings.map(item => item.findingId?.split(":")[0]))] : undefined);
      const request = prepareDispatchRequest(registry, workflow, params.task, projectRoot, params.laneTasks, requiredLanes);
      if (verifiedDelivery && Object.keys(params.laneTasks ?? {}).some(key => params.recollect || params.review || key !== "implement")) {
        throw new Error("Verified delivery accepts only an implement task when a writer runs; otherwise omit laneTasks");
      }
      const id = randomUUID(), requestId = randomUUID();
      const trace = traceFor(id);
      let authorizationReason = "not-required";
      let plan, rpcParams;
      let reviewPending;
      if (workflow.name === "matt-tdd") {
        if ([params.repair, params.writerRecovery, params.blockedRecovery, params.recollect, params.recovery,
          params.review, params.reconsider, params.acceptRisk, params.finalValidationRepair].filter(Boolean).length > 1) {
          throw new Error("Repair, writer recovery, recollection, review, recovery, reconsideration and risk acceptance are mutually exclusive");
        }
        if (params.blockedRecovery && params.batch !== undefined) throw new Error("blockedRecovery requires the original active batch; omit batch");
        reviewPending = Boolean(params.repair || params.writerRecovery || params.recollect || params.finalValidationRepair);
        const identity = await identityFor(projectRoot);
        const scope = await resolveImplementationScope(projectRoot, params.implementation);
        const previousCandidate = [...records.values()].filter(record => record.state !== "cancelled" &&
          record.sessionId === sessionId &&
          record.identity?.projectRoot === identity.projectRoot && record.scope?.ticket === scope.ticket).at(-1);
        let batchPlan;
        if (params.batch !== undefined) batchPlan = normalizeBatchPlan(params.batch);
        const batchState = batchAuthorization.current();
        let batch = batchState?.kind === "batch" && batchAuthorization.active(batchState.invocationId) ? batchState : null;
        if (batchPlan) {
          if (batch) assertSameBatchPlan(batch, batchPlan);
          else batch = await trace.step("authorization", async () => {
            const token = batchAuthorization.token();
            const sealed = await prepareBatchPlan(projectRoot, batchPlan, identity);
            signal?.throwIfAborted();
            if (token !== batchAuthorization.token()) throw new Error("Authorization lifecycle changed; no batch workflow was queued");
            trace.record("authorization", "waiting-user");
            return confirmBatchPlan(ctx, sealed, signal, batchAuthorization);
          });
        }
        let batchBinding;
        if (batch?.kind === "batch") {
          const declared = batch.tickets.find(ticket => ticket.ticket === scope.ticket);
          if (!declared && durableBatch(batch)) {
            throw new Error(`Ticket ${scope.ticket} is not declared in the approved batch; no workflow was queued`);
          }
          if (declared || batchPlan) {
            if (!declared) {
              throw new Error(
                `Ticket ${scope.ticket} is not declared in the approved batch; no workflow was queued. ` +
                "Submit one new explicit batch confirmation for an expanded plan.",
              );
            }
            if (batchPlan) assertSameBatchPlan(batch, batchPlan);
            if (previousCandidate && !previousCandidate.batch) {
              throw new Error(
                "An in-progress ticket cannot be enrolled into an approved batch; no workflow was queued. " +
                "Finish it under its existing grant or start a separate ticket.",
              );
            }
            const verified = await verifyBatchDispatch(projectRoot, batch, identity, scope, {
              previous: previousCandidate, records, now,
            });
            if (!batchAuthorization.active(batch.invocationId)) throw new Error("Batch authorization changed during admission");
            if (params.blockedRecovery && !verified.envelopeMatches) {
              throw new Error("blockedRecovery requires the exact original approved envelope");
            }
            batchBinding = { id: batch.invocationId, ticket: scope.ticket, fixedPoint: batch.fixedPoint };
            if (verified.envelopeMatches) {
              const token = authorization.token();
              if (!authorization.matches(identity, scope)) authorization.grant(identity, scope,
                durableBatch(batch) ? "batch-confirmed-plan" : "batch-plan", token);
              authorizationReason = "batch-plan";
            }
          }
        } else if (previousCandidate?.batch) {
          throw new Error(
            "Batch authorization is revoked or expired; no workflow was queued. " +
            "Re-run the batch entry with one explicit confirmation before continuing.",
          );
        }
        for (let record of records.values()) {
          if (record.identity?.projectRoot !== identity.projectRoot || !ACTIVE.has(record.state)) continue;
          if (!record.asyncDir && record.state !== "queued") record = await correlate(record);
          if (record.asyncDir) await refresh(record);
          if (ACTIVE.has(records.get(record.id).state)) throw new Error(`Dispatch ${record.id} is still active; do not repeat implementation`);
        }
        // Lineage is keyed by the session/project/ticket, never by the authorization invocation:
        // renewal after revoke/expiry or a reapproval must not sever the same repair chain.
        let previous = latestFor(identity, scope);
        const followUp = params.repair ?? params.writerRecovery ?? params.blockedRecovery ?? params.recollect ??
          params.recovery ?? params.review ?? params.reconsider ?? params.acceptRisk ?? params.finalValidationRepair;
        if (followUp && (!previous || previous.id !== (followUp.previousDispatchId ?? followUp.dispatchId))) {
          throw new Error(`${params.blockedRecovery ? "blockedRecovery" : "Repair/review/recovery/reconsideration"} must reference the latest host dispatch for this ticket`);
        }
        if (!followUp && previous) {
          throw new Error("This ticket already has a dispatch; use structured repair/review/recovery, never repeat initial implementation");
        }
        if (previous && previous.scope.delivery !== scope.delivery) {
          throw new Error("Delivery policy cannot change within the same implementation lineage");
        }
        if (scope.delivery === "reviewed" && (params.repair || params.finalValidationRepair) &&
            (previous.repair || previous.finalValidation?.attempts > 0)) {
          throw new Error("Post-review repair budget exhausted for this ticket; preserve the candidate and stop for user direction");
        }
        if (verifiedDelivery && params.review && !previous.finalValidation) {
          throw new Error("Verified delivery only uses review to settle a pending final validation repair");
        }
        if (authorizationReason === "not-required") {
          authorizationReason = await trace.step("authorization", () =>
            authorizeWorkflowDispatch(workflow.name, signal, ctx, authorization, scope, identity,
              () => trace.record("authorization", "waiting-user")));
        }
        let repair, recovery, writerRecovery, recollect, recollectIndex, recoveryIndex, evidence, reviewSourceId, reviewBaseline, reviewedSnapshotId, reviewSnapshotHead;
        let blockedRecovery, initialBaseline, evidenceRecovery, recoveredBatchCandidate;
        let finalValidation, finalRepairStart, finalValidationPass;
        let reviewMeta, reconsiderRecord, reviewCandidateSnapshotId, nextRecoveryAttempt;
        const execution = { delivery: scope.delivery };
        if (params.blockedRecovery) {
          if (previous.blockedRecovery) throw new Error("Initial blocked writer recovery exhausted; preserve the failure and stop");
          if (!previous.initialBlocker) {
            throw new Error("No sealed environment blocker with a resumable writer; preserve the draft and original dispatch. " +
              "Do not retry initial or skip the ticket. Ask the user how to retain the draft before planning a separate attempt.");
          }
          if (batchBinding?.id !== previous.batch.id || batchBinding.fixedPoint !== previous.batch.fixedPoint ||
              ["allowedFiles", "diagnosticFiles", "diagnosticCommands", "preReviewCommands"].some(key =>
                JSON.stringify(scope[key] ?? []) !== JSON.stringify(previous.scope[key] ?? []))) {
            throw new Error("blockedRecovery requires the exact original batch and approved envelope");
          }
          assertSameLineage(previous, identity, scope);
          const result = blockedWriter(await refresh(previous));
          const binding = previous.initialBlocker;
          if (!result || digest(JSON.stringify(result)) !== binding.resultId) {
            throw new Error("Original blocked writer result is no longer verifiable; preserve the failure and stop");
          }
          const sealed = await readFile(previous.evidence.baselinePath);
          if (digest(sealed) !== previous.evidence.baselineDigest) throw new Error("Original TDD baseline changed or is missing");
          initialBaseline = JSON.parse(sealed).baseline;
          await assertRecoveryFiles(projectRoot, scope);
          const current = await collectEvidence(projectRoot, { baseline: initialBaseline });
          if (!current.complete || current.snapshotId !== binding.snapshotId || digest(current.index) !== binding.indexId) {
            throw new Error("Initial writer failure snapshot is stale or incomplete; preserve the partial changes");
          }
          await assertRecoveryIndex(projectRoot, initialBaseline, current, scope);
          repairDelta(initialBaseline, current, { allowedFiles: scope.allowedFiles });
          if (!ctx.hasUI) throw new Error("blockedRecovery requires explicit user confirmation that the external environment is fixed");
          const { command, evidence: failureEvidence } = result.structuredOutput.environmentBlocker;
          const confirmed = await withDeadline(dialogSignal => ctx.ui.confirm(
            "Resume the blocked writer once?",
            `Ticket: ${scope.ticket}\nDispatch: ${previous.id}\nFailed command: ${command}\nReported blocker: ${failureEvidence}\n\n` +
            "Confirm that the external test environment is fixed. Resume the same writer, without changing scope or skipping TDD or review?",
            { signal: dialogSignal, timeout: AUTH_WAIT_MS },
          ), { timeoutMs: AUTH_WAIT_MS, signal });
          if (!confirmed) throw new Error("Blocked writer recovery was not approved");
          blockedRecovery = { dispatchId: previous.id, ...binding };
          execution.resume = result.runId;
          execution.writerRecovery = { originalResult: result };
          recoveryIndex = initialBaseline.index;
          request.lanes.find(lane => lane.key === "implement").task +=
            "\n\n仅续跑原任务，保留已有测试草稿与原范围。用户已确认外部测试环境修复。" +
            "从受阻的聚焦测试继续；测试没启动不算 RED。先取得真实 RED，再做最小实现和 GREEN，最后返回原任务完整累计证据。";
        } else if (followUp) {
          if (previous.riskAcceptance) throw new Error("This candidate is terminal with accepted risks; preserve its original FAIL and acceptance receipt. Do not reopen the ticket or reuse its acceptance for new changes");
          assertSameLineage(previous, identity, scope);
          const status = await refresh(previous);
          previous = records.get(previous.id);
          finalValidation = previous.finalValidation;
          if (finalValidation && previous.batch?.id !== batchBinding?.id) {
            throw new Error("Final validation requires the original active batch");
          }
          let results = stageResults(status);
          if (previous.envelopeViolation && !params.recollect) {
            throw new Error(envelopeViolationMessage(previous.envelopeViolation));
          }
          if (params.recollect && (status.state !== "failed" || !previous.envelopeViolation)) {
            throw new Error("recollect requires a failed envelopeViolation dispatch with a complete persisted Pack");
          }
          const recoverReceipt = params.review && legacyEvidenceReceiptFailure(previous, status, results);
          if (params.reconsider && previous.reviewPending) {
            throw new Error("Reconsideration requires a completed formal review; review the pending repair first");
          }
          if (params.review && !recoverReceipt && (!previous.reviewPending || status.state !== "complete")) {
            throw new Error("Formal review requires a completed pending repair");
          }
          if (params.repair) {
            if (previous.reviewPending && status.state !== "complete") {
              throw new Error("Previous repair did not complete; preserve the failure and use bounded writerRecovery only for a resumable execution failure");
            }
            execution.resume = retainedWriter(results);
          }
          if (params.recovery && previous.reviewPending) throw new Error("Pending repair needs review, not reviewer recovery");
          let pack, packText;
          if (params.writerRecovery) {
            if (!previous.reviewPending || !(previous.repair || previous.finalRepairStart) || status.state !== "failed" ||
                !records.has(previous.reviewSourceId)) {
              throw new Error("Writer recovery requires a failed pending repair with its original formal-review source");
            }
            if (previous.writerRecovery) throw new Error("Writer execution recovery exhausted; preserve the failure and stop");
            execution.resume = recoverableWriter(results);
            await assertRecoveryFiles(projectRoot, scope);
            const { baseline } = JSON.parse(await readFile(previous.evidence.baselinePath, "utf8"));
            const current = await collectEvidence(projectRoot, { baseline });
            if (!current.complete || current.snapshotId !== previous.writerFailureSnapshotId ||
                digest(current.index) !== previous.writerFailureIndexId) {
              throw new Error("Writer failure snapshot is stale or incomplete");
            }
            await assertRecoveryIndex(projectRoot, baseline, current, scope);
            repairDelta(baseline, current, { allowedFiles: scope.allowedFiles });
            recoveryIndex = current.index;
            repair = previous.repair;
            reviewSourceId = previous.reviewSourceId;
            reviewBaseline = baseline;
            writerRecovery = { dispatchId: previous.id, snapshotId: current.snapshotId, indexId: digest(current.index),
              originalResult: results.find(result => result.key === "implement") };
            execution.writerRecovery = writerRecovery;
            execution.repairOnly = true;
            pack = baseline;
          } else {
            try {
              packText = await readFile(previous.evidence.snapshotPath, "utf8");
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
              throw new Error("Host candidate Pack is missing; preserve the implementation and failure evidence. " +
                "Recollection requires a persisted envelopeViolation Pack; do not repeat initial implementation.");
            }
            pack = JSON.parse(packText);
            const sealed = recoverReceipt || params.recollect
              ? JSON.parse(await readFile(previous.evidence.baselinePath, "utf8")) : undefined;
            const current = await collectEvidence(projectRoot, sealed ? { baseline: sealed.baseline } : undefined);
            if (pack.snapshotId !== previous.snapshotId || pack.snapshotId !== current.snapshotId || !pack.complete ||
                (pack.index !== undefined && pack.index !== current.index)) {
              throw new Error("Follow-up snapshot is stale or incomplete");
            }
            if (recoverReceipt) {
              completedImplementation(results);
              const baselineSnapshotId = previous.repair
                ? records.get(previous.reviewSourceId)?.snapshotId : previous.evidence.snapshotId;
              evidenceRecovery = {
                ...await verifyLegacyEvidenceReceipt(previous, pack, packText, current, sealed, baselineSnapshotId),
                error: status.error,
              };
              recoveredBatchCandidate = pack.batchCandidate;
            }
            if (params.recollect) {
              execution.implementResult = completedImplementation(results);
              const binding = previous.envelopeViolation;
              const verification = execution.implementResult.hostVerification;
              const skipped = verification?.preReview?.skipped === "envelope-violation";
              if (results.some(result => ["standards", "spec"].includes(result.key)) ||
                  (verification?.ok === false && (!skipped || verification.accounting?.ok === false))) {
                throw new Error("Envelope recollection requires a completed writer without failed host checks or reviewer results");
              }
              if (digest(packText) !== binding.packDigest || digest(current.index) !== binding.indexId ||
                  pack.snapshotId !== binding.snapshotId ||
                  digest(await readFile(previous.evidence.path)) !== binding.markdownDigest ||
                  JSON.stringify(pack.baseline) !== JSON.stringify(sealed.baseline)) {
                throw new Error("Envelope recollection Pack or baseline changed; preserve the original failure");
              }
              for (const key of ["diagnosticFiles", "diagnosticCommands", "preReviewCommands"]) {
                if (JSON.stringify(scope[key] ?? []) !== JSON.stringify(previous.scope[key] ?? [])) {
                  throw new Error("Envelope recollection may only add allowedFiles; diagnostic commands and host checks must stay unchanged");
                }
              }
              const remaining = binding.paths.filter(path => !scope.allowedFiles.includes(path));
              if (remaining.length) throw new Error(envelopeViolationMessage({ paths: remaining }));
              repairDelta(sealed.baseline, current, { allowedFiles: scope.allowedFiles });
              await assertRecoveryFiles(projectRoot, scope);
              recollect = { dispatchId: previous.id, ...binding,
                path: previous.evidence.path, snapshotPath: previous.evidence.snapshotPath };
              recollectIndex = current.index;
              repair = previous.repair;
              reviewBaseline = sealed.baseline;
              reviewSourceId = previous.reviewSourceId ?? previous.id;
              recoveryIndex = sealed.control.recoveryIndex;
              execution.recollect = true;
              execution.repairOnly = true;
              if (verifiedDelivery) reviewPending = Boolean(finalValidation);
              if (skipped) execution.verification = { approvedFindingIds: repair?.approvedFindingIds ?? [] };
            }
          }
          reviewSnapshotHead = pack.head;
          reviewedSnapshotId = params.writerRecovery ? pack.snapshotId : pack.incremental.previousSnapshotId;
          if (params.acceptRisk) {
            if (finalValidation) throw new Error("A final validation repair requires fresh dual PASS; risk acceptance cannot unlock this ticket");
            if (previous.reviewPending) throw new Error("Pending repair must receive a formal review before risk acceptance");
            const candidate = previous.batchOutcome?.candidate ?? previous.batchCandidate;
            if (previous.batch && (!candidate || candidate.snapshotId !== pack.snapshotId || candidate.head !== pack.head)) {
              throw new Error("Risk acceptance cannot recover a missing or stale batch candidate proof");
            }
            const requiredValidation = previous.requiredFinalCommands?.length
              ? await verifyRequiredFinal(previous, pack, signal) : undefined;
            if (requiredValidation && !requiredValidation.ok) throw new Error("Risk acceptance cannot waive required final validation");
            const riskAcceptance = await confirmRiskAcceptance(params.acceptRisk, results, previous, ctx, signal, now);
            const checkedScope = await resolveImplementationScope(projectRoot, params.implementation);
            const checkedEvidence = await collectEvidence(projectRoot);
            if (!authorization.matches(await identityFor(projectRoot), checkedScope) ||
                (previous.batch && !batchAuthorization.active(previous.batch.id)) ||
                checkedEvidence.snapshotId !== pack.snapshotId ||
                (pack.index !== undefined && pack.index !== checkedEvidence.index) ||
                [...records.values()].filter(record => record.scope?.ticket === scope.ticket &&
                  record.identity?.projectRoot === identity.projectRoot).at(-1)?.id !== previous.id) {
              throw new Error("Candidate, authorization or scope changed while confirming risks; no acceptance was recorded");
            }
            signal?.throwIfAborted();
            const { runId, asyncDir, ...source } = previous;
            save({ ...source, id, requestId, sourceRunId: runId, sourceAsyncDir: asyncDir,
              riskAcceptance, originalResults: results, state: "accepted-risk", at: now(),
              ...(requiredValidation ? { requiredValidation } : {}),
              ...(previous.batch ? { batchOutcome: { ...previous.batchOutcome, complete: true, candidate,
                delivery: "accepted-risk", resultsValid: false } } : {}) });
            return {
              content: [{ type: "text", text: `Risk-accepted candidate; original FAIL retained, not dual PASS. acceptanceId=${id}. ` +
                `Only this candidate may be delivered. Record "Risk acceptance: ${id}" with the Implementation commit in local tracker Comments.` }],
              details: { dispatchId: id, state: "accepted-risk", deliveryEligible: true, reviewPassed: false, riskAcceptance },
            };
          }
          const boundary = {
            incremental: Boolean(previous.repair || finalValidation),
            changedPaths: params.writerRecovery ? [] : pack.incremental.changes.map(change => change.path),
            approvedFindingIds: previous.repair?.approvedFindingIds ?? [],
          };
          reviewMeta = reviewMetaFor(previous, pack.snapshotId);
          reviewCandidateSnapshotId = pack.snapshotId;
          if (params.recovery && !previous.reconsider) {
            const keys = params.recovery.lanes;
            if (!Array.isArray(keys) || !keys.length || new Set(keys).size !== keys.length ||
                keys.some(key => !["standards", "spec"].includes(key))) {
              throw new Error("Recovery only accepts failed reviewer lanes");
            }
            const checked = revalidateReviewReports(results, keys, boundary, pack.snapshotId);
            results = checked.results;
            execution.hostRevalidated = checked.keys;
          }
          if (params.finalValidationRepair) {
            const requested = params.finalValidationRepair;
            const candidate = previous.batchOutcome?.candidate;
            if (!batchBinding || previous.batch?.id !== batchBinding.id || !candidate ||
                candidate.fixedPoint !== batchBinding.fixedPoint || status.state !== "complete" ||
                (previous.reviewPending ? !finalValidation : !previous.batchOutcome.resultsValid)) {
              throw new Error("finalValidationRepair requires the latest dual-PASS or host-verified candidate in its original batch, or its completed pending repair");
            }
            const registering = requested.command !== undefined;
            const resolved = finalValidation && !previous.reviewPending && previous.batchOutcome.complete;
            if (registering && finalValidation) {
              if (!resolved) {
                throw new Error("A different final validation command requires the prior check to pass and fresh dual PASS " +
                  "(or passing host checks for verified delivery); retry with dispatchId only");
              }
              if (finalValidationChecks(finalValidation).some(check => check.command === requested.command)) {
                throw new Error("A new final validation command must differ from all previously registered checks");
              }
            } else if (!registering && (!finalValidation || resolved)) {
              throw new Error("Registering a final validation regression requires an exact command and expectedFailure");
            }
            if ((finalValidation?.attempts ?? 0) >= FINAL_REPAIR_LIMIT) {
              throw new Error("Final validation repair budget exhausted; preserve the worktree and stop");
            }
            await assertRecoveryFiles(projectRoot, scope);
            const binding = { dispatchId: previous.id, ...await bindFinalSnapshot(previous, pack, packText) };
            const recipe = registering ? { command: requested.command, expectedFailure: requested.expectedFailure } : finalValidation;
            if (checkingFinal || finalAdmissionGeneration !== finalGeneration) {
              throw new Error("Final validation admission changed; retry from the latest dispatch");
            }
            checkingFinal = true;
            const generation = finalAdmissionGeneration = ++finalGeneration;
            try {
              const assertFinalAdmission = async () => {
                const live = await identityFor(projectRoot);
                const liveScope = await resolveImplementationScope(projectRoot, params.implementation);
                assertSameLineage(previous, live, liveScope);
                if (!authorization.matches(live, liveScope) || !batchAuthorization.active(batchBinding.id)) {
                  throw new Error("Final validation authorization changed");
                }
                await verifyBatchDispatch(projectRoot, batch, live, liveScope, { previous, records, now });
                const current = await assertFinalSnapshot(projectRoot, binding);
                signal.throwIfAborted();
                if (latestFor(identity, scope)?.id !== previous.id ||
                    [...records.values()].some(record => record.identity?.projectRoot === identity.projectRoot && ACTIVE.has(record.state))) {
                  throw new Error("Final validation must reference the latest idle dispatch");
                }
                return current;
              };
              const approvedChecks = batch.tickets.find(ticket => ticket.ticket === scope.ticket)?.finalValidationCommands;
              if (registering && !approvedChecks?.includes(recipe.command)) {
                await confirmFinalValidation(ctx, scope.ticket, pack.snapshotId, recipe, signal);
              }
              const current = await assertFinalAdmission();
              const measured = await trace.step("final-validation", () => measureFinalValidation(
                projectRoot, current, recipe, signal, { compareBaseline: registering },
              ));
              await assertFinalAdmission();
              if (measured.result.exitCode !== 1 || !measured.result.matched) {
                throw new Error("Final validation did not reproduce the approved failure (exit 1 with the expected text)");
              }
              if (registering) {
                const { priorChecks = [], attempts = 0, ...priorCheck } = finalValidation ?? {};
                finalValidation = { ...recipe, sourceId: previous.id, originalSnapshotId: pack.snapshotId,
                  tree: candidate.tree, baseline: measured.baseline, failure: measured.result, attempts,
                  ...(previous.finalValidation ? { priorChecks: [...priorChecks, priorCheck] } : {}) };
                // Latch the failure on the source before selecting or queueing a writer. Cancellation,
                // reload and an unavailable writer must not restore the original delivery permission.
                save({ ...records.get(previous.id), finalValidation }, { latchFinalValidation: true });
              }
              finalRepairStart = { ...binding, failure: measured.result };
            } finally {
              if (finalGeneration === generation) checkingFinal = false;
            }
            execution.resume = retainedWriter(results);
            execution.repairOnly = true;
            finalValidation = { ...finalValidation, attempts: finalValidation.attempts + 1 };
            repair = previous.reviewPending ? previous.repair : undefined;
            reviewSourceId = previous.reviewPending ? previous.reviewSourceId : previous.id;
            reviewBaseline = reviewSourceId === previous.id ? pack
              : JSON.parse(await readFile(records.get(reviewSourceId).evidence.snapshotPath, "utf8"));
          } else if (params.reconsider) {
            const reconsideration = prepareReconsideration(params.reconsider, results, reviewMeta.reconsiderCounts);
            nextRecoveryAttempt = previous.recoveryAttempt ?? 0;
            reviewMeta = { ...reviewMeta, reconsiderCounts: reconsideration.counts };
            evidence = previous.evidence;
            repair = previous.repair;
            const history = Object.fromEntries(reconsideration.axes.map(axis => [
              axis, results.find(result => result.key === axis)?.reconsiderationHistory ?? [],
            ]));
            reconsiderRecord = {
              candidateSnapshotId: pack.snapshotId, keys: reconsideration.axes,
              targets: reconsideration.targets, originals: reviewStageResults(results), history,
            };
            execution.reconsider = {
              keys: reconsideration.axes, targets: reconsideration.targets, results,
              history, candidateSnapshotId: pack.snapshotId, dispatchId: id,
            };
          } else if (params.recovery) {
            const keys = params.recovery.lanes.filter(key => !execution.hostRevalidated?.includes(key));
            const selected = keys.map(key => results.find(result => result.key === key));
            for (const [index, key] of keys.entries()) {
              const result = selected[index];
              if (!result) throw new Error(`Review ${key} result is missing; preserve the failure and stop`);
            }
            if (previous.reconsider) {
              const outside = keys.filter(key => !previous.reconsider.keys.includes(key));
              if (outside.length) {
                throw new Error(`Report correction must keep the reconsideration target contract (${previous.reconsider.keys.join(", ")}); ` +
                  `invalid lane(s): ${outside.join(", ")}`);
              }
              const contractKeys = keys.filter((key, index) => selected[index]?.contractError);
              const executionKeys = keys.filter((key, index) => !selected[index]?.contractError);
              const corrections = contractKeys.length
                ? reviewReportCorrections(results, contractKeys, reviewMeta.correctionCounts) : null;
              if (corrections) reviewMeta = { ...reviewMeta, correctionCounts: corrections.counts };
              const executionRecovery = executionKeys.length
                ? reviewRecovery(results, executionKeys, previous.recoveryAttempt ?? 0) : null;
              nextRecoveryAttempt = executionRecovery?.attempt ?? previous.recoveryAttempt ?? 0;
              evidence = previous.evidence;
              repair = previous.repair;
              const clean = results.map(result => keys.includes(result.key)
                ? previous.reconsider.originals.find(original => original.key === result.key) ?? result : result);
              const history = Object.fromEntries(previous.reconsider.keys.map(key => [
                key, results.find(result => result.key === key)?.reconsiderationHistory ?? previous.reconsider.history?.[key] ?? [],
              ]));
              reconsiderRecord = {
                candidateSnapshotId: previous.reconsider.candidateSnapshotId,
                keys: previous.reconsider.keys, targets: previous.reconsider.targets,
                originals: previous.reconsider.originals, history,
              };
              execution.reconsider = {
                keys, targets: reconsiderRecord.targets.filter(target => keys.includes(target.axis)),
                results: clean, priorResults: results, history, correctionKeys: contractKeys,
                candidateSnapshotId: reconsiderRecord.candidateSnapshotId, dispatchId: id, recovery: true,
              };
            } else {
              const contractKeys = keys.filter((key, index) => selected[index]?.contractError);
              const executionKeys = keys.filter((key, index) => !selected[index]?.contractError);
              const corrections = contractKeys.length
                ? reviewReportCorrections(results, contractKeys, reviewMeta.correctionCounts) : null;
              if (corrections) reviewMeta = { ...reviewMeta, correctionCounts: corrections.counts };
              const executionRecovery = executionKeys.length
                ? reviewRecovery(results, executionKeys, previous.recoveryAttempt ?? 0) : null;
              recovery = {
                results, keys: [...executionKeys, ...contractKeys],
                attempt: executionRecovery?.attempt ?? previous.recoveryAttempt ?? 0,
                ...(contractKeys.length ? { correctionKeys: contractKeys } : {}),
              };
              nextRecoveryAttempt = recovery.attempt;
              recovery.boundary = boundary;
              evidence = previous.evidence;
              repair = previous.repair;
            }
          } else if (params.review) {
            execution.implementResult = completedImplementation(results);
            const verification = execution.implementResult.hostVerification;
            if (scope.delivery && (verification?.ok === false || (scope.preReviewCommands?.length &&
                (verification?.preReview?.ok !== true || verification.preReview.snapshotId !== pack.snapshotId ||
                  verification.preReview.indexId !== digest(pack.index) ||
                  JSON.stringify(verification.preReview.results.map(row => row.command)) !== JSON.stringify(scope.preReviewCommands))))) {
              throw new Error("Approved host checks did not pass on this exact candidate; do not commit or launch reviewers");
            }
            if (verification?.ok === false) {
              // A correctable failure goes back to the retained writer; only the user may withdraw a failing command.
              const approved = new Set(scope.preReviewCommands ?? []);
              const failed = (verification.preReview?.results ?? []).filter(row => row?.ok === false).map(row => row.command);
              const reasons = [
                ...(failed.some(command => approved.has(command))
                  ? [`approved pre-review command(s) still failing: ${failed.filter(command => approved.has(command)).join(" | ")}`] : []),
                ...(verification.accounting?.unresolvedFindingIds?.length
                  ? [`unaccounted approved findings: ${verification.accounting.unresolvedFindingIds.join(", ")}`] : []),
                ...(verification.accounting?.invalid?.length
                  ? [`invalid finding resolutions: ${verification.accounting.invalid.map(row => `${row.findingId} (${row.reason})`).join(", ")}`] : []),
              ];
              let correctable = reasons.length > 0;
              try { if (correctable) retainedWriter(results); } catch { correctable = false; }
              if (correctable) throw new Error(
                `Formal review refused: host verification of the pending repair still fails (${reasons.join("; ")}). ` +
                "Dispatch a further repair for the same approved findings so the retained writer fixes it; do not review around a known failure. " +
                "If a command fails for reasons unrelated to this change, stop and let the user re-approve the scope without it.",
              );
              if (failed.length && !failed.some(command => approved.has(command))) {
                execution.implementResult = { ...execution.implementResult,
                  hostVerification: { ...verification, waived: "pre-review-command-withdrawn" } };
              }
            }
            if (finalValidation) {
              if (execution.implementResult.hostVerification?.ok === false && !execution.implementResult.hostVerification.waived) {
                throw new Error("Final validation repair has failed host pre-review verification; no reviewers were queued");
              }
              const candidate = previous.batchOutcome?.candidate ?? recoveredBatchCandidate;
              if (!candidate || candidate.tree === finalValidation.tree) {
                throw new Error("Final validation repair requires a changed candidate tree before review");
              }
              const binding = { sourceId: finalValidation.sourceId, ...await bindFinalSnapshot(previous, pack, packText) };
              const current = await assertFinalSnapshot(projectRoot, binding);
              const checks = await trace.step("final-validation", () => recheckFinalValidation(projectRoot, current, finalValidation, signal));
              await assertFinalSnapshot(projectRoot, binding);
              const failure = checks.find(check => check.exitCode !== 0);
              if (failure?.sourceId === finalValidation.sourceId) {
                throw new Error(`Final validation still fails; no reviewers were queued. ` +
                  `Use finalValidationRepair with dispatchId only for the same regression, or stop; outputSha256=${failure.outputSha256}`);
              } else if (failure) {
                throw new Error(`A previously registered final validation failed; no reviewers were queued. ` +
                  `Stop and preserve evidence (source dispatch ${failure.sourceId}); outputSha256=${failure.outputSha256}`);
              }
              finalValidationPass = { ...binding, results: checks };
            }
            execution.boundary = boundary;
            evidence = previous.evidence;
            repair = previous.repair;
          } else if (!params.writerRecovery && !params.recollect) {
            const source = previous.reviewPending ? records.get(previous.reviewSourceId) : previous;
            if (!source) throw new Error("Missing host formal-review source for pending repair");
            const sourceResults = source.id === previous.id ? results : stageResults(await refresh(source));
            repair = prepareRepair(previous, params.repair, sourceResults);
            repair = await trace.step("diagnosis", () => diagnose(
              repair, params.repair.diagnosis, scope, projectRoot, signal, undefined,
              { reviewedSnapshotPath: previous.evidence?.snapshotPath, reviewedDispatchId: previous.id },
            ));
            execution.repairOnly = true;
            reviewSourceId = source.id;
            reviewBaseline = source.id === previous.id ? pack : JSON.parse(await readFile(source.evidence.snapshotPath, "utf8"));
          }
          if (finalValidation && (params.recovery || params.reconsider)) {
            finalValidationPass = previous.finalValidationPass;
          }
        }
        const needsLaunchSnapshot = !evidence && !writerRecovery && !blockedRecovery && !finalRepairStart && !recollect;
        if (!evidence) evidence = await trace.step("evidence", () => prepareTddEvidence(projectRoot, packageRoot, {
          allowedFiles: scope.allowedFiles, ...(repair ?? {}),
          ...(scope.preReviewCommands?.length ? { preReviewCommands: scope.preReviewCommands } : {}),
          ...(writerRecovery || blockedRecovery ? { recoveryIndex } : {}),
          ...(recollect ? { recollect: { snapshotId: recollect.snapshotId, index: recollectIndex },
            ...(recoveryIndex !== undefined ? { recoveryIndex } : {}) } : {}),
          ...(batchBinding ? { batch: { fixedPoint: batchBinding.fixedPoint } } : {}),
          ...(reviewBaseline && (!recollect || repair) ? { previousSnapshotId: reviewBaseline.snapshotId } : {}),
        }, initialBaseline ?? reviewBaseline));
        if ((params.repair && evidence.snapshotId !== repair.previousSnapshotId) ||
            (finalRepairStart && (evidence.snapshotId !== finalRepairStart.snapshotId || evidence.indexId !== finalRepairStart.indexId))) {
          throw new Error("Previous review no longer matches the worktree; do not dispatch a repair");
        }
        const writerFailure = writerRecovery ?? blockedRecovery;
        if (writerFailure && (evidence.snapshotId !== writerFailure.snapshotId || evidence.indexId !== writerFailure.indexId)) {
          throw new Error("Writer failure snapshot is stale; do not dispatch writer recovery");
        }
        // A new writer candidate starts a fresh review budget; review/recovery/reconsideration
        // keep the exact candidate snapshot they were dispatched against.
        if (params.repair || params.writerRecovery || finalRepairStart || !reviewCandidateSnapshotId) reviewCandidateSnapshotId = evidence.snapshotId;
        if (!reviewMeta || reviewMeta.candidateSnapshotId !== reviewCandidateSnapshotId) {
          reviewMeta = reviewMetaFor(previous, reviewCandidateSnapshotId);
        }
        let batchCandidate;
        if (batchBinding && previous && (params.review || params.recovery || params.reconsider)) {
          const carried = recoveredBatchCandidate ?? previous.batchOutcome?.candidate ?? previous.batchCandidate;
          if (carried && carried.snapshotId === reviewCandidateSnapshotId && carried.head === reviewSnapshotHead) {
            batchCandidate = carried;
          }
        }
        signal?.throwIfAborted();
        const liveScope = await resolveImplementationScope(projectRoot, params.implementation);
        if (!authorization.matches(await identityFor(projectRoot), liveScope)) throw new Error("Authorization changed while preparing dispatch");
        signal.throwIfAborted();
        // Commit admission atomically after all asynchronous preparation. Nothing
        // below awaits before saving queued, so competing plans cannot both win.
        if (checkingFinal || finalAdmissionGeneration !== finalGeneration) {
          throw new Error("Final validation admission changed while preparing dispatch; no workflow was queued");
        }
        const latest = latestFor(identity, scope);
        if (latest?.id !== previous?.id) throw new Error("Dispatch must reference the latest host dispatch for this ticket");
        const busy = [...records.values()].find(record =>
          record.identity?.projectRoot === identity.projectRoot && ACTIVE.has(record.state));
        if (busy) throw new Error(`Dispatch ${busy.id} is still active; do not repeat implementation`);
        if (repair) {
          reviewedSnapshotId = reviewBaseline?.snapshotId ?? reviewedSnapshotId;
          for (const lane of request.lanes) {
            if (lane.key === "implement") {
              lane.task += `\n\nRoot-cause repair contract (only these findings):\n${JSON.stringify(repair)}` +
                "\n\nFinding accounting (host-checked before any review): return findingResolutions with exactly one row per " +
                "approvedFindingIds entry. findingId is the exact axis-prefixed ID; cycleTest is the `test` of the cycle in this " +
                "result's cycles that proves the fix, or null when no test can express it; evidence states what changed and where " +
                "(for a null cycleTest, also why no test applies). A missing, duplicate or unknown row fails the host check and " +
                "blocks formal review. Re-read each finding's expected/actual and locations before claiming it resolved.";
            }
          }
        }
        if (finalValidation && request.lanes.some(lane => lane.key === "implement")) {
          request.lanes.find(lane => lane.key === "implement").task +=
            "\n\nHost-verified final validation regression (not a reviewer finding): " +
            JSON.stringify({ command: finalValidation.command, expectedFailure: finalValidation.expectedFailure,
              candidate: finalRepairStart?.snapshotId ?? finalValidation.originalSnapshotId,
              failure: finalRepairStart?.failure ?? finalValidation.failure }) +
            "\nFix only the approved behavior in the existing write envelope. Add focused RED/GREEN coverage where possible; " +
            "do not weaken the failed check. The host reruns all registered final checks before formal review." +
            (finalValidation.priorChecks?.length ? "\nPreserve the previously fixed behavior checked by: " +
              JSON.stringify(finalValidation.priorChecks.map(check => check.command)) : "");
        }
        // Only a dispatch that runs the writer is verified; review, recovery and reconsideration reuse a settled candidate.
        if (!params.review && !params.recovery && !params.reconsider && !params.recollect) {
          execution.verification = { approvedFindingIds: repair?.approvedFindingIds ?? [] };
          // Naming the gate up front spares a correction turn the writer could have avoided.
          if (scope.preReviewCommands?.length) {
            for (const lane of request.lanes) {
              if (lane.key === "implement") {
                lane.task += "\n\nHost pre-review commands (the host runs exactly these, in order, after you return COMPLETE and " +
                  `before any review): ${JSON.stringify(scope.preReviewCommands)}. You may run them to confirm before returning; ` +
                  "do not return COMPLETE while you know one fails because of your change.";
              }
            }
          }
        }
        for (const lane of request.lanes) {
          if (!["standards", "spec"].includes(lane.key)) continue;
          if (scope.delivery === "reviewed") {
            lane.task += "\n\nOnly block on a demonstrated acceptance failure, reachable regression, critical rule or " +
              "safety/data-integrity issue, or missing evidence for required behavior. Record naming, style, redundant test coverage " +
              "and optional cleanup in notes. For a changed candidate after repair, only follow prior findings and directly affected behavior, " +
              "plus newly evidenced safety/data-integrity risks; do not re-review unchanged, unaffected work.";
          }
          const permitted = (repair?.approvedFindings ?? []).filter(finding => finding.axis === lane.key)
            .map(finding => finding.id);
          const causal = (repair?.approvedFindings ?? []).filter(finding => finding.axis !== lane.key)
            .map(finding => ({ id: finding.id, rootCauseId: finding.rootCauseId, title: finding.title,
              recommendation: finding.recommendation,
              repairs: (repair.groups ?? []).filter(group => group.findingIds.includes(finding.id))
                .map(({ contract, preserve, callPath }) => ({ contract, preserve, callPath })) }));
          lane.task += `\n\nAxis-specific finding references (${lane.key}): permitted predecessor IDs = ${JSON.stringify(permitted)}. ` +
            `Use these exact IDs for original/recurring findings. Cross-axis causal predecessors = ${JSON.stringify(causal)}. ` +
            "Only classification=regression may link those cross-axis IDs, with a changed path or affectedBy and causal evidence. " +
            "These are causal references and the behavior this repair must preserve, never the other axis's judging criteria. " +
            "Before proposing a fix, check both the repair contract and preserved behavior for conflicts; do not prescribe an implementation that breaks either. Unknown IDs remain invalid. " +
            (permitted.length
              ? `Correct recurring example: ${JSON.stringify({
                id: "new-finding", rootCauseId: "same-root-cause", classification: "regression",
                relatedFindingIds: [permitted[0]], affectedBy: [],
              })}.`
              : "Conditional recurring example (ONLY if this axis's permitted list is nonempty): " +
                "classification=regression, relatedFindingIds=[one exact ID from that list]. " +
                "No predecessor IDs are approved for this axis now; do not claim a recurrence.") +
            ` Correct independent example: ${JSON.stringify({
              id: "new-finding", rootCauseId: "new-root-cause", classification: "independent",
              relatedFindingIds: [], affectedBy: [],
            })}. Do not rename a recurring rootCauseId. Unknown references or unsupported cross-axis links are report contract errors, ` +
            "not PASS or FAIL, and must be corrected rather than silently dropped.";
          if (repair) {
            lane.task += `\nIncremental review: previousSnapshotId=${reviewedSnapshotId}; approved findings=${JSON.stringify(permitted)}. ` +
              "Preserve each axis verdict. Recurring findings use this axis's permitted IDs; evidenced regressions may use the supplied cross-axis causal IDs. No unrelated re-review.\n" +
              JSON.stringify(repair.approvedFindings.filter(finding => finding.axis === lane.key));
          }
        }
        execution.pendingFinalValidation = verifiedDelivery && reviewPending;
        plan = buildDispatchRequest(request, evidence, recovery, execution);
        plans.set(id, plan);
        const { script: _script, ...options } = plan.rpcParams;
        rpcParams = { ...options, workflow: "pi-x-matt.tdd", args: { dispatchId: id } };
        save({ version: 1, sessionId, id, requestId, invocationId: authorization.current().invocationId, identity, scope, evidence, repair,
          ...(needsLaunchSnapshot ? { launchSnapshot: { id: evidence.snapshotId, indexId: evidence.indexId },
            launchPreviousId: previous?.id } : {}),
          ...(!execution.implementResult && !params.recovery && !params.reconsider ? { launchClaimPath: evidence.claimPath } : {}),
          ...(!previous && batchBinding ? { initialBatch: true } : {}),
          ...(blockedRecovery ? { blockedRecovery } : {}),
          ...(writerRecovery ? { writerRecovery } : {}),
          ...(evidenceRecovery ? { evidenceRecovery } : {}),
          ...(recollect ? { recollect } : {}),
          ...(finalValidation ? { finalValidation } : {}),
          ...(finalRepairStart ? { finalRepairStart } : {}),
          ...(finalValidationPass ? { finalValidationPass } : {}),
          ...(batchBinding ? { batch: batchBinding } : {}),
          ...(batchBinding ? { requiredFinalCommands: batch.tickets.find(ticket => ticket.ticket === scope.ticket).finalValidationCommands } : {}),
          ...(batchCandidate ? { batchCandidate } : {}),
          reviewPending, ...(reviewSourceId ? { reviewSourceId } : {}),
          laneTimeouts: Object.fromEntries(plan.lanes.map(lane => [lane.key, lane.timeoutMs])),
          reviewMeta, ...(reconsiderRecord ? { reconsider: reconsiderRecord } : {}),
          recoveryAttempt: (params.recovery || params.reconsider || evidenceRecovery || recollect)
            ? nextRecoveryAttempt ?? previous?.recoveryAttempt ?? 0 : 0,
          state: "queued", at: now() });
      } else {
        if (params.implementation || params.repair || params.writerRecovery || params.blockedRecovery || params.recollect || params.review || params.reconsider ||
            params.batch !== undefined) {
          throw new Error("Implementation and batch controls only apply to matt-tdd");
        }
        if (params.recovery || params.acceptRisk) {
          if (params.recovery && params.acceptRisk) throw new Error("Recovery and risk acceptance are mutually exclusive");
          if (workflow.name !== "matt-code-review" || params.reviewScope !== undefined) {
            throw new Error("Standalone recovery only supports matt-code-review and reuses its original pinned scope; omit reviewScope");
          }
          let previous = records.get((params.recovery ?? params.acceptRisk).dispatchId);
          if (!previous || previous.workflowName !== workflow.name || previous.sessionId !== sessionId ||
              previous.identity?.projectRoot !== await realpath(projectRoot) ||
              [...records.values()].filter(record => record.reviewRootId === previous.reviewRootId).at(-1)?.id !== previous.id) {
            throw new Error("Standalone recovery must reference the latest host dispatch in this committed review chain");
          }
          if (previous.riskAcceptance) throw new Error("This committed review is terminal with accepted risks; do not reuse its acceptance");
          const results = stageResults(await refresh(previous), workflow.name);
          previous = records.get(previous.id);
          await assertCommittedReviewFresh(projectRoot, previous.reviewControl);
          if (!previous.packDigest || previous.packDigest !== digest(await readFile(previous.evidence.snapshotPath)) ||
              previous.markdownDigest !== digest(await readFile(previous.evidence.path))) {
            throw new Error("Original committed Evidence Pack is missing or changed; no recovery was queued");
          }
          if (params.acceptRisk) {
            const riskAcceptance = await confirmRiskAcceptance(params.acceptRisk, results, previous, ctx, signal, now);
            await assertCommittedReviewFresh(projectRoot, previous.reviewControl);
            if (previous.packDigest !== digest(await readFile(previous.evidence.snapshotPath)) ||
                previous.markdownDigest !== digest(await readFile(previous.evidence.path)) ||
                [...records.values()].filter(record => record.reviewRootId === previous.reviewRootId).at(-1)?.id !== previous.id) {
              throw new Error("Original committed Evidence Pack changed during risk confirmation; no acceptance was recorded");
            }
            signal?.throwIfAborted();
            const { runId, asyncDir, ...source } = previous;
            save({ ...source, id, requestId, sourceRunId: runId, sourceAsyncDir: asyncDir,
              riskAcceptance, originalResults: results, state: "accepted-risk", at: now() });
            return { content: [{ type: "text", text: `Committed review accepted with known P2 risks; original FAIL retained, not dual PASS. acceptanceId=${id}. Record this receipt in the local tracker.` }],
              details: { dispatchId: id, state: "accepted-risk", deliveryEligible: true, reviewPassed: false, riskAcceptance } };
          }
          const recovery = reviewRecovery(results, params.recovery.lanes, previous.recoveryAttempt ?? 0, workflow.name);
          plan = buildDispatchRequest(request, previous.evidence, recovery);
          save({ ...previous, id, requestId, runId: undefined, asyncDir: undefined,
            recoveryAttempt: recovery.attempt, state: "queued", at: now() });
          plans.set(id, plan);
          const { script: _script, ...options } = plan.rpcParams;
          rpcParams = { ...options, workflow: "pi-x-matt.tdd", args: { dispatchId: id } };
        } else if (params.reviewScope !== undefined) {
          const scope = normalizeCommittedReviewScope(params.reviewScope);
          const control = await trace.step("admission", () => admitCommittedReview(projectRoot, scope.fixedPoint));
          const evidence = await trace.step("evidence", () =>
            prepareCommittedReviewEvidence(projectRoot, packageRoot, control));
          signal?.throwIfAborted();
          plan = buildDispatchRequest(request, evidence);
          // Reuse the session-scoped owned-plan resource so the committed collector's
          // fixed host command has explicit authority; this grants no writer capability.
          plans.set(id, plan);
          const { script: _script, ...options } = plan.rpcParams;
          rpcParams = { ...options, workflow: "pi-x-matt.tdd", args: { dispatchId: id } };
          save({ version: 1, sessionId, id, requestId, workflowName: workflow.name, reviewRootId: id,
            identity: await identityFor(projectRoot), evidence, reviewControl: control,
            recoveryAttempt: 0, laneTimeouts: Object.fromEntries(plan.lanes.map(lane => [lane.key, lane.timeoutMs])),
            state: "queued", at: now() });
        } else {
          plan = buildDispatchRequest(request);
          rpcParams = plan.rpcParams;
        }
      }
      pending.push({ id, requestId, rpcParams, signal });
      trace.record("queue", "queued");
      return {
        content: [{ type: "text", text: `Validated and queued '${workflow.name}'; dispatchId=${id}. It will launch after the current turn. Wait for completion; do not poll or redispatch.` }],
        details: { workflow: workflow.name, mode: workflow.workflow.mode, lanes: plan.lanes,
          dispatchId: id, queued: true, authorization: authorizationReason,
          ...(reviewPending !== undefined ? { reviewPending } : {}),
          ...(plan.reviewEvidencePath ? { reviewEvidencePath: plan.reviewEvidencePath } : {}) },
      };
    },
  };
}
