/** Self-contained: embedded into the sandbox, with host-collected increment metadata. */
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
  if (!Array.isArray(output.findings) ||
      (output.verdict === "FAIL" && !output.findings.length) ||
      (output.verdict !== "FAIL" && output.findings.length)) problem = "verdict/findings mismatch";
  for (const finding of output.findings ?? []) {
    if (ids.has(finding.id)) {
      problem = "duplicate finding identity";
      break;
    }
    ids.add(finding.id);
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
    const related = finding.relatedFindingIds.some(id => boundary.approvedFindingIds.includes(id));
    if (finding.relatedFindingIds.some(id => !id.startsWith(`${output.axis}:`) || !boundary.approvedFindingIds.includes(id))) {
      problem = "finding references an unknown or different-axis predecessor";
      break;
    }
    if (boundary.approvedFindingIds.length && ["original", "regression"].includes(finding.classification) && !related) {
      problem = "recurring finding has no approved predecessor";
      break;
    }
    const changed = finding.locations.some(location => boundary.changedPaths.includes(location.replace(/:\d+(?::\d+)?$/, "")));
    const dependency = finding.affectedBy.some(path => boundary.changedPaths.includes(path));
    const safety = ["safety", "integrity"].includes(finding.basis.kind);
    if (boundary.incremental && !changed && !dependency && !related && !safety) {
      problem = "unchanged reviewed content has no evidenced dependency impact";
      break;
    }
  }
  // An invalid report is recoverable review failure, never authorization to patch or an automatic PASS.
  return problem ? {
    ...result, ok: false,
    contractError: { kind: "review-evidence", message: problem },
    error: `Review evidence contract invalid: ${problem}; use the axis report correction path`,
  } : result;
}

/** Self-contained and embedded into the sandbox: decide only the challenged findings. */
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
    const targetIds = new Set(targets.map(target => target.id));
    const seen = new Set();
    for (const decision of decisions) {
      if (!decision || typeof decision.findingId !== "string" || !decision.findingId ||
          !targetIds.has(decision.findingId) || seen.has(decision.findingId)) {
        problem = "decision report contains an unknown, repeated or different-axis finding";
        break;
      }
      if (!decision.findingId.startsWith(`${axis}:`)) {
        problem = "decision report contains a different-axis finding";
        break;
      }
      seen.add(decision.findingId);
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
    decision.findingId.slice(axis.length + 1), decision.decision,
  ]));
  const findings = original.structuredOutput.findings.filter(finding => byId.get(finding.id) !== "withdraw");
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
