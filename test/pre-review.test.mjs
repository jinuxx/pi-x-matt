import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { prepareTddEvidence } from "../lib/review-workflow.mjs";

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RUNNER = join(ROOT, "scripts/run-pre-review.mjs");
const sha256 = value => createHash("sha256").update(value).digest("hex");

async function repo(run) {
  const cwd = await mkdtemp(join(tmpdir(), "matt-pre-review-"));
  const artifacts = await mkdtemp(join(tmpdir(), "matt-pre-review-control-"));
  try {
    await writeFile(join(cwd, "tracked.txt"), "original\n");
    await writeFile(join(cwd, ".gitignore"), "cache/\n");
    for (const args of [["init", "-q"], ["config", "user.email", "test@example.invalid"],
      ["config", "user.name", "Test"], ["add", "."], ["commit", "-qm", "baseline"]]) await exec("git", args, { cwd });
    let count = 0;
    const gate = async (preReviewCommands, digest = sha256(JSON.stringify(preReviewCommands))) => {
      const baselinePath = join(artifacts, `baseline-${count++}.json`);
      await writeFile(baselinePath, JSON.stringify({ baseline: {}, control: { preReviewCommands } }));
      const { stdout } = await exec(process.execPath, [RUNNER, baselinePath, digest], { cwd });
      assert.ok(Buffer.byteLength(stdout) < 4096, "the gate must fit the host-step stdout preview");
      return JSON.parse(stdout);
    };
    await run({ cwd, gate });
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(artifacts, { recursive: true, force: true });
  }
}

test("pre-review runner reports each approved command in order and never fails on a failing check", async () => {
  await repo(async ({ gate }) => {
    const passed = await gate(["true", "mkdir -p cache && echo warm > cache/state"]);
    assert.equal(passed.ok, true);
    assert.equal(passed.drift, false, "ignored caches are not candidate drift");
    assert.deepEqual(passed.results.map(row => [row.command, row.ok, row.exitCode, "tail" in row]),
      [["true", true, 0, false], ["mkdir -p cache && echo warm > cache/state", true, 0, false]]);
    assert.match(passed.results[0].outputSha256, /^[0-9a-f]{64}$/);

    const failed = await gate(["printf '\\033[31mexpected 2, got 3\\033[0m\\n' >&2; exit 3", "true"]);
    assert.equal(failed.ok, false);
    assert.equal(failed.drift, false);
    assert.deepEqual(failed.results.map(row => [row.ok, row.exitCode, row.timedOut]), [[false, 3, false], [true, 0, false]],
      "later commands still run so one correction turn sees every failure");
    assert.equal(failed.results[0].tail, "expected 2, got 3\n");
  });
});

test("pre-review runner keeps a noisy gate parseable and treats candidate drift as a failed gate", async () => {
  await repo(async ({ cwd, gate }) => {
    const noisy = Array.from({ length: 6 }, (_, index) =>
      `node -e "console.log('line ${index} '.repeat(40000)); console.log('last ${index}'); process.exitCode = 1"`);
    const flooded = await gate(noisy);
    assert.equal(flooded.ok, false);
    assert.equal(flooded.results.length, 6);
    assert.ok(flooded.results.every((row, index) => row.command === noisy[index] && row.exitCode === 1));
    assert.ok(flooded.results.some(row => row.tail?.endsWith(`last ${noisy.indexOf(row.command)}\n`)),
      "shrinking keeps the end of the output, where test runners print the failure");

    const drifted = await gate(["echo formatted > tracked.txt"]);
    assert.equal(drifted.results[0].ok, true);
    assert.equal(drifted.drift, true);
    assert.equal(drifted.ok, false, "a check that rewrites the candidate cannot vouch for it");
    assert.equal(await readFile(join(cwd, "tracked.txt"), "utf8"), "formatted\n");
  });
});

test("pre-review runner executes only the commands sealed into its authorized command line", async () => {
  await repo(async ({ cwd, gate }) => {
    await assert.rejects(() => gate(["echo swapped > tracked.txt"], sha256(JSON.stringify(["true"]))),
      /differ from the approved envelope/);
    await assert.rejects(() => gate([]), /differ from the approved envelope/);
    assert.equal(await readFile(join(cwd, "tracked.txt"), "utf8"), "original\n", "a mismatched control file runs nothing");

    const evidence = await prepareTddEvidence(cwd, ROOT, { allowedFiles: ["tracked.txt"], preReviewCommands: ["true"] });
    try {
      assert.match(evidence.preReviewCommand, new RegExp(`run-pre-review\\.mjs' '.*baseline\\.json' '${sha256(JSON.stringify(["true"]))}'$`));
      const { stdout } = await exec("/bin/sh", ["-c", evidence.preReviewCommand], { cwd });
      assert.equal(JSON.parse(stdout).ok, true);
      assert.equal("preReviewCommand" in await prepareTddEvidence(cwd, ROOT, { allowedFiles: ["tracked.txt"] }), false);
    } finally {
      await rm(join(evidence.path, ".."), { recursive: true, force: true });
    }
  });
});
