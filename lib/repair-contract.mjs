import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeDiagnosticTestFiles, prepareDiagnosticWorkspace, verifyReviewedSnapshot } from "./diagnostic-workspace.mjs";
import { canonicalFindingId } from "./review-contract.mjs";

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
      throw new Error(`Recover the failed ${axis} review before scheduling repair, reconsideration or report correction`);
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
      const id = canonicalFindingId(axis, finding.id);
      if (!id) throw new Error(`${axis} finding has an invalid or different-axis identity`);
      findings.push({ ...finding, id, axis, relatedFindingIds: finding.relatedFindingIds.map(reference =>
        canonicalFindingId(reference.split(":")[0], reference)) });
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
    for (const suppliedId of group.findingIds) {
      const id = canonicalFindingId(typeof suppliedId === "string" ? suppliedId.split(":")[0] : null, suppliedId);
      if (!remaining.delete(id)) {
        throw new Error(`Unknown or repeated approved finding: ${suppliedId}; ` +
          `effective remaining axis-prefixed IDs: ${findings.map(item => item.id).join(", ")}`);
      }
      const finding = findings.find(item => item.id === id);
      const priorGroup = previous.repair?.groups?.find(item =>
        item.id === finding.rootCauseId ||
        item.findingIds.some(priorId => finding.relatedFindingIds.includes(
          canonicalFindingId(priorId.split(":")[0], priorId)) ||
          previous.repair.approvedFindings?.some(prior => prior.id === priorId &&
            prior.rootCauseId === finding.rootCauseId && prior.basis.reference === finding.basis.reference)));
      if (priorGroup && priorGroup.id !== group.id) {
        throw new Error("A recurring root cause cannot be renamed; keep the prior group id or stop for a new decision");
      }
      regression ||= finding.classification === "regression";
    }
    if ((counts[group.id] ?? 0) >= 2 || regression) needsDiagnosis.push(group.id);
    counts[group.id] = (counts[group.id] ?? 0) + 1;
  }
  if (remaining.size) {
    throw new Error(`Repair omitted blocking findings: ${[...remaining].join(", ")}; ` +
      "include every effective remaining finding or challenge a disputed valid finding with reconsideration");
  }
  return {
    previousDispatchId: previous.id, previousSnapshotId: previous.snapshotId,
    approvedFindingIds: findings.map(finding => finding.id),
    approvedFindings: findings,
    groups: repair.groups.map(group => ({ ...group, findingIds: group.findingIds.map(id =>
      canonicalFindingId(id.split(":")[0], id)) })), counts, needsDiagnosis,
  };
}

function failureReason(error, signal) {
  if (signal?.aborted) return "Diagnostic command cancelled";
  if (error.killed) return "Diagnostic command timed out or was terminated";
  if (error.code === 127) {
    return "Diagnostic command could not start (exit 127: command or interpreter not found); " +
      "verify the approved command's absolute interpreter path and its dependencies";
  }
  if (error.code === 126) {
    return "Diagnostic command could not start (exit 126: command not executable); " +
      "verify the approved command's executable path and permissions";
  }
  return `Diagnostic command failed (exit ${error.code ?? "unknown"}); verify the approved command's ` +
    "parameters, exit semantics and local environment";
}

