import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { admitCommittedReview, collectCommittedReviewEvidence, normalizeCommittedReviewScope } from "../lib/committed-review-evidence.mjs";
import { prepareCommittedReviewEvidence } from "../lib/review-workflow.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digest = value => createHash("sha256").update(value).digest("hex");
const COLLECTOR_URL = new URL("../lib/committed-review-evidence.mjs", import.meta.url).href;

function childCollector(fixedPoint) {
  return `
import { admitCommittedReview, collectCommittedReviewEvidence } from ${JSON.stringify(COLLECTOR_URL)};
const control = await admitCommittedReview(process.cwd(), ${JSON.stringify(fixedPoint)});
const pack = await collectCommittedReviewEvidence(process.cwd(), control);
console.log(JSON.stringify({ complete: pack.complete,
  content: pack.manifest.find(entry => entry.path === "f.txt")?.content, head: pack.head }));
`;
}

async function fixture(run) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "matt-committed-evidence-")));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const commit = message => {
    git("add", "-A");
    git("commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  try {
    git("init", "-q");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Test");
    await run(cwd, git, commit);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function snapshot(cwd, git) {
  const status = execFileSync("git", ["--no-optional-locks", "status", "--porcelain=v1"], { cwd, encoding: "utf8" });
  const index = await readFile(join(cwd, ".git", "index"));
  const objects = (await readdir(join(cwd, ".git", "objects"), { recursive: true })).sort();
  return { head: git("rev-parse", "HEAD"), index: digest(index), objects, status };
}

test("committed collector reads only Git objects across the pinned range and the fixed CLI writes the pack", async () => {
  await fixture(async (cwd, git, commit) => {
    await writeFile(join(cwd, "tracked.txt"), "before\n");
    await writeFile(join(cwd, "deleted.txt"), "delete me\n");
    await writeFile(join(cwd, "old name.txt"), "rename me\n");
    await writeFile(join(cwd, "mode.sh"), "#!/bin/sh\necho base\n");
    await writeFile(join(cwd, "dirty.txt"), "clean baseline\n");
    const fixedPoint = commit("baseline");
    await writeFile(join(cwd, "tracked.txt"), "feature\n");
    await rm(join(cwd, "deleted.txt"));
    git("mv", "old name.txt", "new name.txt");
    await chmod(join(cwd, "mode.sh"), 0o755);
    await writeFile(join(cwd, "new\nfile.txt"), "new full content\n");
    commit("feature");
    await writeFile(join(cwd, "tracked.txt"), "final\n");
    const head = commit("final");
    // Dirty, staged and untracked worktree data must never be read for a committed range.
    await writeFile(join(cwd, "tracked.txt"), "dirty staged\n");
    git("add", "tracked.txt");
    await writeFile(join(cwd, "tracked.txt"), "dirty unstaged\n");
    await writeFile(join(cwd, "dirty.txt"), "dirty worktree\n");
    await writeFile(join(cwd, "untracked.txt"), "untracked\n");

    const before = await snapshot(cwd, git);
    const control = await admitCommittedReview(cwd, fixedPoint);
    assert.deepEqual({ fixedPoint: control.fixedPoint, head: control.head, cwd: control.cwd },
      { fixedPoint, head, cwd });
    const pack = await collectCommittedReviewEvidence(cwd, control);
    const evidence = await prepareCommittedReviewEvidence(cwd, ROOT, control);
    try {
      assert.equal(execSync(evidence.command, { cwd, encoding: "utf8" }).includes('"complete":true'), true);
      const packText = await readFile(evidence.path, "utf8");
      assert.match(packText, /Committed Review Evidence Pack/);
      assert.match(packText, /Committed file content/);
      const written = JSON.parse(await readFile(evidence.snapshotPath, "utf8"));
      assert.equal(written.reviewKind, "committed");
      assert.equal(written.fixedPoint, fixedPoint);
      assert.equal(written.head, head);
      assert.equal(written.complete, true);
      assert.match(written.diff, /\+final/);
      assert.match(written.diff, /rename from old name\.txt/);
      assert.match(written.diff, /new mode 100755/);
      assert.doesNotMatch(written.diff, /dirty unstaged|dirty worktree|untracked/);
      const tracked = written.manifest.find(entry => entry.path === "tracked.txt");
      assert.equal(tracked.content, "final\n");
      assert.equal(tracked.sha256, digest("final\n"));
      assert.equal(written.manifest.find(entry => entry.path === "new\nfile.txt").content, "new full content\n");
      assert.equal(written.manifest.find(entry => entry.path === "deleted.txt").kind, "deleted");
      assert.equal(written.manifest.find(entry => entry.path === "deleted.txt").sha256, null);
      const renamed = written.manifest.find(entry => entry.path === "new name.txt");
      assert.equal(renamed.oldPath, "old name.txt");
      assert.equal(renamed.content, "rename me\n");
      assert.equal(written.manifest.find(entry => entry.path === "mode.sh").mode, "100755");
      assert.doesNotMatch(packText, /dirty unstaged|dirty worktree/);
    } finally {
      await rm(dirname(evidence.path), { recursive: true, force: true });
    }
    const after = await snapshot(cwd, git);
    assert.deepEqual(after, before, "admission, collection and the fixed CLI must not write the repository");
    assert.equal(pack.complete, true);
  });
});

test("committed collection scopes nested projects and allows an empty pinned range", async () => {
  await fixture(async (cwd, git, commit) => {
    const project = join(cwd, "project");
    await mkdir(project);
    await writeFile(join(project, "inside.txt"), "inside before\n");
    await writeFile(join(cwd, "outside.txt"), "outside before\n");
    const fixedPoint = commit("baseline");
    await writeFile(join(project, "inside.txt"), "inside feature\n");
    await writeFile(join(project, "new inside.txt"), "new inside\n");
    await writeFile(join(cwd, "outside.txt"), "outside feature\n");
    await writeFile(join(cwd, "outside only.txt"), "outside only\n");
    const head = commit("feature");

    const control = await admitCommittedReview(project, fixedPoint);
    const pack = await collectCommittedReviewEvidence(project, control);
    assert.deepEqual(pack.manifest.map(entry => entry.path).sort(), ["inside.txt", "new inside.txt"]);
    assert.match(pack.diff, /inside feature/);
    assert.doesNotMatch(pack.diff, /outside feature|outside only/);
    assert.equal(pack.gitRoot, cwd);
    assert.equal(pack.cwd, project);

    const empty = await collectCommittedReviewEvidence(project, await admitCommittedReview(project, head));
    assert.equal(empty.fixedPoint, head);
    assert.equal(empty.complete, true);
    assert.deepEqual(empty.manifest, []);
  });
});

test("committed admission and collection fail closed for invalid refs, non-ancestors, stale HEAD and binaries", async () => {
  await fixture(async (cwd, git, commit) => {
    await writeFile(join(cwd, "tracked.txt"), "before\n");
    const fixedPoint = commit("baseline");
    await writeFile(join(cwd, "tracked.txt"), "feature\n");
    commit("feature");
    const branch = git("rev-parse", "--abbrev-ref", "HEAD");
    git("checkout", "-q", "-b", "side", fixedPoint);
    await writeFile(join(cwd, "side.txt"), "side\n");
    const side = commit("side");
    git("checkout", "-q", branch);

    await assert.rejects(() => admitCommittedReview(cwd, "missing-ref"), /fixedPoint/i);
    await assert.rejects(() => admitCommittedReview(cwd, side), /ancestor/i);
    const admitted = await admitCommittedReview(cwd, fixedPoint);
    await assert.rejects(() => collectCommittedReviewEvidence(cwd, { ...admitted, head: side }), /HEAD changed/i);

    await writeFile(join(cwd, "binary.bin"), Buffer.from([0, 1]));
    commit("binary");
    const control = await admitCommittedReview(cwd, fixedPoint);
    const binary = await collectCommittedReviewEvidence(cwd, control);
    assert.equal(binary.complete, false);
    assert.equal(binary.manifest.find(entry => entry.path === "binary.bin").binary, true);
    const evidence = await prepareCommittedReviewEvidence(cwd, ROOT, control);
    try {
      assert.throws(() => execSync(evidence.command, { cwd, stdio: "pipe" }), /incomplete|Command failed/);
      await assert.rejects(() => readFile(evidence.path, "utf8"), /ENOENT/);
    } finally {
      await rm(dirname(evidence.path), { recursive: true, force: true });
    }

    git("commit", "--allow-empty", "-qm", "moved");
    await assert.rejects(() => collectCommittedReviewEvidence(cwd, control), /HEAD changed/i);
    assert.throws(() => normalizeCommittedReviewScope({ kind: "worktree", fixedPoint }), /kind/);
    assert.throws(() => normalizeCommittedReviewScope({ kind: "committed", fixedPoint, head: side }), /only/);
    assert.throws(() => normalizeCommittedReviewScope({ kind: "committed", fixedPoint: " " }), /fixedPoint/);
  });
});

test("committed collector ignores replacement refs for pinned objects and ancestry", async () => {
  await fixture(async (cwd, git, commit) => {
    await writeFile(join(cwd, "a.txt"), "before\n");
    const fixedPoint = commit("base");
    await writeFile(join(cwd, "a.txt"), "after\n");
    const head = commit("feature");
    const tree = git("rev-parse", `${fixedPoint}^{tree}`);
    const replacement = git("commit-tree", tree, "-p", fixedPoint, "-m", "replacement");
    git("replace", head, replacement);
    const control = await admitCommittedReview(cwd, fixedPoint);
    const pack = await collectCommittedReviewEvidence(cwd, control);
    assert.equal(pack.head, head);
    assert.equal(pack.manifest.find(entry => entry.path === "a.txt").content, "after\n");

    const orphan = git("commit-tree", tree, "-m", "orphan");
    const fake = git("commit-tree", tree, "-p", fixedPoint, "-m", "fake ancestor");
    git("replace", orphan, fake);
    await assert.rejects(() => admitCommittedReview(cwd, orphan), /ancestor/i);
  });
});

test("committed collector rejects promisor clones before object queries or remote access", async () => {
  const root = await mkdtemp(join(tmpdir(), "matt-promisor-"));
  const source = join(root, "source");
  const clone = join(root, "clone");
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  try {
    git(root, "init", "-q", source);
    git(source, "config", "user.email", "test@example.invalid");
    git(source, "config", "user.name", "Test");
    git(source, "config", "uploadpack.allowFilter", "true");
    await writeFile(join(source, "f.txt"), "base\n");
    git(source, "add", ".");
    git(source, "commit", "-qm", "base");
    await writeFile(join(source, "f.txt"), "feature\n");
    git(source, "commit", "-qam", "feature");
    const fixedPoint = git(source, "rev-parse", "HEAD^");
    const head = git(source, "rev-parse", "HEAD");
    execFileSync("git", ["clone", "-q", "--no-local", "--filter=blob:none", `file://${source}`, clone]);
    git(clone, "remote", "set-url", "origin", `file://${join(root, "missing")}`);
    const objects = async () => (await readdir(join(clone, ".git", "objects"), { recursive: true })).sort();
    const before = await objects();
    const cloneRoot = await realpath(clone);
    await assert.rejects(() => admitCommittedReview(clone, fixedPoint), /promisor|partial clone/i);
    await assert.rejects(() => collectCommittedReviewEvidence(clone, {
      fixedPoint, head, cwd: cloneRoot, gitRoot: cloneRoot,
    }), /promisor|partial clone/i);
    assert.deepEqual(await objects(), before, "promisor preflight must not read or fetch objects");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("committed admission rejects native truthy promisor aliases and malformed booleans", async () => {
  await fixture(async (cwd, git, commit) => {
    await writeFile(join(cwd, "f.txt"), "base\n");
    const fixedPoint = commit("base");
    await writeFile(join(cwd, "f.txt"), "feature\n");
    const head = commit("feature");
    git("config", "remote.origin.url", `file://${join(cwd, "missing")}`);
    const objects = async () => (await readdir(join(cwd, ".git", "objects"), { recursive: true })).sort();
    const before = await objects();
    const canonical = await realpath(cwd);
    git("config", "remote.origin.promisor", "yes");
    await assert.rejects(() => admitCommittedReview(cwd, fixedPoint), /promisor|partial clone/i);
    await assert.rejects(() => collectCommittedReviewEvidence(cwd, {
      fixedPoint, head, cwd: canonical, gitRoot: canonical,
    }), /promisor|partial clone/i);
    assert.deepEqual(await objects(), before, "truthy promisor aliases must be rejected before object reads");
    git("config", "remote.origin.promisor", "false");
    const control = await admitCommittedReview(cwd, fixedPoint);
    assert.equal(control.fixedPoint, fixedPoint);
    git("config", "remote.origin.partialclonefilter", "blob:none");
    await assert.rejects(() => admitCommittedReview(cwd, fixedPoint), /promisor|partial clone/i);
    git("config", "--unset", "remote.origin.partialclonefilter");
    git("config", "remote.origin.promisor", "maybe");
    await assert.rejects(() => admitCommittedReview(cwd, fixedPoint), /boolean|promisor/i);
  });
});

test("committed admission rejects a spaced promisor remote before object reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "matt-spaced-promisor-"));
  const source = join(root, "source");
  const clone = join(root, "clone");
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  try {
    git(root, "init", "-q", source);
    git(source, "config", "user.email", "test@example.invalid");
    git(source, "config", "user.name", "Test");
    git(source, "config", "uploadpack.allowFilter", "true");
    await writeFile(join(source, "f.txt"), "base\n");
    git(source, "add", ".");
    git(source, "commit", "-qm", "base");
    await writeFile(join(source, "f.txt"), "feature\n");
    git(source, "commit", "-qam", "feature");
    const fixedPoint = git(source, "rev-parse", "HEAD^");
    const head = git(source, "rev-parse", "HEAD");
    execFileSync("git", ["clone", "-q", "--no-local", "--filter=blob:none", `file://${source}`, clone]);
    git(clone, "config", "--rename-section", "remote.origin", "remote.remote name");
    git(clone, "config", "--unset-all", "remote.remote name.partialclonefilter");
    assert.equal(git(clone, "config", "--type=bool", "--get", "remote.remote name.promisor"), "true");
    assert.match(git(clone, "remote", "get-url", "remote name"), /^file:/);
    const objects = async () => (await readdir(join(clone, ".git", "objects"), { recursive: true })).sort();
    const before = await objects();
    const canonical = await realpath(clone);
    await assert.rejects(() => admitCommittedReview(clone, fixedPoint), /promisor|partial clone/i);
    await assert.rejects(() => collectCommittedReviewEvidence(clone, {
      fixedPoint, head, cwd: canonical, gitRoot: canonical,
    }), /promisor|partial clone/i);
    assert.deepEqual(await objects(), before, "spaced promisor remote must be rejected before object reads");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("committed admission rejects mixed promisor values before object reads", async () => {
  await fixture(async (cwd, git, commit) => {
    await writeFile(join(cwd, "f.txt"), "base\n");
    const fixedPoint = commit("base");
    await writeFile(join(cwd, "f.txt"), "feature\n");
    const head = commit("feature");
    git("config", "remote.origin.url", `file://${join(cwd, "missing")}`);
    git("config", "--add", "remote.origin.promisor", "true");
    git("config", "--add", "remote.origin.promisor", "false");
    assert.equal(git("config", "--get-all", "remote.origin.promisor").split("\n").length, 2);
    const objects = async () => (await readdir(join(cwd, ".git", "objects"), { recursive: true })).sort();
    const before = await objects();
    const canonical = await realpath(cwd);
    await assert.rejects(() => admitCommittedReview(cwd, fixedPoint), /promisor|partial clone/i);
    await assert.rejects(() => collectCommittedReviewEvidence(cwd, {
      fixedPoint, head, cwd: canonical, gitRoot: canonical,
    }), /promisor|partial clone/i);
    assert.deepEqual(await objects(), before, "any true promisor value must reject before object reads");
  });
});

test("committed view preserves GIT_OBJECT_DIRECTORY primary objects", async () => {
  const root = await mkdtemp(join(tmpdir(), "matt-external-objects-"));
  const repo = join(root, "repo");
  const objects = join(root, "objects");
  await mkdir(repo);
  await mkdir(objects);
  const env = { GIT_OBJECT_DIRECTORY: objects };
  const git = (...args) => execFileSync("git", args, {
    cwd: repo, env: { ...process.env, ...env }, encoding: "utf8",
  }).trim();
  try {
    git("init", "-q");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Test");
    await writeFile(join(repo, "f.txt"), "base\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const fixedPoint = git("rev-parse", "HEAD");
    await writeFile(join(repo, "f.txt"), "feature\n");
    git("commit", "-qam", "feature");
    const head = git("rev-parse", "HEAD");
    const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", childCollector(fixedPoint)], {
      cwd: repo, env: { ...process.env, ...env }, encoding: "utf8",
    }));
    assert.equal(result.complete, true);
    assert.equal(result.content, "feature\n");
    assert.equal(result.head, head);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("committed view preserves relative GIT_ALTERNATE_OBJECT_DIRECTORIES", async () => {
  const root = await mkdtemp(join(tmpdir(), "matt-alternate-objects-"));
  const repo = join(root, "repo");
  const alternate = join(root, "alt");
  await mkdir(repo);
  await mkdir(alternate);
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Test");
    await writeFile(join(repo, "f.txt"), "base\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const fixedPoint = git("rev-parse", "HEAD");
    await writeFile(join(repo, "f.txt"), "feature\n");
    git("commit", "-qam", "feature");
    const head = git("rev-parse", "HEAD");
    const objectDir = join(repo, ".git", "objects");
    for (const entry of await readdir(objectDir)) {
      if (entry !== "info") await rename(join(objectDir, entry), join(alternate, entry));
    }
    const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", childCollector(fixedPoint)], {
      cwd: repo,
      env: { ...process.env, GIT_ALTERNATE_OBJECT_DIRECTORIES: "../alt" },
      encoding: "utf8",
    }));
    assert.equal(result.complete, true);
    assert.equal(result.content, "feature\n");
    assert.equal(result.head, head);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("committed collection supports repository paths containing newlines", async () => {
  const root = await mkdtemp(join(tmpdir(), "matt-newline-repo-"));
  const repo = join(root, "repo\nname");
  await mkdir(repo);
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Test");
    await writeFile(join(repo, "f.txt"), "base\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const fixedPoint = git("rev-parse", "HEAD");
    await writeFile(join(repo, "f.txt"), "feature\n");
    git("commit", "-qam", "feature");
    const head = git("rev-parse", "HEAD");
    const control = await admitCommittedReview(repo, fixedPoint);
    const pack = await collectCommittedReviewEvidence(repo, control);
    assert.equal(pack.complete, true);
    assert.equal(pack.head, head);
    assert.equal(pack.manifest.find(entry => entry.path === "f.txt").content, "feature\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("committed collection propagates object-format query failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "matt-format-failure-"));
  const repo = join(root, "repo");
  const shimDirectory = join(root, "shim");
  await mkdir(repo);
  await mkdir(shimDirectory);
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Test");
    await writeFile(join(repo, "f.txt"), "base\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const fixedPoint = git("rev-parse", "HEAD");
    await writeFile(join(repo, "f.txt"), "feature\n");
    git("commit", "-qam", "feature");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    await writeFile(join(shimDirectory, "git"), [
      "#!/bin/sh",
      `real=${JSON.stringify(realGit)}`,
      'case "$*" in',
      '  *"rev-parse --show-object-format"*)',
      "    echo FORMAT_QUERY_FAILED_SENTINEL >&2",
      "    exit 73",
      "    ;;",
      "esac",
      'exec "$real" "$@"',
    ].join("\n"), { mode: 0o755 });
    assert.throws(() => execFileSync(process.execPath, ["--input-type=module", "-e", childCollector(fixedPoint)], {
      cwd: repo,
      env: { ...process.env, PATH: `${shimDirectory}:${process.env.PATH}` },
      encoding: "utf8",
    }), /FORMAT_QUERY_FAILED_SENTINEL/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("committed ancestry ignores legacy graft files", async () => {
  await fixture(async (cwd, git) => {
    await writeFile(join(cwd, "a.txt"), "same\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const tree = git("rev-parse", "HEAD^{tree}");
    const fixedPoint = git("commit-tree", tree, "-m", "orphan F");
    const head = git("commit-tree", tree, "-m", "orphan H");
    git("update-ref", "HEAD", head);
    await assert.rejects(() => admitCommittedReview(cwd, fixedPoint), /ancestor/i);
    await mkdir(join(cwd, ".git", "info"), { recursive: true });
    await writeFile(join(cwd, ".git", "info", "grafts"), `${head} ${fixedPoint}\n`);
    await assert.rejects(() => admitCommittedReview(cwd, fixedPoint), /ancestor/i);
    const child = git("commit-tree", tree, "-p", fixedPoint, "-m", "real child");
    git("update-ref", "HEAD", child);
    const control = await admitCommittedReview(cwd, fixedPoint);
    assert.equal(control.fixedPoint, fixedPoint);
    assert.equal(control.head, child);
  });
});

test("committed diff ignores live attribute drivers and repository info attributes", async () => {
  await fixture(async (cwd, git, commit) => {
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
    await writeFile(join(cwd, "file.txt"), `# MAGIC\n${lines.join("\n")}\n`);
    const fixedPoint = commit("base");
    lines[24] = "line 25 changed";
    await writeFile(join(cwd, "file.txt"), `# MAGIC\n${lines.join("\n")}\n`);
    const head = commit("change");
    const control = await admitCommittedReview(cwd, fixedPoint);
    const clean = await collectCommittedReviewEvidence(cwd, control);
    assert.match(clean.diff, /\+line 25 changed/);
    git("config", "diff.demo.xfuncname", "^# MAGIC");
    await writeFile(join(cwd, ".gitattributes"), "file.txt diff=demo\n");
    const dirty = await collectCommittedReviewEvidence(cwd, control);
    assert.equal(dirty.diffSha256, clean.diffSha256);
    git("add", ".gitattributes");
    const staged = await collectCommittedReviewEvidence(cwd, control);
    assert.equal(staged.diffSha256, clean.diffSha256);
    await mkdir(join(cwd, ".git", "info"), { recursive: true });
    await writeFile(join(cwd, ".git", "info", "attributes"), "file.txt diff=demo\n");
    const inRepo = await collectCommittedReviewEvidence(cwd, control);
    assert.equal(inRepo.diffSha256, clean.diffSha256);
    assert.equal(inRepo.head, head);
  });
});

test("committed diff ignores dirty and staged attributes for the same object range", async () => {
  await fixture(async (cwd, git, commit) => {
    await writeFile(join(cwd, "file.txt"), "one\n");
    const fixedPoint = commit("base");
    await writeFile(join(cwd, "file.txt"), "two\n");
    const head = commit("change");
    const control = await admitCommittedReview(cwd, fixedPoint);
    await writeFile(join(cwd, ".gitattributes"), "*.txt -diff\n");
    const dirty = await collectCommittedReviewEvidence(cwd, control);
    assert.match(dirty.diff, /\+two/);
    assert.equal(dirty.complete, true);
    assert.deepEqual(dirty.manifest.map(entry => entry.path), ["file.txt"]);
    git("add", ".gitattributes");
    const staged = await collectCommittedReviewEvidence(cwd, control);
    assert.equal(staged.diffSha256, dirty.diffSha256);
    assert.deepEqual(staged.manifest.map(entry => entry.path), ["file.txt"]);
  });
});

test("committed collector rejects gitlink changes on either side despite ignore config", async () => {
  await fixture(async (cwd, git) => {
    await writeFile(join(cwd, "x.txt"), "x\n");
    const commitIndex = message => {
      git("commit", "-qm", message);
      return git("rev-parse", "HEAD");
    };
    git("add", ".");
    git("commit", "-qm", "base");
    const tree = git("rev-parse", "HEAD^{tree}");
    const first = git("commit-tree", tree, "-m", "sub one");
    const second = git("commit-tree", tree, "-m", "sub two");
    git("update-index", "--add", "--cacheinfo", `160000,${first},sub`);
    const fixedPoint = commitIndex("gitlink one");
    git("update-index", "--add", "--cacheinfo", `160000,${second},sub`);
    const head = commitIndex("gitlink two");
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd, input: "plain\n", encoding: "utf8" }).trim();
    git("read-tree", head);
    git("update-index", "--add", "--cacheinfo", `100644,${blob},sub`);
    const replaced = git("commit-tree", git("write-tree"), "-p", head, "-m", "gitlink replaced");
    git("read-tree", head);
    git("update-index", "--force-remove", "sub");
    const deleted = git("commit-tree", git("write-tree"), "-p", head, "-m", "gitlink deleted");
    git("update-ref", "HEAD", deleted);
    await writeFile(join(cwd, "plain.txt"), "plain\n");
    git("add", "plain.txt");
    const withPlain = commitIndex("plain present");
    git("rm", "-q", "plain.txt");
    const withoutPlain = commitIndex("plain deleted");
    // Make commits first: diff.ignoreSubmodules=all also makes `git commit` see an empty change.
    git("config", "diff.ignoreSubmodules", "all");
    git("config", "submodule.sub.ignore", "all");
    const changed = await collectCommittedReviewEvidence(cwd, await admitCommittedReview(cwd, fixedPoint));
    assert.equal(changed.manifest.find(entry => entry.path === "sub").kind, "unsupported");
    assert.equal(changed.complete, false);
    git("update-ref", "HEAD", replaced);
    const replacedPack = await collectCommittedReviewEvidence(cwd, await admitCommittedReview(cwd, head));
    assert.equal(replacedPack.manifest.find(entry => entry.path === "sub").kind, "unsupported");
    assert.equal(replacedPack.complete, false);
    git("update-ref", "HEAD", deleted);
    const deletedPack = await collectCommittedReviewEvidence(cwd, await admitCommittedReview(cwd, head));
    assert.equal(deletedPack.manifest.find(entry => entry.path === "sub").kind, "unsupported");
    assert.equal(deletedPack.complete, false);
    git("update-ref", "HEAD", withoutPlain);
    const ordinary = await collectCommittedReviewEvidence(cwd, await admitCommittedReview(cwd, withPlain));
    assert.equal(ordinary.manifest.find(entry => entry.path === "plain.txt").kind, "deleted");
    assert.equal(ordinary.complete, true);
    assert.equal(withoutPlain, git("rev-parse", "HEAD"));
  });
});

test("committed collector rejects lossy path, symlink and old-side bytes", async () => {
  await fixture(async (cwd, git) => {
    await writeFile(join(cwd, "base.txt"), "base\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    const badBlob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd, input: "bad name\n", encoding: "utf8" }).trim();
    const entries = execFileSync("git", ["ls-tree", "-z", `${base}^{tree}`], { cwd });
    const badEntry = Buffer.concat([
      Buffer.from(`100644 blob ${badBlob}\t`),
      Buffer.from([0x62, 0x61, 0x64, 0x2d, 0xff, 0x2e, 0x74, 0x78, 0x74, 0x00]),
    ]);
    const badTree = execFileSync("git", ["mktree", "-z"], {
      cwd, input: Buffer.concat([entries, badEntry]), encoding: "utf8",
    }).trim();
    const badPath = git("commit-tree", badTree, "-p", base, "-m", "bad path");
    git("update-ref", "HEAD", badPath);
    const canonical = await realpath(cwd);
    await assert.rejects(() => collectCommittedReviewEvidence(cwd, {
      fixedPoint: base, head: badPath, cwd: canonical, gitRoot: canonical,
    }), /UTF-8|lossless/i);

    const linkBlob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd, input: Buffer.from([0xff]), encoding: "utf8",
    }).trim();
    git("read-tree", badPath);
    git("update-index", "--add", "--cacheinfo", `120000,${linkBlob},link`);
    const linkTree = git("write-tree");
    const badLink = git("commit-tree", linkTree, "-p", badPath, "-m", "bad link");
    git("update-ref", "HEAD", badLink);
    await assert.rejects(() => collectCommittedReviewEvidence(cwd, {
      fixedPoint: badPath, head: badLink, cwd: canonical, gitRoot: canonical,
    }), /symlink|UTF-8|lossless/i);

    const binaryBlob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd, input: Buffer.from([0, 1, 2]), encoding: "utf8",
    }).trim();
    git("read-tree", badLink);
    git("update-index", "--add", "--cacheinfo", `100644,${binaryBlob},old.bin`);
    const withBinaryTree = git("write-tree");
    const withBinary = git("commit-tree", withBinaryTree, "-p", badLink, "-m", "old binary");
    git("update-ref", "HEAD", withBinary);
    git("read-tree", withBinary);
    git("update-index", "--force-remove", "old.bin");
    const deletedTree = git("write-tree");
    const deletedBinary = git("commit-tree", deletedTree, "-p", withBinary, "-m", "old binary deleted");
    git("update-ref", "HEAD", deletedBinary);
    const pack = await collectCommittedReviewEvidence(cwd, await admitCommittedReview(cwd, withBinary));
    assert.equal(pack.manifest.find(entry => entry.path === "old.bin").kind, "unsupported");
    assert.equal(pack.complete, false);
    assert.equal(deletedBinary, git("rev-parse", "HEAD"));
  });
});

test("committed collector rejects NUL symlink bytes on add and delete", async () => {
  await fixture(async (cwd, git, commit) => {
    await writeFile(join(cwd, "base.txt"), "base\n");
    const fixedPoint = commit("base");
    const linkBlob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd, input: Buffer.from([0]), encoding: "utf8",
    }).trim();
    git("update-index", "--add", "--cacheinfo", `120000,${linkBlob},link`);
    git("commit", "-qm", "nul link");
    const head = git("rev-parse", "HEAD");
    const added = await collectCommittedReviewEvidence(cwd, await admitCommittedReview(cwd, fixedPoint));
    assert.equal(added.manifest.find(entry => entry.path === "link").kind, "unsupported");
    assert.equal(added.complete, false);

    git("read-tree", head);
    git("update-index", "--force-remove", "link");
    const deletedTree = git("write-tree");
    const deleted = git("commit-tree", deletedTree, "-p", head, "-m", "delete nul link");
    git("update-ref", "HEAD", deleted);
    const removed = await collectCommittedReviewEvidence(cwd, await admitCommittedReview(cwd, head));
    assert.equal(removed.manifest.find(entry => entry.path === "link").kind, "unsupported");
    assert.equal(removed.complete, false);
  });
});

test("committed CLI rechecks HEAD after publishing both artifacts", async () => {
  await fixture(async (cwd, git, commit) => {
    await writeFile(join(cwd, "tracked.txt"), "before\n");
    const fixedPoint = commit("base");
    await writeFile(join(cwd, "tracked.txt"), "after\n");
    commit("feature");
    const evidence = await prepareCommittedReviewEvidence(cwd, ROOT, await admitCommittedReview(cwd, fixedPoint));
    const shimDirectory = await mkdtemp(join(tmpdir(), "matt-git-shim-"));
    const countPath = join(shimDirectory, "count");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const shim = join(shimDirectory, "git");
    await writeFile(shim, [
      "#!/bin/sh",
      `real=${JSON.stringify(realGit)}`,
      'case "$*" in',
      '  *"rev-parse --verify HEAD"*)',
      '    "$real" "$@"; status=$?',
      '    if [ $status -eq 0 ]; then',
      '      count=$(cat "$SHIM_COUNT" 2>/dev/null || echo 0); count=$((count + 1)); printf "%s" "$count" > "$SHIM_COUNT"',
      '      if [ "$count" -eq 2 ]; then "$real" -C "$SHIM_REPO" commit --allow-empty -qm "moved during publication" >/dev/null 2>&1; fi',
      "    fi",
      "    exit $status",
      "    ;;",
      "esac",
      'exec "$real" "$@"',
    ].join("\n"), { mode: 0o755 });
    try {
      assert.throws(() => execSync(evidence.command, {
        cwd, encoding: "utf8",
        env: { ...process.env, PATH: `${shimDirectory}:${process.env.PATH}`, SHIM_REPO: cwd, SHIM_COUNT: countPath },
      }), /HEAD changed/i);
    } finally {
      await rm(shimDirectory, { recursive: true, force: true });
      await rm(dirname(evidence.path), { recursive: true, force: true });
    }
  });
});
