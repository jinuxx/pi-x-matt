#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const BUDGET_MS = 600_000;
const RESULT_BYTES = 3500; // Fits pi-subagents 4 KiB host stdout preview.
const TAIL_CHARS = 1200;

const [controlPath, approvedDigest] = process.argv.slice(2);
if (!controlPath || !approvedDigest) {
  throw new Error("Usage: run-verify-commands.mjs <verify.json> <sha256>");
}
const sealed = await readFile(controlPath);
if (createHash("sha256").update(sealed).digest("hex") !== approvedDigest) {
  throw new Error("Verify command control file digest mismatch");
}
const { commands } = JSON.parse(sealed);
if (!Array.isArray(commands) || !commands.length) {
  throw new Error("No approved verify commands");
}

const run = (command, timeoutMs) => new Promise((resolve) => {
  const started = Date.now();
  let tail = "";
  let timedOut = false;
  let settled = false;
  const child = spawn("/bin/sh", ["-c", command], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const collect = (chunk) => {
    tail = (tail + chunk.toString("utf8")).slice(-4 * TAIL_CHARS);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const timer = setTimeout(() => {
    timedOut = true;
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }, timeoutMs);
  const settle = (exitCode, signal, error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    const ok = exitCode === 0 && !timedOut;
    resolve({
      command,
      ok,
      exitCode,
      signal: signal ?? null,
      timedOut,
      durationMs: Date.now() - started,
      ...(ok ? {} : {
        // eslint-disable-next-line no-control-regex
        tail: `${error ? `${error.message}\n` : ""}${tail}`.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").slice(-TAIL_CHARS),
      }),
    });
  };
  child.once("error", (error) => settle(null, null, error));
  child.once("close", (code, signal) => settle(code, signal));
});

const results = [];
const deadline = Date.now() + BUDGET_MS;
for (const command of commands) {
  const remaining = deadline - Date.now();
  results.push(
    remaining > 0
      ? await run(command, remaining)
      : { command, ok: false, exitCode: null, signal: null, timedOut: true, durationMs: 0, tail: "budget-exhausted" },
  );
}

const summary = { ok: results.every((row) => row.ok), results };
while (Buffer.byteLength(JSON.stringify(summary)) > RESULT_BYTES) {
  const longest = results.filter((row) => row.tail).sort((a, b) => b.tail.length - a.tail.length)[0];
  if (!longest) break;
  if (longest.tail.length > 80) longest.tail = longest.tail.slice(-Math.floor(longest.tail.length / 2));
  else delete longest.tail;
}
console.log(JSON.stringify(summary));
