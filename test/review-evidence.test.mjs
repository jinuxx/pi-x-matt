import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { collectReviewEvidence, writeReviewEvidence } from "../lib/review-evidence.mjs";
import { prepareTddHostControls, prepareWorktreeReviewEvidence } from "../lib/review-workflow.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

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

test("worktree evidence collector captures diff, untracked text, hashes, deletes and renames without writing the repo", async () => {
  await fixture(async (cwd, git) => {
    await writeFile(join(cwd, "tracked.txt"), "after\n");
    git("add", "tracked.txt");
    await writeFile(join(cwd, "tracked.txt"), "after unstaged\n");
    await rm(join(cwd, "deleted.txt"));
    await rename(join(cwd, "old name.txt"), join(cwd, "new name.txt"));
    git("add", "old name.txt", "new name.txt");
    await writeFile(join(cwd, "new\nfile.txt"), "new full content\n");
    const status = git("status", "--porcelain=v1");

    const pack = await collectReviewEvidence(cwd);
    assert.match(pack.diff, /after unstaged/);
    assert.match(pack.diff, /deleted file mode/);
    assert.match(pack.diff, /rename from old name.txt/);
    assert.ok(pack.manifest.some((f) => f.path === "new name.txt" && f.oldPath === "old name.txt"));
    const added = pack.manifest.find((f) => f.path === "new\nfile.txt");
    assert.equal(added.content, "new full content\n");
    assert.match(added.sha256, /^[a-f0-9]{64}$/);
    assert.equal(pack.manifest.find((f) => f.path === "deleted.txt").sha256, null);
    assert.equal(git("status", "--porcelain=v1"), status);

    const output = await mkdtemp(join(tmpdir(), "matt-pack-test-"));
    try {
      const path = join(output, "review.md");
      await writeReviewEvidence(path, pack);
      const text = await readFile(path, "utf8");
      assert.ok(text.includes(pack.diff));
      assert.ok(text.includes(added.content));
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });
});

test("worktree collector records symlinks safely, flags binaries, and scopes nested projects", async () => {
  await fixture(async (cwd, git) => {
    await symlink("/etc/passwd", join(cwd, "link"));
    await writeFile(join(cwd, "binary.bin"), Buffer.from([0, 255, 1]));
    await chmod(join(cwd, "tracked.txt"), 0o755);
    const pack = await collectReviewEvidence(cwd);
    assert.equal(pack.manifest.find((f) => f.path === "link").kind, "symlink");
    assert.equal(pack.manifest.find((f) => f.path === "link").content, "/etc/passwd");
    assert.equal(pack.manifest.find((f) => f.path === "binary.bin").binary, true);
    assert.equal(pack.complete, false);
    assert.equal(pack.manifest.find((f) => f.path === "tracked.txt").mode, "100755");

    const project = join(cwd, "project");
    await mkdir(project);
    await writeFile(join(project, "inside.txt"), "inside before\n");
    git("add", "project/inside.txt");
    git("commit", "-qm", "nested baseline");
    await writeFile(join(project, "inside.txt"), "inside change\n");
    const nested = await collectReviewEvidence(project);
    assert.deepEqual(nested.manifest.map((e) => e.path), ["inside.txt"]);
    assert.equal(nested.gitRoot, await realpath(cwd));
    assert.equal(nested.cwd, await realpath(project));
  });
});

test("host commands enforce single-use claim, run verifyCommands, and write worktree review packs", async () => {
  await fixture(async (cwd) => {
    const controls = await prepareTddHostControls(ROOT, ["node -e 'process.exit(0)'", "node -e 'console.error(\"boom\"); process.exit(1)'"]);
    const evidence = await prepareWorktreeReviewEvidence(ROOT);
    try {
      assert.equal(JSON.parse(execSync(controls.claimCommand, { cwd, encoding: "utf8" })).claimed, true);
      assert.throws(() => execSync(controls.claimCommand, { cwd, stdio: "pipe" }), /Command failed/);

      const verify = JSON.parse(execSync(controls.verifyCommand, { cwd, encoding: "utf8" }));
      assert.equal(verify.ok, false);
      assert.equal(verify.results.length, 2);
      assert.equal(verify.results[0].ok, true);
      assert.equal(verify.results[1].ok, false);
      assert.match(verify.results[1].tail, /boom/);

      await writeFile(join(cwd, "tracked.txt"), "implemented\n");
      const captured = JSON.parse(execSync(evidence.command, { cwd, encoding: "utf8" }));
      assert.equal(captured.path, evidence.path);
      assert.equal(captured.complete, true);
      assert.equal(captured.changedCount, 1);
      assert.match(await readFile(evidence.path, "utf8"), /\+implemented/);
      assert.equal(evidence.path.startsWith(`${cwd}/`), false);
    } finally {
      await rm(controls.directory, { recursive: true, force: true });
      await rm(dirname(evidence.path), { recursive: true, force: true });
    }
  });
});
