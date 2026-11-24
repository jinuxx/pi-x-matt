#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertRecoveryFiles, assertScopedWriterChecks, assertWriterTimeoutSnapshot, collectReviewEvidence, envelopeViolation, repairDelta } from "../lib/review-evidence.mjs";
import { WRITER_WAIT_FILE } from "../lib/writer-scope.mjs";

// No task text or caller-supplied paths: the workflow may run only this exact host grant.
const [baselinePath, baselineDigest, phase] = process.argv.slice(2);
const sealed = await readFile(baselinePath);
if (createHash("sha256").update(sealed).digest("hex") !== baselineDigest) {
  throw new Error("Original writer timeout baseline or scope changed");
}
const { baseline, control } = JSON.parse(sealed);
if (control.scopedWriter) await assertScopedWriterChecks(dirname(baselinePath));
const boundary = control.writerBoundary ?? control.standaloneTimeout; // older sealed standalone baselines
if (boundary) await assertRecoveryFiles(process.cwd(), control);
const candidate = await collectReviewEvidence(process.cwd(), { baseline });
let violation;
if (boundary) {
  const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", timeout: 10_000 }).trim();
  if (branch !== boundary.branch) throw new Error("Writer timeout branch changed; preserve the draft and stop");
  if (!boundary.ticket.startsWith("slice:")) {
    const path = join(baseline.cwd, boundary.ticket);
    if (await realpath(path) !== path || createHash("sha256").update(await readFile(path)).digest("hex") !== boundary.ticketDigest) {
      throw new Error("Writer timeout ticket changed; preserve the draft and stop");
    }
  }
  violation = envelopeViolation(repairDelta(baseline, candidate).changes, control.allowedFiles, control.allowedDirectories);
}
if (violation) {
  // Keep exact paths in the native host log; the short preview may truncate a long list.
  console.error(`Implementation changed files outside the approved envelope: ${violation.paths.join(", ")}. ` +
    "Preserve the draft and stop; any scope expansion needs explicit approval outside timeoutRecovery.");
  process.exitCode = 1;
} else {
  const expected = phase === "start" ? boundary.start : control.timeoutSnapshot;
  const snapshot = assertWriterTimeoutSnapshot(candidate, expected);
  if (control.scopedWriter && candidate.index !== (control.recoveryIndex ?? baseline.index)) {
    throw new Error("Scoped writer candidate changed the Git index; preserve the draft and stop");
  }
  if (boundary?.start && snapshot.indexId !== boundary.start.indexId) {
    throw new Error("Writer timeout continuation changed the Git index; preserve the draft and stop");
  }
  if (phase === "scope") {
    const duration = await readFile(join(dirname(baselinePath), WRITER_WAIT_FILE), "utf8");
    if (!/^(0|[1-9]\d*)$/.test(duration) || !Number.isSafeInteger(Number(duration))) {
      throw new Error("Missing valid scoped writer supervisor-wait timing; preserve the draft and stop");
    }
    snapshot.supervisorWaitMs = Number(duration);
  }
  console.log(JSON.stringify(snapshot));
}
