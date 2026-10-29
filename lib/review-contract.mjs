/** Self-contained: embedded into the sandbox, with host-collected increment metadata. */
export function validateReviewResult(result, boundary) {
  const output = result.structuredOutput;
  if (!result.ok || !output) return result;
  let problem;
  if (!Array.isArray(output.findings) ||
      (output.verdict === "FAIL" && !output.findings.length) ||
      (output.verdict !== "FAIL" && output.findings.length)) problem = "verdict/findings mismatch";
  for (const finding of output.findings ?? []) {
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
  return problem ? { ...result, ok: false, error: `Review evidence contract invalid: ${problem}` } : result;
}
