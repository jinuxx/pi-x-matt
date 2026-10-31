/** Canonical public identity; also accepts legacy repeated prefixes from retained reports. */
export function canonicalFindingId(axis, id) {
  if (!["standards", "spec"].includes(axis) || typeof id !== "string" || !id.trim()) return null;
  while (id.startsWith(`${axis}:`)) id = id.slice(axis.length + 1);
  if (!id.trim() || /^(standards|spec):/.test(id)) return null;
  return `${axis}:${id}`;
}

/** Self-contained so standalone and TDD results receive the same actionable hint. */
export function withSpecEvidenceHint(result) {
  if (result?.structuredOutput?.axis !== "spec" || result.structuredOutput.verdict !== "NO_EVIDENCE") return result;
  const hint = "Supply verifiable acceptance sources in laneTasks.spec: for a whole-spec review, include the complete " +
    "active parent spec and its aggregate acceptance matrix, or an explicitly readable source. " +
    "A committed Git Evidence Pack does not contain ignored tracker specifications. Do not invent missing criteria.";
  const notes = result.structuredOutput.notes ?? [];
  return { ...result, structuredOutput: { ...result.structuredOutput, notes: [...new Set([...notes, hint])] } };
}

/** Embedded with canonicalFindingId and withSpecEvidenceHint and a host-collected boundary. */
export function validateReviewResult(result, boundary) {
  const output = result.structuredOutput;
  if (!result.ok || !output) {
    const rejected = result.structuredOutputFailed === true ||
      result.results?.some(row => row.structuredOutputFailed === true);
    if (!rejected || result.contractError) return result;
    return { ...result, ok: false,
      contractError: { kind: "structured-output", message: "Runtime rejected the structured review report" },
      error: `${result.error ?? "Structured review output rejected"}; correct this axis report`,
    };
  }
  let problem;
  const ids = new Set();
  const approved = boundary.approvedFindingIds.map(id => canonicalFindingId(id.split(":")[0], id));
  const normalized = [];
  if (!Array.isArray(output.findings) ||
      (output.verdict === "FAIL" && !output.findings.length) ||
      (output.verdict !== "FAIL" && output.findings.length)) problem = "verdict/findings mismatch";
  for (const finding of output.findings ?? []) {
    const identity = canonicalFindingId(output.axis, finding.id);
    if (!identity) {
      problem = "invalid or different-axis finding identity";
      break;
    }
    if (ids.has(identity)) {
      problem = "duplicate finding identity";
      break;
    }
    ids.add(identity);
    const strings = [finding.id, finding.rootCauseId, finding.evidence, finding.expected, finding.actual, finding.basis?.reference];
    if (strings.some(value => typeof value !== "string" || !value.trim()) || !finding.locations?.length ||
        !Array.isArray(finding.relatedFindingIds) || !Array.isArray(finding.affectedBy)) {
      problem = "finding lacks verifiable basis, code path or expected/actual behavior";
      break;
    }
    if ((output.axis === "spec" && finding.basis.kind !== "acceptance") ||
        (output.axis === "standards" && !["standard", "safety", "integrity"].includes(finding.basis.kind))) {
      problem = "finding cites a basis outside this review axis";
      break;
    }
    const relatedIds = finding.relatedFindingIds.map(id =>
      canonicalFindingId(typeof id === "string" ? id.split(":")[0] : null, id));
    const related = relatedIds.some(id => approved.includes(id));
    const crossAxis = relatedIds.some(id => id && !id.startsWith(`${output.axis}:`));
    if (relatedIds.some(id => !id || !approved.includes(id)) ||
        (crossAxis && finding.classification !== "regression")) {
      problem = "finding references an unknown or different-axis predecessor; cross-axis links require regression";
      break;
    }
    if (boundary.approvedFindingIds.length && ["original", "regression"].includes(finding.classification) && !related) {
      problem = "recurring finding has no approved predecessor";
      break;
    }
    const changed = finding.locations.some(location => boundary.changedPaths.includes(location) ||
      boundary.changedPaths.includes(location.replace(/:\d+(?:-\d+|:\d+)?$/, "")));
    const dependency = finding.affectedBy.some(path => boundary.changedPaths.includes(path));
    const safety = ["safety", "integrity"].includes(finding.basis.kind);
    if (crossAxis && !changed && !dependency) {
      problem = "cross-axis regression lacks an evidenced changed path or dependency impact";
      break;
    }
    if (boundary.incremental && !changed && !dependency && !related && !safety) {
      problem = "unchanged reviewed content has no evidenced dependency impact; " +
        `locations=${JSON.stringify(finding.locations.slice(0, 5))}; changedPaths=${JSON.stringify(boundary.changedPaths.slice(0, 5))}`;
      break;
    }
    normalized.push({ ...finding, id: identity.slice(output.axis.length + 1), relatedFindingIds: relatedIds });
  }
  // An invalid report is recoverable review failure, never authorization to patch or an automatic PASS.
  return problem ? {
    ...result, ok: false,
    contractError: { kind: "review-evidence", message: problem },
    error: `Review evidence contract invalid: ${problem}; use the axis report correction path`,
  } : withSpecEvidenceHint({ ...result, structuredOutput: { ...output, findings: normalized } });
}

