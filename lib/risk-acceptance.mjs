import { AUTH_WAIT_MS } from "./dispatch-authorization.mjs";
import { withDeadline } from "./dispatch-runtime.mjs";
import { blockingFindings, completedImplementation } from "./repair-contract.mjs";

/** A risk acceptance is a separate delivery decision, never a rewritten review verdict. */
export async function confirmRiskAcceptance(request, results, record, ctx, signal, now = Date.now) {
  if (record.workflowName !== "matt-code-review") completedImplementation(results);
  const findings = blockingFindings(results);
  if (!findings.length || findings.some(finding =>
    finding.axis !== "standards" || finding.severity !== "P2" || finding.basis.kind !== "standard")) {
    throw new Error("Risk acceptance only covers remaining ordinary standards P2 findings; never acceptance, safety, integrity, P0/P1 or missing reviews");
  }
  if (!Array.isArray(request.findingIds) || new Set(request.findingIds).size !== request.findingIds.length ||
      findings.length !== request.findingIds.length ||
      findings.some(finding => !request.findingIds.includes(finding.id)) ||
      ![request.reason, request.evidence].every(value => typeof value === "string" && value.trim())) {
    throw new Error(`Risk acceptance must name every exact remaining finding once (${findings.map(finding => finding.id).join(", ")}), with reason and evidence`);
  }
  if (!ctx.hasUI) throw new Error("Risk acceptance requires a fresh real user confirmation; task prose, implementation and batch grants are insufficient");
  const confirmed = await withDeadline(dialogSignal => ctx.ui.confirm(
    "Accept this candidate's known P2 risks?",
    `Scope: ${record.scope?.ticket ?? `${record.evidence.fixedPoint}..${record.evidence.head}`}\nCandidate: ${record.snapshotId}\n` +
    findings.map(finding => `${finding.id}: ${finding.title}\n${finding.basis.kind}: ${finding.basis.reference}\n${finding.locations.join(", ")}\n` +
      `Expected: ${finding.expected}\nActual: ${finding.actual}\nEvidence: ${finding.evidence}`).join("\n\n") +
    `\n\nReason: ${request.reason}\nEvidence for acceptance: ${request.evidence}\n` +
    "Approve delivery of ONLY this exact candidate with these known risks? Original FAIL remains. No future candidate or other issue is waived.",
    { signal: dialogSignal, timeout: AUTH_WAIT_MS },
  ), { timeoutMs: AUTH_WAIT_MS, signal });
  signal?.throwIfAborted();
  if (!confirmed) throw new Error("Risk acceptance was not approved; original FAIL remains blocking");
  return {
    version: 1, source: "user-confirmed", sourceDispatchId: record.id, candidateSnapshotId: record.snapshotId,
    findingIds: findings.map(finding => finding.id), findings,
    reason: request.reason.trim(), evidence: request.evidence.trim(), confirmedAt: now(),
  };
}
