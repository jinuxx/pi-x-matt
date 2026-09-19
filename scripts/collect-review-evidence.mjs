#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { collectReviewEvidence, writeReviewEvidence } from "../lib/review-evidence.mjs";

// Fixed host command: arguments are extension-owned artifact paths, never task text.
const [baselinePath, outputPath] = process.argv.slice(2);
if (!baselinePath || !outputPath) throw new Error("Usage: collect-review-evidence.mjs <baseline.json> <review.md>");
const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
const pack = await collectReviewEvidence(process.cwd(), { baseline });
await writeReviewEvidence(outputPath, pack);
console.log(JSON.stringify({ path: outputPath, head: pack.head, diffSha256: pack.diffSha256, complete: pack.complete }));
