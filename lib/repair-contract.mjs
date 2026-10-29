import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const nonempty = value => typeof value === "string" && value.trim().length > 0;
export const IMPLEMENTATION_ENTRY = "pi-x-matt.implementation";

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

/** Only an exact command inside the approved envelope can supply diagnostic evidence. */
export async function diagnoseRepair(contract, diagnosis, scope, cwd, signal, run = exec) {
  if (!contract.needsDiagnosis.length) return contract;
  if (!diagnosis || !contract.needsDiagnosis.every(id => diagnosis.rootCauseIds?.includes(id)) ||
      ![diagnosis.explanation, diagnosis.prediction, diagnosis.expectedFailure].every(nonempty) ||
      !scope.diagnosticCommands.includes(diagnosis.command)) {
    throw Object.assign(new Error(
      `DIAGNOSIS_REQUIRED: ${contract.needsDiagnosis.join(", ")}. Stop patch dispatch; minimise the current repro, ` +
      "explain the contract/order/shared call path, and supply an approved red-capable diagnostic command. Do not redesign the module.",
    ), { code: "diagnosis_required" });
  }
  let output;
  try {
    await run("/bin/sh", ["-c", diagnosis.command], { cwd, signal, timeout: 30_000, maxBuffer: 1024 * 1024 });
    throw new Error("Diagnosis did not reproduce the failure");
  } catch (error) {
    if (error.code !== 1 || error.killed || signal?.aborted) throw error;
    output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    if (!output.includes(diagnosis.expectedFailure)) throw new Error("Diagnosis failed for a different symptom");
  }
  return { ...contract, diagnosis: {
    rootCauseIds: diagnosis.rootCauseIds, explanation: diagnosis.explanation,
    prediction: diagnosis.prediction, command: diagnosis.command, exitCode: 1,
    outputSha256: createHash("sha256").update(output).digest("hex"),
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
