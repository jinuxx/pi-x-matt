#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { collectReviewEvidence, repairDelta, writeReviewEvidence } from "../lib/review-evidence.mjs";

// Fixed host command: arguments are extension-owned artifact paths, never task text.
const [baselinePath, outputPath] = process.argv.slice(2);
if (!baselinePath || !outputPath) throw new Error("Usage: collect-review-evidence.mjs <baseline.json> <review.md>");
const { baseline, control } = JSON.parse(await readFile(baselinePath, "utf8"));
const pack = await collectReviewEvidence(process.cwd(), { baseline });
pack.incremental = repairDelta(baseline, pack, control);
await writeReviewEvidence(outputPath, pack);
await writeFile(outputPath.replace(/\.md$/, ".json"), JSON.stringify(pack), { mode: 0o400, flag: "wx" });
console.log(JSON.stringify({
  path: outputPath, head: pack.head, diffSha256: pack.diffSha256, complete: pack.complete,
  boundary: {
    incremental: Boolean(control.previousSnapshotId),
    changedPaths: pack.incremental.changes.map(change => change.path),
    approvedFindingIds: control.approvedFindingIds ?? [],
  },
}));
