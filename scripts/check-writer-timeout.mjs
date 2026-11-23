#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { assertRecoveryFiles, assertWriterTimeoutSnapshot, collectReviewEvidence, envelopeViolation, repairDelta } from "../lib/review-evidence.mjs";

// No task text or caller-supplied paths: the workflow may run only this exact host grant.
const [baselinePath, baselineDigest, phase] = process.argv.slice(2);
const sealed = await readFile(baselinePath);
if (createHash("sha256").update(sealed).digest("hex") !== baselineDigest) {
  throw new Error("Original writer timeout baseline or scope changed");
}
const { baseline, control } = JSON.parse(sealed);
const standalone = control.standaloneTimeout;
if (standalone) await assertRecoveryFiles(process.cwd(), control);
const candidate = await collectReviewEvidence(process.cwd(), { baseline });
let violation;
if (standalone) {
  const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", timeout: 10_000 }).trim();
  if (branch !== standalone.branch) throw new Error("Writer timeout branch changed; preserve the draft and stop");
  if (!standalone.ticket.startsWith("slice:")) {
    const path = join(baseline.cwd, standalone.ticket);
    if (await realpath(path) !== path || createHash("sha256").update(await readFile(path)).digest("hex") !== standalone.ticketDigest) {
      throw new Error("Writer timeout ticket changed; preserve the draft and stop");
    }
  }
  violation = envelopeViolation(repairDelta(baseline, candidate).changes, control.allowedFiles);
}
if (violation) {
  // Keep exact paths in the native host log; the short preview may truncate a long list.
  console.error(`Implementation changed files outside the approved envelope: ${violation.paths.join(", ")}. ` +
    "Preserve the draft and stop; any scope expansion needs explicit approval outside timeoutRecovery.");
  process.exitCode = 1;
} else {
  const expected = phase === "start" ? standalone.start : control.timeoutSnapshot;
  const snapshot = assertWriterTimeoutSnapshot(candidate, expected);
  if (standalone?.start && snapshot.indexId !== standalone.start.indexId) {
    throw new Error("Writer timeout continuation changed the Git index; preserve the draft and stop");
  }
  console.log(JSON.stringify(snapshot));
}