/** Recheck an old host-rejected report, never waive a schema or execute a reviewer. */
export function revalidateReviewReports(results, keys, boundary, candidateSnapshotId) {
  const revalidatedKeys = [];
  const checked = results.map(result => {
    if (!keys.includes(result.key) || result.contractError?.kind !== "review-evidence" || !result.structuredOutput ||
        result.structuredOutputFailed === true || result.results?.some(row => row.structuredOutputFailed === true)) return result;
    const { contractError, error, ...candidate } = result;
    const valid = validateReviewResult({ ...candidate, ok: true }, boundary);
    if (!valid.ok) return result;
    revalidatedKeys.push(result.key);
    return { ...valid, revalidationHistory: [...(result.revalidationHistory ?? []), {
      candidateSnapshotId, original: result,
    }] };
  });
  return { results: checked, keys: revalidatedKeys };
}

/** Embedded with canonicalFindingId: decide only the challenged findings. */
export function adjudicateReviewDecisions(result, original, targets, history, context) {
  if (!result?.ok || !result.structuredOutput) {
    const rejected = result?.structuredOutputFailed === true ||
      result?.results?.some(row => row.structuredOutputFailed === true);
    if (!rejected || result.contractError) return result;
    return { ...result, ok: false,
      contractError: { kind: "structured-output", message: "Runtime rejected the structured decision report" },
      error: `${result.error ?? "Structured decision output rejected"}; correct this axis report with the same targets`,
    };
  }
  history = Array.isArray(history) ? history : [];
  context = context ?? {};
  const output = result.structuredOutput;
  const axis = original?.structuredOutput?.axis;
  const decisions = output.decisions;
  let problem;
  if (!axis || !Array.isArray(original.structuredOutput.findings) || !targets.length) {
    problem = "missing original report or challenged findings";
  } else if (output.axis !== axis) {
    problem = "decision report cites a different review axis";
  } else if (!Array.isArray(decisions) || decisions.length !== targets.length) {
    problem = "decision report must decide exactly each challenged finding";
  } else {
    const targetIds = new Set(targets.map(target => canonicalFindingId(axis, target.id)));
    const seen = new Set();
    for (const decision of decisions) {
      const id = canonicalFindingId(axis, decision?.findingId);
      if (!id || !targetIds.has(id) || seen.has(id)) {
        problem = "decision report contains an unknown, repeated or different-axis finding";
        break;
      }
      if (!decision.findingId.startsWith(`${axis}:`)) {
        problem = "decision report contains a different-axis finding";
        break;
      }
      seen.add(id);
      if (!["uphold", "withdraw"].includes(decision.decision) ||
          typeof decision.justification !== "string" || !decision.justification.trim() ||
          typeof decision.evidence !== "string" || !decision.evidence.trim()) {
        problem = "each decision requires uphold|withdraw plus non-empty justification and evidence";
        break;
      }
    }
    if (!problem && seen.size !== targetIds.size) problem = "decision report omitted a challenged finding";
  }
  const base = {
    ...result,
    reconsiderationHistory: [...history, {
      ...context, original: original?.structuredOutput, decisions: output,
      ...(problem ? { decisionError: problem } : {}),
    }],
  };
  if (problem) {
    return {
      ...base, ok: false,
      contractError: { kind: "reconsideration", message: problem },
      error: `Review reconsideration contract invalid: ${problem}; correct this axis report with the same targets`,
    };
  }
  const byId = new Map(decisions.map(decision => [
    canonicalFindingId(axis, decision.findingId), decision.decision,
  ]));
  const findings = original.structuredOutput.findings.filter(finding =>
    byId.get(canonicalFindingId(axis, finding.id)) !== "withdraw");
  const verdict = findings.length ? "FAIL" : "PASS";
  return {
    ...base, ok: true,
    structuredOutput: { ...original.structuredOutput, verdict, findings },
    artifactPaths: [...new Set([...(result.artifactPaths ?? []), ...(original.artifactPaths ?? [])])],
    reconsiderationHistory: [
      ...history,
      { ...context, original: original.structuredOutput, decisions: output, effectiveVerdict: verdict },
    ],
  };
}
