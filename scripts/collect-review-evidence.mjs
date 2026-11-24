#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { collectReviewEvidence, writeReviewEvidence } from "../lib/review-evidence.mjs";

const [outputPath] = process.argv.slice(2);
if (!outputPath) throw new Error("Usage: collect-review-evidence.mjs <review.md>");
const pack = await collectReviewEvidence(process.cwd());
await writeReviewEvidence(outputPath, pack);
await writeFile(outputPath.replace(/\.md$/, ".json"), JSON.stringify(pack), { mode: 0o400, flag: "wx" });
console.log(JSON.stringify({
  path: outputPath,
  head: pack.head,
  complete: pack.complete,
  changedCount: pack.manifest.length,
}));
