import assert from "node:assert/strict";
import test from "node:test";
import { revalidateReviewReports, validateReviewResult } from "../lib/review-contract.mjs";
import { blockingFindings, prepareRepair, prepareReconsideration, reviewReportCorrections } from "../lib/repair-contract.mjs";

const finding = {
  id: "response", rootCauseId: "peer-response", severity: "P1", title: "Missing rejection response",
  basis: { kind: "acceptance", reference: "AC1: return the declared rejection response" },
  expected: "The response is observable", actual: "The connection closes without a response",
  evidence: "The changed branch closes the connection before sending the response",
  locations: ["app/peer:v2.py:135"], classification: "independent",
  relatedFindingIds: [], affectedBy: [], recommendation: "Preserve the accepted response",
};
const boundary = {
  incremental: true, changedPaths: ["app/peer:v2.py"], approvedFindingIds: ["standards:filter"],
};
const review = (patch = {}) => ({ key: "spec", ok: true, structuredOutput: {
  axis: "spec", verdict: "FAIL", summary: "Acceptance gap", findings: [{ ...finding, ...patch }], notes: [],
} });
const standards = { key: "standards", ok: true, structuredOutput: {
  axis: "standards", verdict: "PASS", findings: [],
} };

test("review locations accept line ranges without truncating colons in real paths", () => {
  for (const location of ["app/peer:v2.py:135", "app/peer:v2.py:135:7", "app/peer:v2.py:135-140"]) {
    assert.equal(validateReviewResult(review({ locations: [location] }), boundary).ok, true, location);
  }
  const invalid = validateReviewResult(review({ locations: ["other.py:135-140"] }), boundary);
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /other\.py:135-140/);
  assert.match(invalid.error, /app\/peer:v2\.py/);
});

test("bare and prefixed finding IDs have one effective identity across repair and reconsideration", () => {
  const report = validateReviewResult(review({ id: "spec:response" }), boundary);
  assert.equal(report.ok, true);
  assert.equal(report.structuredOutput.findings[0].id, "response");
  const results = [standards, report];
  assert.deepEqual(blockingFindings(results).map(item => item.id), ["spec:response"]);
  assert.deepEqual(prepareReconsideration({ findings: [{
    findingId: "spec:response", reason: "AC1 is disputed", evidence: "AC1 text",
  }] }, results).targets.map(item => item.id), ["spec:response"]);
  const group = { id: "peer-response", findingIds: ["spec:response"], contract: "Preserve responses",
    preserve: ["Filtering"], validationOrder: "filter -> response", callPath: ["accept -> reject"],
    examples: ["Denied peers receive the specified response"] };
  assert.deepEqual(prepareRepair({ id: "prior" }, { previousDispatchId: "prior", groups: [group] }, results)
    .approvedFindingIds, ["spec:response"]);
  assert.throws(() => prepareRepair({ id: "prior" }, {
    previousDispatchId: "prior", groups: [{ ...group, findingIds: ["spec:unknown"] }],
  }, results), /spec:response/);
  const duplicate = review();
  duplicate.structuredOutput.findings.push({ ...finding, id: "spec:response" });
  assert.match(validateReviewResult(duplicate, boundary).error, /duplicate finding identity/);
  assert.equal(validateReviewResult(review({ id: "standards:response" }), boundary).ok, false);
  const legacy = validateReviewResult(review({ id: "spec:response", classification: "original",
    relatedFindingIds: ["spec:spec:response"],
  }), { ...boundary, approvedFindingIds: ["spec:spec:response"] });
  const previous = { id: "legacy", repair: {
    groups: [{ ...group, id: "legacy-group", findingIds: ["spec:spec:response"] }],
    counts: { "legacy-group": 1 },
  } };
  const continued = prepareRepair(previous, { previousDispatchId: "legacy",
    groups: [{ ...group, id: "legacy-group" }],
  }, [standards, legacy]);
  assert.deepEqual(continued.counts, { "legacy-group": 2 });
  assert.deepEqual(continued.approvedFindingIds, ["spec:response"]);
});

test("cross-axis causal regressions preserve axis-specific bases and require actual impact", () => {
  const regression = { classification: "regression", relatedFindingIds: ["standards:filter"] };
  const result = validateReviewResult(review(regression), boundary);
  assert.equal(result.ok, true);
  const previous = { id: "prior", repair: {
    groups: [{ id: "peer-response", findingIds: ["standards:filter"] }], counts: { "peer-response": 1 },
  } };
  const repair = prepareRepair(previous, { previousDispatchId: "prior", groups: [{
    id: "peer-response", findingIds: ["spec:response"], contract: "Filter without losing responses",
    preserve: ["Peer filtering"], validationOrder: "filter -> response", callPath: ["accept -> reject"],
    examples: ["Denied peers receive the specified response"],
  }] }, [standards, result]);
  assert.deepEqual(repair.needsDiagnosis, ["peer-response"]);
  assert.equal(validateReviewResult(review({ ...regression, relatedFindingIds: ["standards:unknown"] }), boundary).ok, false);
  assert.equal(validateReviewResult(review({ ...regression, classification: "original" }), boundary).ok, false);
  assert.equal(validateReviewResult(review({ ...regression, locations: ["unchanged.py:1"] }), boundary).ok, false);
  assert.equal(validateReviewResult(review({ ...regression, basis: { kind: "standard", reference: "Style" } }), boundary).ok, false);
});

test("spec NO_EVIDENCE contains an actionable source handoff without inventing acceptance criteria", () => {
  const result = validateReviewResult({ key: "spec", ok: true, structuredOutput: {
    axis: "spec", verdict: "NO_EVIDENCE", findings: [], notes: ["Parent spec is missing"],
  } }, boundary);
  assert.equal(result.structuredOutput.verdict, "NO_EVIDENCE");
  assert.deepEqual(result.structuredOutput.findings, []);
  assert.match(result.structuredOutput.notes.join("\n"), /laneTasks\.spec/);
  assert.match(result.structuredOutput.notes.join("\n"), /parent spec/);
});

test("host revalidation cannot waive still-invalid reports, schema failures or candidate correction limits", () => {
  const rejected = { ...review({ relatedFindingIds: ["spec:unknown"] }), ok: false,
    contractError: { kind: "review-evidence", message: "unknown predecessor" } };
  const results = revalidateReviewReports([standards, rejected], ["spec"], boundary, "same-candidate");
  assert.deepEqual(results.keys, []);
  assert.equal(results.results[1], rejected);
  assert.throws(() => reviewReportCorrections(results.results, ["spec"], { spec: 2 }), /exhausted/);
  const schemaFailure = { ...review(), ok: false, contractError: { kind: "structured-output" } };
  assert.deepEqual(revalidateReviewReports([schemaFailure], ["spec"], boundary, "same-candidate").keys, []);
  assert.deepEqual(revalidateReviewReports([{ ...schemaFailure, structuredOutputFailed: true,
    contractError: { kind: "review-evidence" },
  }], ["spec"], boundary, "same-candidate").keys, [], "schema rejection cannot be relabeled into a waiver");
  assert.deepEqual(revalidateReviewReports([review()], ["spec"], boundary, "same-candidate").keys, []);
});
