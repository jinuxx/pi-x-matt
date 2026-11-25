import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { admitCommittedReview, normalizeReviewScope } from "./committed-review-evidence.mjs";
import { buildDispatchRequest, findProjectRoot, loadCurrentRegistry, normalizeVerifyCommands, prepareDispatchRequest } from "./dispatcher-core.mjs";
import { createDispatchTrace, DISPATCH_EVENT, requestRpc, workflowReceipt } from "./dispatch-runtime.mjs";
import { prepareCommittedReviewEvidence, prepareTddHostControls, prepareWorktreeReviewEvidence, resolveReviewWorkflow } from "./review-workflow.mjs";

const exec = promisify(execFile);
const ACTIVE = new Set(["queued", "rpc-pending", "acceptance-unknown", "running"]);
const SETTLED = new Set(["complete", "failed", "stopped", "paused"]);
const AUTONOMOUS_ROUND_BUDGET = { "matt-tdd": 2, "matt-code-review": 1 };
export const DISPATCH_RESOURCE = "pi-x-matt.dispatch";

async function readHead(cwd) {
  try {
    const { stdout } = await exec(
      "git",
      ["--no-optional-locks", "-c", "core.fsmonitor=false", "rev-parse", "HEAD"],
      { cwd, timeout: 5000, encoding: "utf8" },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export function createDispatchService(pi, packageRoot, {
  rpc = (method, params, options) => requestRpc(pi.events, method, params, options),
  now = Date.now,
} = {}) {
  const pending = [];
  const records = new Map();
  const plans = new Map();
  const traces = new Map();
  const streaks = new Map();
  let active = false;
  let epoch = 0;
  let lifecycle = new AbortController();
  let ui;

  const traceFor = (id) => {
    if (!traces.has(id)) {
      const owner = epoch;
      traces.set(id, createDispatchTrace({
        id,
        now,
        persist: (event) => { if (active && owner === epoch) pi.appendEntry("pi-x-matt.dispatch-phase", event); },
        emit: (event) => { if (active && owner === epoch) pi.events.emit(DISPATCH_EVENT, event); },
      }));
    }
    return traces.get(id);
  };

  const refresh = async (record) => {
    const owner = epoch;
    if (!record.asyncDir) return null;
    const statusPath = join(record.asyncDir, "status.json");
    const persisted = await readFile(statusPath, "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!persisted) return null;
    const status = JSON.parse(persisted);
    if (!active || owner !== epoch) return status;
    const current = records.get(record.id);
    if (!current || current.state === "cancelled") return status;
    if (SETTLED.has(status.state)) {
      const becameComplete = current.state !== "complete" && status.state === "complete";
      records.set(record.id, { ...current, state: status.state, receipt: workflowReceipt(status) });
      if (becameComplete && current.head && AUTONOMOUS_ROUND_BUDGET[current.workflowName]) {
        const prev = streaks.get(current.projectRoot);
        const entry = prev?.head === current.head
          ? prev
          : { head: current.head, "matt-tdd": 0, "matt-code-review": 0 };
        entry[current.workflowName] += 1;
        streaks.set(current.projectRoot, entry);
      }
    }
    return status;
  };

  const reconcileActiveWriter = async (projectRoot) => {
    for (const record of records.values()) {
      if (!record.isWriter || record.projectRoot !== projectRoot || !ACTIVE.has(record.state)) continue;
      if (record.state === "acceptance-unknown") {
        try {
          const reply = await rpc("status", { id: `rpc-spawn-${record.requestId}` });
          if (reply?.details?.runId && reply.details.asyncDir) {
            records.set(record.id, {
              ...record,
              runId: reply.details.runId,
              asyncDir: reply.details.asyncDir,
              state: "running",
            });
          }
        } catch {
          // Keep current state; user can always clear via /matt-reset.
        }
      }
      const updated = records.get(record.id);
      if (updated?.asyncDir) await refresh(updated);
      const latest = records.get(record.id);
      if (latest && ACTIVE.has(latest.state)) {
        throw new Error(
          `Writer dispatch ${latest.id} is still active (${latest.state}). ` +
          "Wait for it to finish, or run /matt-reset to clear stuck state.",
        );
      }
    }
  };

  const cancelQueued = (reason) => {
    for (const record of records.values()) {
      if (!ACTIVE.has(record.state) || !record.claimPath) continue;
      try {
        writeFileSync(record.claimPath, JSON.stringify({ cancelled: true, reason }), { flag: "wx", mode: 0o400 });
        plans.delete(record.id);
        records.set(record.id, { ...record, state: "cancelled" });
        traceFor(record.id).record("queue", "cancelled", { reason });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    for (const item of pending.splice(0)) {
      plans.delete(item.id);
      if (records.has(item.id)) records.set(item.id, { ...records.get(item.id), state: "cancelled" });
      traceFor(item.id).record("queue", "cancelled", { reason });
    }
  };

  return {
    plans,
    isActive() { return active; },

    start(ctx) {
      lifecycle.abort(new Error("Dispatch session replaced"));
      lifecycle = new AbortController();
      active = true;
      epoch++;
      ui = ctx.hasUI ? ctx.ui : undefined;
      pending.splice(0);
      plans.clear();
      records.clear();
      traces.clear();
      streaks.clear();
    },

    shutdown() {
      active = false;
      epoch++;
      lifecycle.abort(new Error("Dispatch runtime shutdown"));
      plans.clear();
      pending.splice(0);
      streaks.clear();
    },

    /** Reset autonomous round streak whenever the user speaks directly in chat. */
    noteUserInput() {
      streaks.clear();
    },

    /** Clear any stuck active records and queued dispatches without forcing a session restart. */
    reset(reason = "user-reset") {
      cancelQueued(reason);
      streaks.clear();
      for (const [id, record] of records.entries()) {
        if (ACTIVE.has(record.state)) {
          plans.delete(id);
          records.set(id, { ...record, state: "cancelled" });
        }
      }
    },

    resolve(args) { return resolveReviewWorkflow(plans, args); },

    async completion(event) {
      const owner = epoch;
      const record = [...records.values()].find((item) => item.runId === (event.parentWorkflowRunId ?? event.runId));
      if (!record) return;
      const status = await refresh(record);
      if (!active || owner !== epoch || event.awaitedByWorkflow || event.runId !== record.runId) return;
      if (status && SETTLED.has(status.state)) {
        traceFor(record.id).record("workflow", status.state, { runId: record.runId });
      }
    },

    childStatus(event) {
      const record = [...records.values()].find((item) => item.runId === event.runId);
      if (!record) return;
      const key = event.workflowKey ?? event.childId;
      const at = event.ts ?? now();
      const trace = traceFor(record.id);
      if (trace.events.some((item) =>
        item.phase === "execution" &&
        item.state === event.status &&
        item.lane === key &&
        item.runId === event.childRunId &&
        item.at === at,
      )) {
        return;
      }
      trace.record("execution", event.status, { lane: key, runId: event.childRunId, at });
    },

    async flush() {
      const owner = epoch;
      for (const item of pending.splice(0)) {
        const record = records.get(item.id);
        const trace = traceFor(item.id);
        if (!record || record.state === "cancelled" || item.signal?.aborted) {
          plans.delete(item.id);
          if (record) records.set(item.id, { ...record, state: "cancelled" });
          trace.record("queue", "cancelled");
          continue;
        }
        records.set(item.id, { ...record, state: "rpc-pending" });
        try {
          const reply = await trace.step("rpc", () =>
            rpc("spawn", item.rpcParams, { requestId: item.requestId, signal: item.signal }));
          if (!active || owner !== epoch || records.get(item.id)?.state === "cancelled") continue;
          const details = reply?.details;
          records.set(item.id, {
            ...records.get(item.id),
            state: details?.runId && details.asyncDir ? "running" : "acceptance-unknown",
            runId: details?.runId,
            asyncDir: details?.asyncDir,
          });
        } catch (error) {
          if (!active || owner !== epoch) continue;
          records.set(item.id, {
            ...records.get(item.id),
            state: error.code === "rpc_acceptance_unknown" ? "acceptance-unknown" : "failed",
          });
          pi.sendUserMessage(`[pi_matt_dispatch] ${item.id}: ${error.message}`, { deliverAs: "followUp" });
        }
      }
    },

    async dispatch(params, signal, ctx) {
      if (!active) throw new Error("Dispatch runtime is not active");
      if (!ctx.isProjectTrusted()) throw new Error("pi-matt-dispatch refuses untrusted project configuration");
      signal = AbortSignal.any([lifecycle.signal, ...(signal ? [signal] : [])]);
      signal.throwIfAborted();

      const projectRoot = await realpath(await findProjectRoot(ctx.cwd));
      const registry = await loadCurrentRegistry(packageRoot);
      const workflow = registry.skills[params.workflow];
      if (!workflow) throw new Error(`Unknown Pi-native workflow '${params.workflow}'`);

      if (params.resumeRunId !== undefined) {
        if (workflow.name !== "matt-tdd") throw new Error("resumeRunId only applies to matt-tdd");
        if (typeof params.resumeRunId !== "string" || !params.resumeRunId.trim()) {
          throw new Error("resumeRunId must be a non-empty string");
        }
      }
      const resumeRunId = params.resumeRunId?.trim();
      if (params.verifyCommands !== undefined && workflow.name !== "matt-tdd") {
        throw new Error("verifyCommands only applies to matt-tdd");
      }
      if (params.reviewScope !== undefined && workflow.name !== "matt-code-review") {
        throw new Error("reviewScope only applies to matt-code-review");
      }

      const verifyCommands = normalizeVerifyCommands(params.verifyCommands);
      const reviewScope = params.reviewScope !== undefined ? normalizeReviewScope(params.reviewScope) : undefined;
      const request = prepareDispatchRequest(registry, workflow, params.task, projectRoot, {
        laneTasks: params.laneTasks,
        lanes: params.lanes,
      });

      const isWriter = request.lanes.some((lane) => lane.agent === "matt-worker");
      const id = randomUUID();
      const requestId = randomUUID();
      const trace = traceFor(id);

      if (isWriter) await reconcileActiveWriter(projectRoot);

      const budget = AUTONOMOUS_ROUND_BUDGET[workflow.name];
      const head = budget ? await readHead(projectRoot) : null;
      if (head && budget) {
        const currentStreak = streaks.get(projectRoot);
        if (currentStreak && currentStreak.head !== head) streaks.delete(projectRoot);
        const completed = streaks.get(projectRoot)?.[workflow.name] ?? 0;
        if (completed >= budget) {
          return {
            content: [{
              type: "text",
              text:
                `Autonomous round budget reached on HEAD ${head.slice(0, 8)} ` +
                `(${completed} completed '${workflow.name}' run(s) since the last commit or user message). ` +
                "Do not dispatch again in this turn: summarize current progress and remaining items in plain Chinese " +
                "(trigger, worst-case impact, and rough effort), and ask the user whether to commit now or continue. " +
                "Any user reply or a new commit automatically resets this budget.",
            }],
            details: {
              workflow: workflow.name,
              paused: true,
              reason: "autonomous-round-budget",
              head,
              completedRounds: completed,
              budget,
            },
          };
        }
      }

      let hostControls;
      if (workflow.name === "matt-tdd") {
        hostControls = await prepareTddHostControls(packageRoot, verifyCommands);
      } else if (reviewScope?.kind === "worktree") {
        const evidence = await prepareWorktreeReviewEvidence(packageRoot);
        hostControls = { evidenceKind: "worktree", evidenceCommand: evidence.command, evidencePath: evidence.path };
      } else if (reviewScope?.kind === "committed") {
        const control = await admitCommittedReview(projectRoot, reviewScope.fixedPoint);
        const evidence = await prepareCommittedReviewEvidence(projectRoot, packageRoot, control);
        hostControls = { evidenceKind: "committed", evidenceCommand: evidence.command, evidencePath: evidence.path };
      }

      signal.throwIfAborted();
      if (isWriter) {
        const busy = [...records.values()].find((r) => r.isWriter && r.projectRoot === projectRoot && ACTIVE.has(r.state));
        if (busy) {
          throw new Error(
            `Writer dispatch ${busy.id} is still active (${busy.state}). ` +
            "Wait for it to finish, or run /matt-reset to clear stuck state.",
          );
        }
      }
      const plan = buildDispatchRequest(request, { resumeRunId, hostControls });

      let rpcParams = plan.rpcParams;
      if (plan.hostCommands.length > 0) {
        plans.set(id, plan);
        const { script: _script, ...options } = plan.rpcParams;
        rpcParams = { ...options, workflow: DISPATCH_RESOURCE, args: { dispatchId: id } };
      }

      records.set(id, {
        id,
        requestId,
        workflowName: workflow.name,
        projectRoot,
        ...(head ? { head } : {}),
        isWriter,
        ...(hostControls?.claimPath ? { claimPath: hostControls.claimPath } : {}),
        state: "queued",
        at: now(),
      });
      pending.push({ id, requestId, rpcParams, signal });
      trace.record("queue", "queued");

      if (ui && verifyCommands.length > 0) {
        ui.notify(`[pi_matt_dispatch] Queued ${workflow.name} (${verifyCommands.length} verify command(s)).`, "info");
      }

      return {
        content: [{
          type: "text",
          text: `Queued '${workflow.name}' (dispatchId=${id}). It will launch after this turn; wait for completion.`,
        }],
        details: {
          workflow: workflow.name,
          mode: workflow.workflow.mode,
          lanes: plan.lanes,
          dispatchId: id,
          queued: true,
          ...(plan.reviewEvidencePath ? { reviewEvidencePath: plan.reviewEvidencePath } : {}),
        },
      };
    },
  };
}
