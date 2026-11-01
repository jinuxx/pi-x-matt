import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { BATCH_ENTRY, batchOutcome, confirmBatchPlan, createBatchAuthorization, normalizeBatchPlan, prepareBatchPlan, verifyBatchDispatch } from "./batch-authorization.mjs";
import { admitCommittedReview, assertCommittedReviewFresh, normalizeCommittedReviewScope } from "./committed-review-evidence.mjs";
import { AUTH_ENTRY, authorizeWorkflowDispatch, createDispatchAuthorization, resolveImplementationScope } from "./dispatch-authorization.mjs";
import { buildDispatchRequest, findProjectRoot, loadCurrentRegistry, prepareDispatchRequest } from "./dispatcher-core.mjs";
import { createDispatchTrace, DISPATCH_EVENT, requestRpc, workflowReceipt } from "./dispatch-runtime.mjs";
import { IMPLEMENTATION_ENTRY, completedImplementation, diagnoseRepair, prepareReconsideration, prepareRepair, retainedWriter, reviewRecovery, reviewReportCorrections, stageResults } from "./repair-contract.mjs";
import { collectReviewEvidence } from "./review-evidence.mjs";
import { revalidateReviewReports } from "./review-contract.mjs";
import { confirmRiskAcceptance } from "./risk-acceptance.mjs";
import { prepareCommittedReviewEvidence, prepareTddEvidence, resolveReviewWorkflow } from "./review-workflow.mjs";

const exec = promisify(execFile);
const ACTIVE = new Set(["queued", "rpc-pending", "acceptance-unknown", "running"]);
const digest = value => createHash("sha256").update(value).digest("hex");

const batchPlanView = batch => ({
  spec: batch.spec.path,
  fixedPoint: batch.fixedPoint,
  tickets: batch.tickets.map(ticket => ({
    ticket: ticket.ticket, scope: ticket.scope, allowedFiles: ticket.allowedFiles,
    diagnosticFiles: ticket.diagnosticFiles ?? [], diagnosticCommands: ticket.diagnosticCommands ?? [],
  })),
});

