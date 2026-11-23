#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { assertWriterTimeoutSnapshot, collectReviewEvidence } from "../lib/review-evidence.mjs";

// No task text or caller-supplied paths: the workflow may run only this exact host grant.
const [baselinePath, baselineDigest] = process.argv.slice(2);
const sealed = await readFile(baselinePath);
if (createHash("sha256").update(sealed).digest("hex") !== baselineDigest) {
  throw new Error("Original writer timeout baseline or scope changed");
}
const { baseline, control } = JSON.parse(sealed);
const candidate = await collectReviewEvidence(process.cwd(), { baseline });
console.log(JSON.stringify(assertWriterTimeoutSnapshot(candidate, control.timeoutSnapshot)));
