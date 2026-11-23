#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { assertWriterTimeoutSnapshot, collectReviewEvidence, envelopeViolation, indexChanges, repairDelta } from "../lib/review-evidence.mjs";

// Fixed host command: arguments are an extension-owned artifact path and the digest of the
// approved commands, never task text. The commands themselves come from the sealed control file.
const BUDGET_MS = 600_000;
const RESULT_BYTES = 3500; // The host step keeps only a 4 KB stdout preview; the gate must stay parseable.
const TAIL_CHARS = 1200;
const [baselinePath, approvedDigest] = process.argv.slice(2);
if (!baselinePath || !approvedDigest) throw new Error("Usage: run-pre-review.mjs <baseline.json> <baseline-sha256>");
const sealed = await readFile(baselinePath);
if (createHash("sha256").update(sealed).digest("hex") !== approvedDigest) {
  throw new Error("Pre-review baseline or commands differ from the approved envelope");
}
const { baseline, control } = JSON.parse(sealed);
const commands = control.preReviewCommands;
if (!commands?.length) throw new Error("No approved pre-review commands");

const run = (command, timeoutMs) => new Promise(resolve => {
  const started = Date.now();
  const hash = createHash("sha256");
  let tail = "", timedOut = false, settled = false;
  const child = spawn("/bin/sh", ["-c", command], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], detached: true });
  const collect = chunk => {
    hash.update(chunk);
    tail = (tail + chunk.toString("utf8")).slice(-4 * TAIL_CHARS);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  // The command owns a process group so a timed-out test runner cannot leave workers behind.
  const timer = setTimeout(() => {
    timedOut = true;
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }, timeoutMs);
  const settle = (exitCode, signal, error) => {
    // A failed spawn reports both error and close; the digest can be finalized only once.
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    const ok = exitCode === 0 && !timedOut;
    resolve({
      command, ok, exitCode, signal: signal ?? null, timedOut, durationMs: Date.now() - started,
      outputSha256: hash.digest("hex"),
      ...(ok ? {} : {
        // eslint-disable-next-line no-control-regex
        tail: `${error ? `${error.message}\n` : ""}${tail}`.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").slice(-TAIL_CHARS),
      }),
    });
  };
  child.once("error", error => settle(null, null, error));
  child.once("close", (code, signal) => settle(code, signal));
});

const before = await collectReviewEvidence(process.cwd(), { baseline });
if (control.timeoutSnapshot) assertWriterTimeoutSnapshot(before, control.timeoutSnapshot);
const delta = repairDelta(baseline, before, { ...control, allowedFiles: undefined });
const staged = indexChanges(control.recoveryIndex ?? baseline.index, before.index).map(path => ({ path }));
if (envelopeViolation([...delta.changes, ...staged], control.allowedFiles)) {
  console.log(JSON.stringify({ ok: false, skipped: "envelope-violation", results: [] }));
  process.exit(0);
}
if (!before.complete) throw new Error("Pre-review evidence is incomplete; no command ran");
const results = [];
const deadline = Date.now() + BUDGET_MS;
for (const command of commands) {
  const remaining = deadline - Date.now();
  // An exhausted budget is reported per command; it never silently counts as a pass.
  results.push(remaining > 0 ? await run(command, remaining) : { command, ok: false, skipped: "budget-exhausted" });
}
const after = await collectReviewEvidence(process.cwd(), { baseline });
// A check that rewrites the candidate would make the following review judge a different tree.
const drift = after.snapshotId !== before.snapshotId || indexChanges(before.index, after.index).length > 0;
const gate = { ok: !drift && results.every(row => row.ok), drift, results,
  snapshotId: before.snapshotId, indexId: createHash("sha256").update(before.index).digest("hex") };
const size = () => Buffer.byteLength(JSON.stringify(gate));
while (size() > RESULT_BYTES) {
  const longest = results.filter(row => row.tail).sort((a, b) => b.tail.length - a.tail.length)[0];
  if (!longest) break;
  if (longest.tail.length > 80) longest.tail = longest.tail.slice(-Math.floor(longest.tail.length / 2));
  else delete longest.tail;
}
// A failing check is a gate result, not a runner failure: only a broken runner exits non-zero.
console.log(JSON.stringify(gate));
