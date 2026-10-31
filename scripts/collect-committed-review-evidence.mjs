#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { assertCommittedReviewFresh, collectCommittedReviewEvidence } from "../lib/committed-review-evidence.mjs";
import { writeReviewEvidence } from "../lib/review-evidence.mjs";

// Fixed host command: arguments are extension-owned artifact paths, never task text.
const [controlPath, outputPath] = process.argv.slice(2);
if (!controlPath || !outputPath) throw new Error("Usage: collect-committed-review-evidence.mjs <control.json> <review.md>");
const control = JSON.parse(await readFile(controlPath, "utf8"));
const pack = await collectCommittedReviewEvidence(process.cwd(), control);
if (!pack.complete) throw new Error("Committed review evidence is incomplete; reviewers were not launched.");
await writeReviewEvidence(outputPath, pack);
await writeFile(outputPath.replace(/\.md$/, ".json"), JSON.stringify(pack), { mode: 0o400, flag: "wx" });
await assertCommittedReviewFresh(process.cwd(), control);
console.log(JSON.stringify({
  path: outputPath, fixedPoint: pack.fixedPoint, head: pack.head,
  diffSha256: pack.diffSha256, complete: pack.complete,
}));
