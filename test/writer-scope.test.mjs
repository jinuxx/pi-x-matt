import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveImplementationScope } from "../lib/dispatch-authorization.mjs";
import { assertScopedWriterChecks, envelopeViolation, runScopedWriterCheck } from "../lib/review-evidence.mjs";
import { scopedWriteTarget, writerSupervisorWait } from "../lib/writer-scope.mjs";

async function fixture(run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "matt-writer-scope-")));
  try {
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    await mkdir(join(root, "code/parser"), { recursive: true });
    await mkdir(join(root, "code/parser-extra"));
    await writeFile(join(root, "code/parser/index.js"), "old\n");
    await writeFile(join(root, ".gitignore"), "ignored/\n*.cache\n.venv/\n");
    git("init", "-q");
    git("add", ".");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "baseline");
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

const grant = root => ({ root, allowedFiles: [], allowedDirectories: ["code/parser"], protectedPaths: [] });
const input = { ticket: "slice:test", scope: "Parser only", delivery: "verified",
  preReviewCommands: ["node --test"], allowedDirectories: ["code/parser"] };

test("supervisor timing counts overlapping decisions once and ignores progress updates", () => {
  let now = 0;
  const wait = writerSupervisorWait(() => now);
  const contact = (toolCallId, reason) => wait.start({ toolName: "contact_supervisor", toolCallId, args: { reason } });
  contact("progress", "progress_update");
  now = 10;
  contact("decision", "need_decision");
  now = 20;
  contact("interview", "interview_request");
  now = 30;
  assert.equal(wait.end("decision"), undefined);
  assert.equal(wait.end("progress"), undefined);
  now = 40;
  assert.equal(wait.end("interview"), 30);
  now = 50;
  contact("next", "need_decision");
  now = 55;
  assert.equal(wait.end("next"), 35);
});

test("scoped approval accepts normal and planned module directories, not root, globs, private, links or ignored paths", async () => {
  await fixture(async root => {
    await symlink("parser", join(root, "code/alias"));
    const scope = await resolveImplementationScope(root, { ...input, allowedDirectories: ["code/future", "code/parser"],
      diagnosticFiles: ["code/parser/parse.test.js"] });
    assert.deepEqual(scope.allowedFiles, []);
    for (const dir of [".", "code/*", "code/../code", ".git", ".pi", ".x-matt", "code/alias", "ignored", "root-typo"]) {
      await assert.rejects(resolveImplementationScope(root, { ...input, allowedDirectories: [dir] }),
        /scope requires|Writer path|Writer directory/);
    }
    await mkdir(join(root, "ignored"));
    await assert.rejects(resolveImplementationScope(root, { ...input, allowedDirectories: ["ignored"] }), /Git-ignored/);
    await assert.rejects(resolveImplementationScope(root, { ...input, delivery: "reviewed" }), /directories require verified/);
    const reviewed = await resolveImplementationScope(root, { ...input, delivery: "reviewed",
      allowedFiles: ["code/parser/index.js"], allowedDirectories: [] });
    assert.deepEqual(reviewed.allowedDirectories, []);
  });
});

test("guard resolves new files within segment boundaries and refuses ignored, linked and pre-existing user paths", async () => {
  await fixture(async root => {
    const scope = { ...grant(root), protectedPaths: ["code/parser/index.js"] };
    const created = join(root, "code/parser/nested/New.java");
    assert.equal(await scopedWriteTarget(root, scope, "code/parser/nested/New.java"), created);
    assert.equal(await scopedWriteTarget(root, scope, created), created);
    for (const path of ["code/parser-extra/New.java", "code/parser", "code/parser/../outside", "code/parser/.pi/local",
      "code/parser/index.js", "code/parser/cache.cache"]) {
      await assert.rejects(scopedWriteTarget(root, scope, path), /blocked|private|ignored/i);
    }
    await symlink("../parser-extra", join(root, "code/parser/linked"));
    await link(join(root, "code/parser/index.js"), join(root, "code/parser/hard.js"));
    for (const path of ["code/parser/linked/New.java", "code/parser/hard.js", "code/Parser/New.java"]) {
      await assert.rejects(scopedWriteTarget(root, scope, path), /blocked|link|canonical/i);
    }
    await mkdir(join(root, "code/parser/submodule"));
    await writeFile(join(root, "code/parser/submodule/.git"), "gitdir: elsewhere");
    await assert.rejects(scopedWriteTarget(root, scope, "code/parser/submodule/New.java"), /nested Git/);
    const violation = envelopeViolation([{ path: "code/parser/New", after: { oldPath: "code/parser-extra/Old" } }],
      [], scope.allowedDirectories);
    assert.deepEqual(violation.paths, ["code/parser-extra/Old"], "rename must authorize both sides");
  });
});

test("writer check uses the real project's ignored local runtime and sees new draft files", async () => {
  await fixture(async root => {
    await writeFile(join(root, "code/parser/new.js"), "draft\n");
    await mkdir(join(root, ".venv/bin"), { recursive: true });
    await symlink(process.execPath, join(root, ".venv/bin/runtime"));
    const output = await runScopedWriterCheck(root, join(root, ".venv"), () =>
      execFileSync("./.venv/bin/runtime", ["-e", "process.stdout.write(require('node:fs').readFileSync('code/parser/new.js'))"],
        { cwd: root, encoding: "utf8" }));
    assert.equal(output, "draft\n");
    await assertScopedWriterChecks(join(root, ".venv"));
  });
});

test("a RED check does not block progress, but a check that changes the candidate does", async () => {
  await fixture(async root => {
    const artifacts = join(root, "ignored");
    await mkdir(artifacts);
    await assert.rejects(runScopedWriterCheck(root, artifacts, () => { throw new Error("expected RED"); }), /expected RED/);
    await assertScopedWriterChecks(artifacts);
    const path = join(root, "code/parser/index.js");
    await assert.rejects(runScopedWriterCheck(root, artifacts, () => writeFile(path, "changed by command\n")), /Preserve the draft/);
    await assert.rejects(assertScopedWriterChecks(artifacts), /Preserve the draft/);
    assert.equal(await readFile(path, "utf8"), "changed by command\n", "do not revert user data");
  });
});
