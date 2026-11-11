#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { collectCandidateTreeProof } from "../lib/batch-authorization.mjs";
import { collectReviewEvidence, indexChanges, repairDelta, writeReviewEvidence } from "../lib/review-evidence.mjs";

// Fixed host command: arguments are extension-owned artifact paths, never task text.
const [baselinePath, outputPath] = process.argv.slice(2);
if (!baselinePath || !outputPath) throw new Error("Usage: collect-review-evidence.mjs <baseline.json> <review.md>");
const { baseline, control } = JSON.parse(await readFile(baselinePath, "utf8"));
const pack = await collectReviewEvidence(process.cwd(), { baseline });
if (control.recoveryIndex !== undefined &&
    indexChanges(control.recoveryIndex, pack.index).some(path => !control.allowedFiles.includes(path))) {
  throw new Error("Implementation changed index paths outside the approved envelope");
}
pack.incremental = repairDelta(baseline, pack, control);
const candidate = control.batch ? await collectCandidateTreeProof(process.cwd(), pack, control) : null;
if (candidate) pack.batchCandidate = candidate;
await writeReviewEvidence(outputPath, pack);
await writeFile(outputPath.replace(/\.md$/, ".json"), JSON.stringify(pack), { mode: 0o400, flag: "wx" });
console.log(JSON.stringify({
  path: outputPath, head: pack.head, diffSha256: pack.diffSha256, complete: pack.complete,
  ...(candidate ? { candidate } : {}),
  boundary: {
    incremental: Boolean(control.previousSnapshotId),
    changedPaths: pack.incremental.changes.map(change => change.path),
    approvedFindingIds: control.approvedFindingIds ?? [],
  },
}));
