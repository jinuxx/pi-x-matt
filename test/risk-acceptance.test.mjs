import assert from "node:assert/strict";
import test from "node:test";
import { confirmRiskAcceptance } from "../lib/risk-acceptance.mjs";

const finding = { id: "minor", rootCauseId: "cleanup", severity: "P2", title: "cleanup ordering",
  basis: { kind: "standard", reference: "resource convention" }, evidence: "reachable cleanup order",
  expected: "release first", actual: "mark first", locations: ["server.mjs:8"],
  classification: "independent", relatedFindingIds: [], affectedBy: [] };
const results = (item = finding) => [
  { key: "implement", ok: true, structuredOutput: {
    status: "COMPLETE", confirmedSeams: [{}], cycles: [{}], changedFiles: ["server.mjs"], commands: [{}],
  } },
  { key: "standards", ok: true, structuredOutput: { axis: "standards", verdict: "FAIL", findings: [item] } },
  { key: "spec", ok: true, structuredOutput: { axis: "spec", verdict: "PASS", findings: [] } },
];
const record = { id: "source", snapshotId: "candidate", scope: { ticket: "slice:test" } };
const request = { findingIds: ["standards:minor"], reason: "bounded operational trade-off", evidence: "reviewed mitigation" };

test("risk acceptance requires real confirmation and preserves original FAIL for the exact candidate", async () => {
  const original = results(), before = JSON.stringify(original);
  let prompts = 0;
  const receipt = await confirmRiskAcceptance(request, original, record, {
    hasUI: true, ui: { confirm: async (_title, text) => {
      prompts++;
      assert.match(text, /Candidate: candidate/);
      assert.match(text, /standards:minor/);
      assert.match(text, /Original FAIL remains/);
      return true;
    } },
  }, undefined, () => 123);
  assert.equal(prompts, 1);
  assert.equal(receipt.candidateSnapshotId, "candidate");
  assert.equal(receipt.source, "user-confirmed");
  assert.equal(receipt.confirmedAt, 123);
  assert.equal(JSON.stringify(original), before);
});

test("risk acceptance never waives P0/P1, safety, integrity, acceptance or missing reports", async () => {
  const ctx = { hasUI: true, ui: { confirm: () => assert.fail("ineligible risks must not prompt") } };
  for (const item of [
    { ...finding, severity: "P0" }, { ...finding, severity: "P1" },
    ...["safety", "integrity", "acceptance"].map(kind => ({ ...finding, basis: { ...finding.basis, kind } })),
  ]) await assert.rejects(() => confirmRiskAcceptance(request, results(item), record, ctx), /only covers/);
  const unavailable = results();
  unavailable[2] = { key: "spec", ok: false, error: "usage limit reached" };
  await assert.rejects(() => confirmRiskAcceptance(request, unavailable, record, ctx), /Recover the failed/);
  const specFailure = results();
  specFailure[1].structuredOutput = { axis: "standards", verdict: "PASS", findings: [] };
  specFailure[2].structuredOutput = { axis: "spec", verdict: "FAIL", findings: [{ ...finding, basis: { kind: "acceptance", reference: "AC1" } }] };
  await assert.rejects(() => confirmRiskAcceptance({ ...request, findingIds: ["spec:minor"] }, specFailure, record, ctx), /only covers/);
});

test("risk acceptance cannot be authorized by prose, omitted IDs, aliases or a rejected dialog", async () => {
  const yes = { hasUI: true, ui: { confirm: async () => true } };
  for (const input of [
    { ...request, findingIds: [] }, { ...request, findingIds: ["minor"] },
    { ...request, findingIds: ["standards:minor", "standards:minor"] },
    { ...request, reason: " " }, { ...request, evidence: "" },
  ]) await assert.rejects(() => confirmRiskAcceptance(input, results(), record, yes), /every exact remaining finding/);
  await assert.rejects(() => confirmRiskAcceptance(request, results(), record, { hasUI: false }), /fresh real user/);
  await assert.rejects(() => confirmRiskAcceptance(request, results(), record, {
    hasUI: true, ui: { confirm: async () => false },
  }), /not approved/);
});
