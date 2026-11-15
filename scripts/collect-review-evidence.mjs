#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { collectCandidateTreeProof } from "../lib/batch-authorization.mjs";
import { collectReviewEvidence, envelopeViolation, envelopeViolationMessage, indexChanges, repairDelta, writeReviewEvidence } from "../lib/review-evidence.mjs";
import { reviewResultFrame } from "../lib/review-workflow.mjs";

// Fixed host command: arguments are extension-owned artifact paths, never task text.
const [baselinePath, outputPath] = process.argv.slice(2);
if (!baselinePath || !outputPath) throw new Error("Usage: collect-review-evidence.mjs <baseline.json> <review.md>");
const { baseline, control } = JSON.parse(await readFile(baselinePath, "utf8"));
const pack = await collectReviewEvidence(process.cwd(), { baseline });
if (!pack.complete) throw new Error("Review evidence is incomplete; reviewers were not launched");
if (control.recollect && (pack.snapshotId !== control.recollect.snapshotId || pack.index !== control.recollect.index)) {
  throw new Error("Envelope recollection candidate or index is stale; no reviewer was launched");
}
pack.incremental = repairDelta(baseline, pack, { ...control, allowedFiles: undefined });
const indexPaths = control.recoveryIndex === undefined ? []
  : indexChanges(control.recoveryIndex, pack.index).map(path => ({ path }));
const violation = envelopeViolation([...pack.incremental.changes, ...indexPaths], control.allowedFiles);
if (violation) pack.envelopeViolation = violation;
const candidate = control.batch && !violation ? await collectCandidateTreeProof(process.cwd(), pack, control) : null;
if (candidate) pack.batchCandidate = candidate;
await writeReviewEvidence(outputPath, pack);
await writeFile(outputPath.replace(/\.md$/, ".json"), JSON.stringify(pack), { mode: 0o400, flag: "wx" });
if (violation) throw new Error(
  (envelopeViolation(indexPaths, control.allowedFiles) ? "Implementation changed index paths outside the approved envelope. " : "") +
  envelopeViolationMessage(violation),
);
const result = {
  path: outputPath, head: pack.head, snapshotId: pack.snapshotId, diffSha256: pack.diffSha256, complete: pack.complete,
  ...(candidate ? { candidate } : {}),
  boundary: {
    incremental: Boolean(control.previousSnapshotId),
    changedPaths: pack.incremental.changes.map(change => change.path),
    approvedFindingIds: control.approvedFindingIds ?? [],
  },
};
const frame = reviewResultFrame(result);
await writeFile(outputPath.replace(/\.md$/, "-result.json"), JSON.stringify(result), { mode: 0o400, flag: "wx" });
console.log(JSON.stringify(frame));
