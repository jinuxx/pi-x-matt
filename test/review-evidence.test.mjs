import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { collectReviewEvidence, writeReviewEvidence } from "../lib/review-evidence.mjs";
import { prepareTddEvidence } from "../lib/review-workflow.mjs";

async function fixture(run) {
  const cwd = await mkdtemp(join(tmpdir(), "matt-evidence-test-"));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Test");
    await writeFile(join(cwd, "tracked.txt"), "before\n");
    await writeFile(join(cwd, "deleted.txt"), "delete me\n");
    await writeFile(join(cwd, "old name.txt"), "rename me\n");
    git("add", ".");
    git("commit", "-qm", "baseline");
    await run(cwd, git);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("evidence collector captures combined diff, untracked contents, hashes and rename paths without writing the repo", async () => {
  await fixture(async (cwd, git) => {
    const baseline = await collectReviewEvidence(cwd);
    await writeFile(join(cwd, "tracked.txt"), "after\n");
    git("add", "tracked.txt");
    await writeFile(join(cwd, "tracked.txt"), "after unstaged\n");
    await rm(join(cwd, "deleted.txt"));
    await rename(join(cwd, "old name.txt"), join(cwd, "new name.txt"));
    git("add", "old name.txt", "new name.txt");
    await writeFile(join(cwd, "new\nfile.txt"), "new full content\n");
    const status = git("status", "--porcelain=v1");
    const pack = await collectReviewEvidence(cwd, { baseline });
    assert.equal(pack.head, baseline.head);
    assert.equal(pack.fixedPoint, baseline.head);
    assert.match(pack.diff, /after unstaged/);
    assert.match(pack.diff, /deleted file mode/);
    assert.match(pack.diff, /rename from old name.txt/);
    assert.ok(pack.manifest.some(f => f.path === "new name.txt" && f.oldPath === "old name.txt"));
    const added = pack.manifest.find(f => f.path === "new\nfile.txt");
    assert.equal(added.content, "new full content\n");
    assert.match(added.sha256, /^[a-f0-9]{64}$/);
    assert.equal(pack.manifest.find(f => f.path === "deleted.txt").sha256, null);
    assert.equal(git("status", "--porcelain=v1"), status);
    const output = await mkdtemp(join(tmpdir(), "matt-pack-test-"));
    try {
      const path = join(output, "review.md");
      await writeReviewEvidence(path, pack);
      const text = await readFile(path, "utf8");
      assert.ok(text.includes(pack.diff), "the combined diff must be readable as real lines, not a single JSON string");
      assert.ok(text.includes(added.content));
      assert.match(text, /Pre-dispatch baseline/);
      assert.match(text, /worker-reported/);
    } finally { await rm(output, { recursive: true, force: true }); }
  });
});

test("evidence collector refuses stale HEAD and does not follow untracked symlinks", async () => {
  await fixture(async (cwd, git) => {
    const baseline = await collectReviewEvidence(cwd);
    await symlink("/etc/passwd", join(cwd, "link"));
    const pack = await collectReviewEvidence(cwd);
    assert.equal(pack.manifest[0].kind, "symlink");
    assert.equal(pack.manifest[0].content, "/etc/passwd");
    git("commit", "--allow-empty", "-qm", "moved");
    await assert.rejects(() => collectReviewEvidence(cwd, { baseline }), /fixed point/);
  });
});

test("evidence collection is scoped to a nested project root inside a larger Git worktree", async () => {
  await fixture(async (cwd, git) => {
    const project = join(cwd, "project");
    await mkdir(project);
    await writeFile(join(project, "inside.txt"), "inside before\n");
    git("add", "project/inside.txt");
    git("commit", "-qm", "nested baseline");
    await writeFile(join(cwd, "tracked.txt"), "outside change\n");
    await writeFile(join(project, "inside.txt"), "inside change\n");
    await writeFile(join(project, "new.txt"), "inside new\n");
    const pack = await collectReviewEvidence(project);
    assert.deepEqual(pack.manifest.map(entry => entry.path).sort(), ["inside.txt", "new.txt"]);
    assert.match(pack.diff, /inside change/);
    assert.doesNotMatch(pack.diff, /outside change/);
    assert.equal(pack.gitRoot, await realpath(cwd));
    assert.equal(pack.cwd, await realpath(project));
  });
});

test("the actual finite host command writes a read-only pack outside the target repository", async () => {
  await fixture(async (cwd) => {
    const evidence = await prepareTddEvidence(cwd, fileURLToPath(new URL("..", import.meta.url)));
    try {
      await writeFile(join(cwd, "tracked.txt"), "implemented\n");
      const result = JSON.parse(execSync(evidence.command, { cwd, encoding: "utf8" }));
      assert.equal(result.path, evidence.path);
      assert.equal(result.complete, true);
      assert.match(await readFile(evidence.path, "utf8"), /\+implemented/);
      assert.equal(evidence.path.startsWith(`${cwd}/`), false);
      assert.throws(() => execSync(evidence.command, { cwd, stdio: "pipe" }), /Command failed/, "do not overwrite evidence on retry");
    } finally { await rm(dirname(evidence.path), { recursive: true, force: true }); }
  });
});

test("evidence collector preserves pre-existing changes and flags non-text evidence", async () => {
  await fixture(async (cwd) => {
    await writeFile(join(cwd, "tracked.txt"), "user change\n");
    const baseline = await collectReviewEvidence(cwd);
    await writeFile(join(cwd, "binary.bin"), Buffer.from([0, 255, 1]));
    const pack = await collectReviewEvidence(cwd, { baseline });
    assert.match(pack.baseline.diff, /user change/);
    assert.equal(pack.complete, false);
    assert.equal(pack.manifest.find(f => f.path === "binary.bin").encoding, "base64");
  });
});