/** Keep exit state and an output digest; never persist the raw subprocess output. */
async function runRedCommand(run, diagnosis, cwd, signal) {
  let output;
  try {
    const result = await run("/bin/sh", ["-c", diagnosis.command],
      { cwd, signal, timeout: 30_000, maxBuffer: 1024 * 1024 });
    output = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
  } catch (error) {
    output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    const outputSha256 = digest(output);
    const failure = Object.assign(new Error(`${failureReason(error, signal)}; outputSha256=${outputSha256}`), {
      code: error.code, killed: error.killed, signal: error.signal,
      ...(error.cause ? { cause: error.cause } : {}), outputSha256,
    });
    if (error.code !== 1 || error.killed || signal?.aborted) throw failure;
    if (!output.includes(diagnosis.expectedFailure)) {
      throw new Error(
        "Diagnosis failed for a different symptom (exit 1); the approved command ran but did not print " +
        `the expected failure text; verify its interpreter path and dependencies; outputSha256=${outputSha256}`,
        { cause: failure },
      );
    }
    return output;
  }
  const outputSha256 = digest(output);
  throw Object.assign(new Error(
    "Diagnosis did not reproduce the failure (exit 0); the approved command must exit 1 and print " +
    `the expected failure text; outputSha256=${outputSha256}`,
  ), { code: 0, outputSha256 });
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
      output = await runRedCommand(run, diagnosis, workspace.cwd, signal);
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
  if (attempt >= 1) {
    throw new Error("Review execution recovery is exhausted; preserve the failure chain and stop. " +
      "Challenge a disputed valid FAIL with reconsideration");
  }
  const implement = results.find(result => result.key === "implement");
  if (!implement?.ok || implement.structuredOutput?.status !== "COMPLETE") {
    throw new Error("Cannot recover reviewers without a completed implementation");
  }
  if (!Array.isArray(keys) || !keys.length || new Set(keys).size !== keys.length ||
      keys.some(key => !["standards", "spec"].includes(key))) throw new Error("Recovery only accepts failed reviewer lanes");
  for (const key of keys) {
    const result = results.find(result => result.key === key);
    if (result?.contractError) {
      throw new Error(`Review ${key} has a report contract error; use report correction instead of execution recovery`);
    }
    if (result?.recoveryHistory?.length) throw new Error("Settlement already attempted; no additional recovery layer");
    if (result?.ok && ["PASS", "FAIL"].includes(result.structuredOutput?.verdict)) {
      throw new Error(`Review ${key} has a valid verdict; execution recovery cannot replace it. Challenge a disputed FAIL with reconsideration`);
    }
  }
  return { results, keys, attempt: attempt + 1 };
}

/** Reviewer reports, unlike execution failures, have their own bounded correction budget. */
export function reviewReportCorrections(results, keys, counts = {}) {
  if (!Array.isArray(keys) || !keys.length || new Set(keys).size !== keys.length ||
      keys.some(key => !["standards", "spec"].includes(key))) {
    throw new Error("Report correction only accepts failed reviewer lanes");
  }
  const next = { ...counts };
  for (const key of keys) {
    const result = results.find(item => item.key === key);
    if (!result?.contractError) {
      if (result?.ok && ["PASS", "FAIL"].includes(result.structuredOutput?.verdict)) {
        throw new Error(`Review ${key} has a valid verdict; a disputed FAIL uses reconsideration, not correction`);
      }
      throw new Error(`Review ${key} has no report contract error; use execution recovery for a failed reviewer run`);
    }
    if ((next[key] ?? 0) >= 2) {
      throw new Error(`Review report correction for ${key} is exhausted for this candidate snapshot (2/2); ` +
        "preserve the report and stop. After a host contract fix, retry this recovery for retained-report revalidation; " +
        "never reset the budget or reopen initial implementation");
    }
    next[key] = (next[key] ?? 0) + 1;
  }
  return { results, keys, counts: next };
}

/** A parent challenge never erases a finding: a fresh reviewer must decide each valid target. */
export function prepareReconsideration(request, results, counts = {}) {
  if (!request || !Array.isArray(request.findings) || !request.findings.length) {
    throw new Error("Reconsideration requires one or more challenged blocking findings");
  }
  const findings = blockingFindings(results);
  const targets = [];
  const seen = new Set();
  for (const challenge of request.findings) {
    if (!nonempty(challenge?.findingId)) {
      throw new Error("Reconsideration finding IDs must be non-empty, duplicate-free and unique");
    }
    if (!nonempty(challenge.reason) || !nonempty(challenge.evidence)) {
      throw new Error(`Reconsideration target ${challenge.findingId} requires a non-empty reason and evidence`);
    }
    const canonicalId = canonicalFindingId(challenge.findingId.split(":")[0], challenge.findingId);
    if (seen.has(canonicalId)) throw new Error("Reconsideration finding IDs must be duplicate-free and unique");
    seen.add(canonicalId);
    const finding = findings.find(item => item.id === canonicalId);
    if (!finding) {
      throw new Error(`Unknown or non-blocking reconsideration target '${challenge.findingId}'; ` +
        `challenge only current valid blocking findings (${findings.map(item => item.id).join(", ")})`);
    }
    targets.push({ ...finding, reason: challenge.reason, challengeEvidence: challenge.evidence });
  }
  const axes = [...new Set(targets.map(target => target.axis))];
  const next = { ...counts };
  for (const axis of axes) {
    if ((next[axis] ?? 0) >= 1) {
      throw new Error(`Review reconsideration for ${axis} is exhausted for this candidate snapshot (1/1); ` +
        "repair the effective remaining findings or stop");
    }
    next[axis] = (next[axis] ?? 0) + 1;
  }
  return { targets, axes, counts: next };
}
