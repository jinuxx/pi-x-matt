import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeDiagnosticTestFiles, prepareDiagnosticWorkspace, verifyReviewedSnapshot } from "./diagnostic-workspace.mjs";

const exec = promisify(execFile);
const digest = value => createHash("sha256").update(value).digest("hex");
const nonempty = value => typeof value === "string" && value.trim().length > 0;
export const IMPLEMENTATION_ENTRY = "pi-x-matt.implementation";

export function completedImplementation(results) {
  const result = results.find(item => item.key === "implement");
  if (!result?.ok || result.structuredOutput?.status !== "COMPLETE" ||
      ["confirmedSeams", "cycles", "changedFiles", "commands"].some(key =>
        !Array.isArray(result.structuredOutput[key]) || !result.structuredOutput[key].length)) {
    throw new Error("Follow-up requires a completed implementation with structured evidence; do not repeat writer");
  }
  return result;
}

export function retainedWriter(results) {
  const result = completedImplementation(results);
  if (result.agent !== "matt-worker" || !nonempty(result.runId) || result.resumability?.state !== "resumable") {
    throw new Error("Retained writer is unavailable; preserve the failure and stop, never silently launch a fresh writer");
  }
  return result.runId;
}

export function stageResults(status, workflow = "matt-tdd") {
  if (!["complete", "failed"].includes(status?.state)) throw new Error("Previous workflow is not terminal");
  const checkpoint = status.workflow?.emits?.findLast(entry => entry.type === "pi-x-matt.stage-results");
  const results = status.state === "complete" ? status.workflow?.value
    : checkpoint?.version === 1 && checkpoint.workflow === workflow ? checkpoint.results : undefined;
  if (!Array.isArray(results) || new Set(results.map(result => result.key)).size !== results.length) {
    throw new Error("Missing or invalid host workflow results; do not repeat implementation");
  }
  return results;
}

export function blockingFindings(results) {
  const findings = [];
  for (const axis of ["standards", "spec"]) {
    const result = results.find(result => result.key === axis);
    if (!result?.ok || result.structuredOutput?.axis !== axis ||
        !["PASS", "FAIL"].includes(result.structuredOutput.verdict)) {
      throw new Error(`Recover the failed ${axis} review before scheduling any repair`);
    }
    if (result.structuredOutput.verdict === "PASS") continue;
    if (!result.structuredOutput.findings?.length) throw new Error(`${axis} FAIL has no evidenced findings`);
    for (const finding of result.structuredOutput.findings) {
      if (![finding.id, finding.rootCauseId, finding.evidence, finding.expected, finding.actual,
        finding.basis?.reference].every(nonempty) ||
          !["acceptance", "standard", "safety", "integrity"].includes(finding.basis.kind) ||
          !["original", "regression", "independent"].includes(finding.classification) ||
          !finding.locations?.length || !Array.isArray(finding.relatedFindingIds)) {
        throw new Error(`${axis} finding lacks a verifiable basis/path/expected/actual; recover review, not implementation`);
      }
      findings.push({ ...finding, id: `${axis}:${finding.id}`, axis });
    }
  }
  if (new Set(findings.map(finding => finding.id)).size !== findings.length) throw new Error("Duplicate finding identity");
  return findings;
}

/** No prose assertion can erase a recorded repair attempt or an original finding. */
export function prepareRepair(previous, repair, results) {
  if (!repair || repair.previousDispatchId !== previous.id || !Array.isArray(repair.groups) || !repair.groups.length) {
    throw new Error("A repair requires the previous dispatch and grouped root-cause contracts");
  }
  const findings = blockingFindings(results);
  if (!findings.length) throw new Error("No blocking review findings to repair");
  const remaining = new Set(findings.map(finding => finding.id));
  const counts = { ...(previous.repair?.counts ?? {}) };
  const needsDiagnosis = [];
  const groupIds = new Set();
  for (const group of repair.groups) {
    if (!nonempty(group.id) || groupIds.has(group.id) ||
        !nonempty(group.contract) || !nonempty(group.validationOrder) ||
        !group.preserve?.length || !group.callPath?.length || !group.examples?.length ||
        !group.findingIds?.length) throw new Error("Incomplete or duplicate root-cause repair group");
    groupIds.add(group.id);
    let regression = false;
    for (const id of group.findingIds) {
      if (!remaining.delete(id)) throw new Error(`Unknown or repeated approved finding: ${id}`);
      const finding = findings.find(item => item.id === id);
      const priorGroup = previous.repair?.groups?.find(item =>
        item.id === finding.rootCauseId ||
        item.findingIds.some(priorId => finding.relatedFindingIds.includes(priorId) ||
          previous.repair.approvedFindings?.some(prior => prior.id === priorId &&
            prior.rootCauseId === finding.rootCauseId && prior.basis.reference === finding.basis.reference)));
      if (priorGroup && priorGroup.id !== group.id) throw new Error("A recurring root cause cannot be renamed");
      regression ||= finding.classification === "regression";
    }
    if ((counts[group.id] ?? 0) >= 2 || regression) needsDiagnosis.push(group.id);
    counts[group.id] = (counts[group.id] ?? 0) + 1;
  }
  if (remaining.size) throw new Error(`Repair omitted blocking findings: ${[...remaining].join(", ")}`);
  return {
    previousDispatchId: previous.id, previousSnapshotId: previous.snapshotId,
    approvedFindingIds: findings.map(finding => finding.id),
    approvedFindings: findings,
    groups: repair.groups, counts, needsDiagnosis,
  };
}

