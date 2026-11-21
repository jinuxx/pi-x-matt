import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { withValidationCheckout } from "./diagnostic-workspace.mjs";
import { AUTH_WAIT_MS } from "./dispatch-authorization.mjs";
import { withDeadline } from "./dispatch-runtime.mjs";

export const FINAL_REPAIR_LIMIT = 2;
const COMMAND_TIMEOUT_MS = 300_000;

export const finalValidationChecks = active => [...(active.priorChecks ?? []), active];

/** Legacy single-check receipts from v0.2.44 remain valid for their original snapshot. */
export function hasFinalValidationPass(record) {
  const { finalValidation: active, finalValidationPass: pass, snapshotId, batchOutcome } = record;
  if (record.state !== "complete" || !pass || pass.sourceId !== active.sourceId ||
      pass.snapshotId !== snapshotId || batchOutcome.candidate.tree === active.tree) return false;
  const checks = finalValidationChecks(active);
  const results = pass.results ?? [{ sourceId: pass.sourceId, exitCode: pass.result?.exitCode }];
  return results.length === checks.length && checks.every((check, index) =>
    results[index].sourceId === check.sourceId && results[index].exitCode === 0);
}

const nonempty = (value, max) => typeof value === "string" && value.trim() &&
  !/[\0\r\n]/.test(value) && Buffer.byteLength(value) <= max;

export function validateFinalRepairRequest(request) {
  if (!request || Object.keys(request).some(key => !["dispatchId", "command", "expectedFailure"].includes(key)) ||
      !nonempty(request.dispatchId, 128) ||
      ((request.command !== undefined || request.expectedFailure !== undefined) &&
        !(nonempty(request.command, 300) && nonempty(request.expectedFailure, 300)))) {
    throw new Error("finalValidationRepair requires a dispatchId and, on first use, one exact command and literal failure text");
  }
}

export async function confirmFinalValidation(ctx, ticket, snapshotId, { command, expectedFailure }, signal) {
  if (!ctx.hasUI) throw new Error("Final validation command requires explicit user confirmation");
  const approved = await withDeadline(dialogSignal => ctx.ui.confirm(
    "Verify and repair a final validation regression?",
    `Ticket: ${ticket}\nReviewed snapshot: ${snapshotId}\nExact command: ${command}\n` +
    `Expected failure: ${expectedFailure}\n\n` +
    "Approve running this deterministic, read-only local command in disposable checkouts (not a sandbox), " +
    "and reusing it on this ticket's repaired candidates? No new writer or file permissions are granted.",
    { signal: dialogSignal, timeout: AUTH_WAIT_MS },
  ), { timeoutMs: AUTH_WAIT_MS, signal });
  if (!approved) throw new Error("Final validation command confirmation was declined");
}

function runCheck(cwd, { command, expectedFailure }, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const hash = createHash("sha256");
    let matched = false, timedOut = false, spawnError;
    for (const stream of [child.stdout, child.stderr]) {
      let tail = "";
      stream.setEncoding("utf8");
      stream.on("data", chunk => {
        hash.update(chunk);
        if (expectedFailure === undefined) return;
        const text = tail + chunk;
        matched ||= text.includes(expectedFailure);
        tail = text.slice(-expectedFailure.length);
      });
    }
    const stop = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
        if (error.code !== "ESRCH") child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, COMMAND_TIMEOUT_MS);
    signal.addEventListener("abort", stop, { once: true });
    child.once("error", error => { spawnError = error; });
    child.once("close", (exitCode, termination) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      const outputSha256 = hash.digest("hex");
      if (signal.aborted) return reject(signal.reason);
      if (spawnError || timedOut || termination || ![0, 1].includes(exitCode)) {
        return reject(new Error(`Final validation could not complete normally (exit=${exitCode ?? termination ?? "unknown"}, ` +
          `timeout=${timedOut}); outputSha256=${outputSha256}`, { cause: spawnError }));
      }
      resolve({ exitCode, matched, outputSha256 });
    });
  });
}

export async function measureFinalValidation(projectRoot, candidate, recipe, signal, { compareBaseline = false } = {}) {
  return withValidationCheckout(projectRoot, candidate, async checkout => {
    const check = cwd => runCheck(cwd, recipe, signal);
    const baseline = compareBaseline ? await checkout.baseline(check) : undefined;
    if (baseline && baseline.exitCode !== 0) {
      throw new Error(`Final validation does not pass on the ticket's clean parent; outputSha256=${baseline.outputSha256}`);
    }
    const result = await checkout.candidate(check);
    return { ...(baseline ? { baseline } : {}), result };
  });
}

export async function runFinalValidationChecks(projectRoot, candidate, checks, signal) {
  return withValidationCheckout(projectRoot, candidate, async checkout => {
    const results = [];
    for (const check of checks) {
      const result = { sourceId: check.sourceId, ...await checkout.candidate(cwd => runCheck(cwd, check, signal)) };
      results.push(result);
      if (result.exitCode !== 0) break;
    }
    return results;
  });
}

export const recheckFinalValidation = (projectRoot, candidate, active, signal) =>
  runFinalValidationChecks(projectRoot, candidate, finalValidationChecks(active), signal);