const assertSameBatchPlan = (batch, plan) => {
  const requested = {
    spec: plan.spec, fixedPoint: plan.fixedPoint,
    tickets: plan.tickets.map(ticket => ({
      ticket: ticket.ticket, scope: ticket.scope, allowedFiles: ticket.allowedFiles,
      diagnosticFiles: ticket.diagnosticFiles ?? [], diagnosticCommands: ticket.diagnosticCommands ?? [],
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
  for (const key of ["ticket", "scope", "ticketDigest"]) {
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

export function createImplementationRuntime(pi, packageRoot, {
  rpc = (method, params, options) => requestRpc(pi.events, method, params, options),
  now = Date.now, diagnose = diagnoseRepair,
} = {}) {
  const pending = [];
  const records = new Map();
  const plans = new Map();
  const traces = new Map();
  const traceOffsets = new Map();
  let progressing = false;
  let active = false, epoch = 0, lifecycle = new AbortController();
  let sessionId;
  const authorization = createDispatchAuthorization({ persist: data => {
    if (!active) throw new Error("Dispatch runtime is no longer active");
    pi.appendEntry(AUTH_ENTRY, data);
  }, now });
  const batchAuthorization = createBatchAuthorization({ persist: data => {
    if (!active) throw new Error("Dispatch runtime is no longer active");
    pi.appendEntry(BATCH_ENTRY, data);
  }, now });
  const save = record => {
    if (!active || record.sessionId !== sessionId) throw new Error("Dispatch session changed");
    records.set(record.id, record);
    pi.appendEntry(IMPLEMENTATION_ENTRY, record);
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
  const recordNativeTrace = (record, status) => {
    const trace = status.workflow?.trace ?? [];
    for (let index = traceOffsets.get(record.id) ?? 0; index < trace.length; index++) {
      const row = trace[index];
      if (!["run", "host"].includes(row.operation)) continue;
      traceFor(record.id).record(row.operation === "host" ? (row.key === "implement-claim" ? "admission" : "evidence") :
        row.key?.endsWith("-settlement") ? "settlement" : "execution", row.state, {
        nativeTraceIndex: index, lane: row.key, durationMs: row.durationMs,
        configuredTimeoutMs: row.operation === "host" ? (row.key === "implement-claim" ? 10000 : 120000) :
          row.key?.endsWith("-settlement") ? 300000 : record.laneTimeouts?.[row.key],
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
    if (status.runId !== record.runId) throw new Error("Workflow status identity mismatch");
    recordNativeTrace(record, status);
    const receipt = workflowReceipt(status);
    if (JSON.stringify(receipt) !== JSON.stringify(record.receipt)) {
      if (receipt.settlement && receipt.settlement !== record.receipt?.settlement) pi.sendUserMessage(
        `[pi_matt_dispatch] ${record.id}: implement settlement=${receipt.settlement} (300s maximum when running). ` +
        "Preserve partial changes; do not independently resume or discard the writer. Only a final COMPLETE report permits review; otherwise stop and preserve failure evidence.",
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
      let packHead;
      if (record.evidence?.snapshotPath) {
        try {
          const pack = JSON.parse(await readFile(record.evidence.snapshotPath, "utf8"));
          next.snapshotId = pack.snapshotId;
          packHead = pack.head;
          if (record.workflowName === "matt-code-review" && pack.complete && !record.packDigest) {
            next.packDigest = digest(await readFile(record.evidence.snapshotPath));
            next.markdownDigest = digest(await readFile(record.evidence.path));
          }
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      if (record.batch) {
        const outcome = batchOutcome(status);
        const carried = outcome.candidate ?? record.batchCandidate ?? record.batchOutcome?.candidate ?? null;
        const candidate = carried && carried.snapshotId === next.snapshotId &&
          (!packHead || carried.head === packHead) ? carried : null;
        next.batchOutcome = {
          ...outcome, candidate,
          complete: Boolean(outcome.resultsValid && candidate),
        };
      }
      save(next);
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
      sessionId = ctx.sessionManager.getSessionId();
      pending.splice(0);
      plans.clear();
      records.clear();
      traces.clear();
      traceOffsets.clear();
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
    revoke(reason) {
      authorization.revoke(reason);
      batchAuthorization.revoke(reason);
      for (const dispatch of pending.splice(0)) {
        plans.delete(dispatch.id);
        if (records.has(dispatch.id)) save({ ...records.get(dispatch.id), state: "cancelled" });
        traceFor(dispatch.id).record("queue", "cancelled");
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
      traceFor(record.id).record(String(key).endsWith("-settlement") ? "settlement" : "execution",
        event.status, { lane: key, runId: event.childRunId, at: event.ts ?? now() });
    },
    async flush() {
      const owner = epoch;
      for (const dispatch of pending.splice(0)) {
        const trace = traceFor(dispatch.id);
        let record = records.get(dispatch.id);
        if (record && dispatch.signal?.aborted) authorization.revoke("parent-aborted");
        if (record && (dispatch.signal?.aborted || (record.workflowName !== "matt-code-review" && !authorization.matches(record.identity, record.scope)) ||
            (record.batch && !batchAuthorization.active(record.batch.id)))) {
          plans.delete(dispatch.id);
          save({ ...record, state: "cancelled" });
          trace.record("queue", "cancelled");
          continue;
        }
        if (record) save({ ...record, state: "rpc-pending" });
        try {
          const reply = await trace.step("rpc", () => rpc("spawn", dispatch.rpcParams, { requestId: dispatch.requestId, signal: dispatch.signal }));
          if (!active || owner !== epoch) continue;
          if (record) {
            const details = reply?.details;
            record = { ...record, state: details?.runId && details.asyncDir ? "running" : "acceptance-unknown",
              runId: details?.runId, asyncDir: details?.asyncDir };
            save(record);
          }
        } catch (error) {
          if (!active || owner !== epoch) continue;
          if (record) save({ ...record, state: error.code === "rpc_acceptance_unknown" ? "acceptance-unknown" : "failed" });
          pi.sendUserMessage(`[pi_matt_dispatch] ${dispatch.id}: ${error.message}. No automatic redispatch.`, { deliverAs: "followUp" });
        }
      }
    },
    async dispatch(params, signal, ctx) {
      if (!active) throw new Error("Dispatch runtime is not active");
      signal = AbortSignal.any([lifecycle.signal, ...(signal ? [signal] : [])]);
      signal?.throwIfAborted();
      if (!ctx.isProjectTrusted()) throw new Error("pi-matt-dispatch refuses untrusted project configuration");
      const projectRoot = await findProjectRoot(ctx.cwd);
      const registry = await loadCurrentRegistry(packageRoot);
      const workflow = registry.skills[params.workflow];
      if (!workflow) throw new Error(`Unknown Pi-native workflow '${params.workflow}'`);
      if (params.reviewScope !== undefined && workflow.name !== "matt-code-review") {
        throw new Error("reviewScope only applies to matt-code-review");
      }
      const requiredLanes = params.acceptRisk ? [] : params.repair ? ["implement"] :
        params.review ? ["standards", "spec"] : params.recovery?.lanes ??
        (params.reconsider?.findings ? [...new Set(params.reconsider.findings.map(item => item.findingId?.split(":")[0]))] : undefined);
      const request = prepareDispatchRequest(registry, workflow, params.task, projectRoot, params.laneTasks, requiredLanes);
      const id = randomUUID(), requestId = randomUUID();
      const trace = traceFor(id);
      let authorizationReason = "not-required";
      let plan, rpcParams;
      let reviewPending;
      if (workflow.name === "matt-tdd") {
        if ([params.repair, params.recovery, params.review, params.reconsider, params.acceptRisk].filter(Boolean).length > 1) {
          throw new Error("Repair, review, recovery, reconsideration and risk acceptance are mutually exclusive");
        }
        reviewPending = Boolean(params.repair);
        const identity = await identityFor(projectRoot);
        const scope = await resolveImplementationScope(projectRoot, params.implementation);
        const previousCandidate = [...records.values()].filter(record => record.state !== "cancelled" &&
          record.sessionId === sessionId &&
          record.identity?.projectRoot === identity.projectRoot && record.scope?.ticket === scope.ticket).at(-1);
        let batchPlan;
        if (params.batch !== undefined) batchPlan = normalizeBatchPlan(params.batch);
        let batch = batchAuthorization.current();
        if (batch && (batch.kind !== "batch" || batch.sessionId !== sessionId || batch.expiresAt <= now())) batch = null;
        if (batchPlan) {
          if (batch) assertSameBatchPlan(batch, batchPlan);
          else batch = await trace.step("authorization", async () => {
            const sealed = await prepareBatchPlan(projectRoot, batchPlan, identity);
            trace.record("authorization", "waiting-user");
            return confirmBatchPlan(ctx, sealed, signal, batchAuthorization, { now });
          });
        }
        let batchBinding;
        if (batch?.kind === "batch") {
          const declared = batch.tickets.find(ticket => ticket.ticket === scope.ticket);
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
            batchBinding = { id: batch.invocationId, ticket: scope.ticket, fixedPoint: batch.fixedPoint };
            if (verified.envelopeMatches) {
              const token = authorization.token();
              if (!authorization.matches(identity, scope)) authorization.grant(identity, scope, "batch-plan", token);
              authorizationReason = "batch-plan";
            }
          }
        } else if (previousCandidate?.batch) {
          throw new Error(
            "Batch authorization is revoked or expired; no workflow was queued. " +
            "Re-run the batch entry with one explicit confirmation before continuing.",
          );
        }
        if (authorizationReason === "not-required") {
          authorizationReason = await trace.step("authorization", () =>
            authorizeWorkflowDispatch(workflow.name, signal, ctx, authorization, scope, identity,
              () => trace.record("authorization", "waiting-user")));
        }
        for (let record of records.values()) {
          if (record.identity?.projectRoot !== identity.projectRoot || !ACTIVE.has(record.state)) continue;
          if (!record.asyncDir && record.state !== "queued") record = await correlate(record);
          if (record.asyncDir) await refresh(record);
          if (ACTIVE.has(records.get(record.id).state)) throw new Error(`Dispatch ${record.id} is still active; do not repeat implementation`);
        }
        // Lineage is keyed by the session/project/ticket, never by the authorization invocation:
        // renewal after revoke/expiry or a reapproval must not sever the same repair chain.
        let previous = [...records.values()].filter(record => record.state !== "cancelled" &&
          record.sessionId === sessionId &&
          record.identity?.projectRoot === identity.projectRoot && record.scope?.ticket === scope.ticket).at(-1);
        let repair, recovery, evidence, reviewSourceId, reviewBaseline, reviewedSnapshotId, reviewSnapshotHead;
        let reviewMeta, reconsiderRecord, reviewCandidateSnapshotId, nextRecoveryAttempt;
        const execution = {};
        if (params.repair || params.recovery || params.review || params.reconsider || params.acceptRisk) {
          const reference = params.repair?.previousDispatchId ?? params.recovery?.dispatchId ??
            params.review?.dispatchId ?? params.reconsider?.dispatchId ?? params.acceptRisk?.dispatchId;
          if (!previous || previous.id !== reference) {
            throw new Error("Repair/review/recovery/reconsideration must reference the latest host dispatch for this ticket");
          }
          if (previous.riskAcceptance) throw new Error("This candidate is terminal with accepted risks; preserve its original FAIL and acceptance receipt. Do not reopen the ticket or reuse its acceptance for new changes");
          assertSameLineage(previous, identity, scope);
          const status = await refresh(previous);
          previous = records.get(previous.id);
          let results = stageResults(status);
          if (params.reconsider && previous.reviewPending) {
            throw new Error("Reconsideration requires a completed formal review; review the pending repair first");
          }
          if (params.review && (!previous.reviewPending || status.state !== "complete")) {
            throw new Error("Formal review requires a completed pending repair");
          }
          if (params.repair) {
            if (previous.reviewPending && status.state !== "complete") {
              throw new Error("Previous repair did not complete; preserve the failure and stop");
            }
            execution.resume = retainedWriter(results);
          }
          if (params.recovery && previous.reviewPending) throw new Error("Pending repair needs review, not reviewer recovery");
          const pack = JSON.parse(await readFile(previous.evidence.snapshotPath, "utf8"));
          reviewSnapshotHead = pack.head;
          reviewedSnapshotId = pack.incremental.previousSnapshotId;
          const current = await collectReviewEvidence(projectRoot);
          if (pack.snapshotId !== previous.snapshotId || pack.snapshotId !== current.snapshotId || !pack.complete) {
            throw new Error("Follow-up snapshot is stale or incomplete");
          }
          if (params.acceptRisk) {
            if (previous.reviewPending) throw new Error("Pending repair must receive a formal review before risk acceptance");
            const candidate = previous.batchOutcome?.candidate ?? previous.batchCandidate;
            if (previous.batch && (!candidate || candidate.snapshotId !== pack.snapshotId || candidate.head !== pack.head)) {
              throw new Error("Risk acceptance cannot recover a missing or stale batch candidate proof");
            }
            const riskAcceptance = await confirmRiskAcceptance(params.acceptRisk, results, previous, ctx, signal, now);
            const checkedScope = await resolveImplementationScope(projectRoot, params.implementation);
            if (!authorization.matches(await identityFor(projectRoot), checkedScope) ||
                (previous.batch && !batchAuthorization.active(previous.batch.id)) ||
                (await collectReviewEvidence(projectRoot)).snapshotId !== pack.snapshotId ||
                [...records.values()].filter(record => record.scope?.ticket === scope.ticket &&
                  record.identity?.projectRoot === identity.projectRoot).at(-1)?.id !== previous.id) {
              throw new Error("Candidate, authorization or scope changed while confirming risks; no acceptance was recorded");
            }
            signal?.throwIfAborted();
            const { runId, asyncDir, ...source } = previous;
            save({ ...source, id, requestId, sourceRunId: runId, sourceAsyncDir: asyncDir,
              riskAcceptance, originalResults: results, state: "accepted-risk", at: now(),
              ...(previous.batch ? { batchOutcome: { ...previous.batchOutcome, complete: true, candidate,
                delivery: "accepted-risk", resultsValid: false } } : {}) });
            return {
              content: [{ type: "text", text: `Risk-accepted candidate; original FAIL retained, not dual PASS. acceptanceId=${id}. ` +
                `Only this candidate may be delivered. Record "Risk acceptance: ${id}" with the Implementation commit in local tracker Comments.` }],
              details: { dispatchId: id, state: "accepted-risk", deliveryEligible: true, reviewPassed: false, riskAcceptance },
            };
          }
          const boundary = {
            incremental: Boolean(previous.repair),
            changedPaths: pack.incremental.changes.map(change => change.path),
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
          if (params.reconsider) {
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
            execution.boundary = boundary;
            evidence = previous.evidence;
            repair = previous.repair;
          } else {
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
        } else if (previous) {
          throw new Error("This ticket already has a dispatch; use structured repair/review/recovery, never repeat initial implementation");
        }
        if (!evidence) evidence = await trace.step("evidence", () => prepareTddEvidence(projectRoot, packageRoot, {
          allowedFiles: scope.allowedFiles, ...(repair ?? {}),
          ...(batchBinding ? { batch: { fixedPoint: batchBinding.fixedPoint } } : {}),
          ...(reviewBaseline ? { previousSnapshotId: reviewBaseline.snapshotId } : {}),
        }, reviewBaseline));
        if (params.repair && evidence.snapshotId !== repair.previousSnapshotId) {
          throw new Error("Previous review no longer matches the worktree; do not dispatch a repair");
        }
        // A new writer candidate starts a fresh review budget; review/recovery/reconsideration
        // keep the exact candidate snapshot they were dispatched against.
        if (params.repair || !reviewCandidateSnapshotId) reviewCandidateSnapshotId = evidence.snapshotId;
        if (!reviewMeta || reviewMeta.candidateSnapshotId !== reviewCandidateSnapshotId) {
          reviewMeta = reviewMetaFor(previous, reviewCandidateSnapshotId);
        }
        let batchCandidate;
        if (batchBinding && previous && (params.review || params.recovery || params.reconsider)) {
          const carried = previous.batchOutcome?.candidate ?? previous.batchCandidate;
          if (carried && carried.snapshotId === reviewCandidateSnapshotId && carried.head === reviewSnapshotHead) {
            batchCandidate = carried;
          }
        }
        signal?.throwIfAborted();
        if (!authorization.matches(await identityFor(projectRoot), scope)) throw new Error("Authorization changed while preparing dispatch");
        signal.throwIfAborted();
        if (repair) {
          reviewedSnapshotId = reviewBaseline?.snapshotId ?? reviewedSnapshotId;
          for (const lane of request.lanes) {
            if (lane.key === "implement") {
              lane.task += `\n\nRoot-cause repair contract (only these findings):\n${JSON.stringify(repair)}`;
            }
          }
        }
        for (const lane of request.lanes) {
          if (!["standards", "spec"].includes(lane.key)) continue;
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
        plan = buildDispatchRequest(request, evidence, recovery, execution);
        plans.set(id, plan);
        const { script: _script, ...options } = plan.rpcParams;
        rpcParams = { ...options, workflow: "pi-x-matt.tdd", args: { dispatchId: id } };
        save({ version: 1, sessionId, id, requestId, invocationId: authorization.current().invocationId, identity, scope, evidence, repair,
          ...(batchBinding ? { batch: batchBinding } : {}),
          ...(batchCandidate ? { batchCandidate } : {}),
          reviewPending, ...(reviewSourceId ? { reviewSourceId } : {}),
          laneTimeouts: Object.fromEntries(plan.lanes.map(lane => [lane.key, lane.timeoutMs])),
          reviewMeta, ...(reconsiderRecord ? { reconsider: reconsiderRecord } : {}),
          recoveryAttempt: (params.recovery || params.reconsider)
            ? nextRecoveryAttempt ?? previous?.recoveryAttempt ?? 0 : 0,
          state: "queued", at: now() });
      } else {
        if (params.implementation || params.repair || params.review || params.reconsider ||
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