async function runRedCommand(run, diagnosis, cwd, signal, safeErrors = false) {
  try {
    await run("/bin/sh", ["-c", diagnosis.command], { cwd, signal, timeout: 30_000, maxBuffer: 1024 * 1024 });
  } catch (error) {
    const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    let failure = error;
    if (safeErrors) {
      const reason = signal?.aborted ? "Diagnostic command cancelled"
        : error.killed ? "Diagnostic command timed out or was terminated" : "Diagnostic command failed";
      const outputSha256 = digest(output);
      failure = Object.assign(new Error(`${reason}; outputSha256=${outputSha256}`), {
        code: error.code, killed: error.killed, signal: error.signal, outputSha256,
      });
    }
    if (error.code !== 1 || error.killed || signal?.aborted) throw failure;
    if (!output.includes(diagnosis.expectedFailure)) {
      throw new Error("Diagnosis failed for a different symptom", { cause: failure });
    }
    return output;
  }
  throw new Error("Diagnosis did not reproduce the failure");
}

/** Preserve the command failure as the cause while reporting drift or cleanup failures too. */
function combinedSettlementFailure(failures) {
  if (failures.length === 1) return failures[0];
  const error = new AggregateError(failures, failures.map(failure => failure.message).join("; "));
  error.cause = failures[0];
  return error;
}

/** Only an exact command inside the approved envelope can supply diagnostic evidence. */
export async function diagnoseRepair(contract, diagnosis, scope, cwd, signal, run = exec, options = {}) {
  if (!contract.needsDiagnosis.length) return contract;
  if (!diagnosis || !contract.needsDiagnosis.every(id => diagnosis.rootCauseIds?.includes(id)) ||
      ![diagnosis.explanation, diagnosis.prediction, diagnosis.expectedFailure].every(nonempty) ||
      !scope.diagnosticCommands.includes(diagnosis.command)) {
    throw Object.assign(new Error(
      `DIAGNOSIS_REQUIRED: ${contract.needsDiagnosis.join(", ")}. Stop patch dispatch; minimise the current repro, ` +
      "explain the contract/order/shared call path, and supply an approved red-capable diagnostic command. Do not redesign the module.",
    ), { code: "diagnosis_required" });
  }
  const testFiles = normalizeDiagnosticTestFiles(scope, diagnosis.testFiles);
  if (testFiles) {
    signal?.throwIfAborted();
    const workspace = await prepareDiagnosticWorkspace({
      projectRoot: cwd, packPath: options.reviewedSnapshotPath,
      reviewedSnapshotId: contract.previousSnapshotId, scope, testFiles, tmpRoot: options.tmpRoot,
    });
    const failures = [];
    let output;
    try {
      output = await runRedCommand(run, diagnosis, workspace.cwd, signal, true);
    } catch (error) {
      failures.push(error);
    }
    try {
      const changed = await workspace.assertUntouched();
      if (changed.length) {
        failures.push(new Error(
          `Isolated diagnosis modified files outside diagnosticFiles: ${changed.slice(0, 5).join(", ")}`,
        ));
      }
    } catch (error) {
      failures.push(error);
    }
    try {
      // The original worktree must still equal the reviewed snapshot before the writer can queue.
      await verifyReviewedSnapshot(cwd, contract.previousSnapshotId);
    } catch (error) {
      failures.push(error);
    }
    try {
      await workspace.dispose();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw combinedSettlementFailure(failures);
    signal?.throwIfAborted();
    return { ...contract, diagnosis: {
      rootCauseIds: diagnosis.rootCauseIds, explanation: diagnosis.explanation,
      prediction: diagnosis.prediction, command: diagnosis.command, exitCode: 1,
      outputSha256: digest(output),
      isolation: {
        reviewedDispatchId: options.reviewedDispatchId,
        reviewedSnapshotId: contract.previousSnapshotId,
        scopeSha256: digest(JSON.stringify(scope)),
        // Long-lived evidence and the implement handoff keep path/hash only; the body stays in the owned temp run.
        testFiles: workspace.testFiles,
      },
    } };
  }
  const output = await runRedCommand(run, diagnosis, cwd, signal);
  return { ...contract, diagnosis: {
    rootCauseIds: diagnosis.rootCauseIds, explanation: diagnosis.explanation,
    prediction: diagnosis.prediction, command: diagnosis.command, exitCode: 1,
    outputSha256: digest(output),
  } };
}

export function reviewRecovery(results, keys, attempt = 0) {
  if (attempt >= 1) throw new Error("Review recovery is exhausted; preserve the failure chain and stop");
  const implement = results.find(result => result.key === "implement");
  if (!implement?.ok || implement.structuredOutput?.status !== "COMPLETE") {
    throw new Error("Cannot recover reviewers without a completed implementation");
  }
  if (!Array.isArray(keys) || !keys.length || new Set(keys).size !== keys.length ||
      keys.some(key => !["standards", "spec"].includes(key))) throw new Error("Recovery only accepts failed reviewer lanes");
  for (const key of keys) {
    const result = results.find(result => result.key === key);
    if (result?.recoveryHistory?.length) throw new Error("Settlement already attempted; no additional recovery layer");
    if (result?.ok && ["PASS", "FAIL"].includes(result.structuredOutput?.verdict)) {
      throw new Error(`Review ${key} has a valid verdict; recovery cannot replace it`);
    }
  }
  return { results, keys, attempt: attempt + 1 };
}
