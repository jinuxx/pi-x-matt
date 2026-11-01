import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test, { mock } from "node:test";
import { collectReviewEvidence } from "../lib/review-evidence.mjs";
import { prepareDiagnosticWorkspace } from "../lib/diagnostic-workspace.mjs";
import { diagnoseRepair } from "../lib/repair-contract.mjs";
import { failureDetails } from "../lib/dispatch-runtime.mjs";

const exec = promisify(execFile);
const GREEN = [
  'import assert from "node:assert/strict";',
  'import { state } from "./parser.mjs";',
  'assert.ok(["head", "reviewed"].includes(state));',
  "",
].join("\n");
const RED = [
  'import assert from "node:assert/strict";',
  'import { state } from "./parser.mjs";',
  'assert.equal(state, "fixed", "target regression: parser still returns " + state);',
  "",
].join("\n");
const REVIEWED = 'export const state = "reviewed";\n';

function hasCauseCode(error, code) {
  for (let current = error; current; current = current.cause) {
    if (current.code === code) return true;
  }
  return false;
}

async function git(cwd, ...args) {
  return (await exec("git", args, { cwd })).stdout.trim();
}

async function reviewedFixture({ nested = false, linked = false, escape = false } = {}) {
  const parent = await mkdtemp(join(tmpdir(), "matt-diagnosis-fixture-"));
  const repo = join(parent, "repo");
  const checkout = nested ? join(repo, "nested", "pkg") : repo;
  await mkdir(join(checkout, ".pi"), { recursive: true });
  await writeFile(join(checkout, ".pi", "settings.json"), "{}");
  await writeFile(join(checkout, "parser.mjs"), 'export const state = "head";\n');
  await writeFile(join(checkout, "parser.test.mjs"), GREEN);
  await writeFile(join(checkout, "deleted.txt"), "delete me\n");
  await writeFile(join(checkout, "old-name.txt"), "rename me\n");
  await exec("git", ["init", "-q"], { cwd: repo });
  await git(repo, "config", "user.email", "test@example.invalid");
  await git(repo, "config", "user.name", "Test");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "baseline");
  let projectRoot = checkout;
  if (linked) {
    projectRoot = join(parent, "linked");
    await git(repo, "worktree", "add", "-q", projectRoot, "-b", "feature");
  }
  await writeFile(join(projectRoot, "parser.mjs"), REVIEWED);
  await writeFile(join(projectRoot, "untracked.txt"), "reviewed untracked\n");
  await git(projectRoot, "mv", "old-name.txt", "renamed.txt");
  await rm(join(projectRoot, "deleted.txt"));
  await symlink(".", join(projectRoot, "self"));
  if (escape) {
    await mkdir(join(parent, "outside"), { recursive: true });
    await writeFile(join(parent, "outside", "secret.txt"), "secret\n");
    await symlink(join(parent, "outside"), join(projectRoot, "escape"));
  }
  const pack = await collectReviewEvidence(projectRoot);
  assert.equal(pack.complete, true,
    JSON.stringify(pack.manifest.map(({ content: _content, ...entry }) => entry)));
  const packPath = join(parent, "review.json");
  await writeFile(packPath, JSON.stringify(pack));
  const tmpRoot = join(parent, "tmp");
  await mkdir(tmpRoot);
  return {
    parent, project: await realpath(projectRoot), pack, packPath, tmpRoot,
    cleanup: () => rm(parent, { recursive: true, force: true }),
  };
}

function request(f, overrides = {}) {
  return {
    projectRoot: f.project, packPath: f.packPath, reviewedSnapshotId: f.pack.snapshotId,
    scope: { diagnosticFiles: ["parser.test.mjs"] },
    testFiles: [{ path: "parser.test.mjs", content: RED }], tmpRoot: f.tmpRoot, ...overrides,
  };
}

const contract = f => ({
  previousDispatchId: "dispatch-1", previousSnapshotId: f.pack.snapshotId,
  approvedFindingIds: ["spec:parse"], approvedFindings: [], groups: [], counts: {}, needsDiagnosis: ["parser"],
});
const diagnosticScope = {
  diagnosticFiles: ["parser.test.mjs"],
  diagnosticCommands: [
    "node parser.test.mjs", 'node -e ""',
    "node parser.test.mjs; printf tamper >> parser.mjs; exit 1",
    "node parser.test.mjs; printf x >> parser.test.mjs; exit 1",
  ],
};
const diagnosis = overrides => ({
  rootCauseIds: ["parser"], explanation: "reviewed state differs from the expected contract",
  prediction: "parser returns the reviewed state instead of fixed",
  command: "node parser.test.mjs", expectedFailure: "target regression: parser still returns reviewed",
  testFiles: [{ path: "parser.test.mjs", content: RED }], ...overrides,
});
const options = f => ({ reviewedSnapshotPath: f.packPath, reviewedDispatchId: "dispatch-1", tmpRoot: f.tmpRoot });

test("a new approved diagnostic file preserves existing tests and disables Python/pytest cache writes by environment", async () => {
  const f = await reviewedFixture();
  try {
    const path = "tests/repro.test.mjs";
    const command = `node -e "if(process.env.PYTHONDONTWRITEBYTECODE!=='1'||!process.env.PYTEST_ADDOPTS.includes('-p no:cacheprovider'))throw Error('cache policy missing')" && node parser.test.mjs && node ${path}`;
    const scope = { allowedFiles: ["parser.mjs", path], diagnosticFiles: [path], diagnosticCommands: [command] };
    const result = await diagnoseRepair(contract(f), diagnosis({
      command, testFiles: [{ path, content: RED.replace("./parser.mjs", "../parser.mjs") }],
    }), scope, f.project, undefined, undefined, options(f));
    assert.equal(result.diagnosis.exitCode, 1);
    assert.equal(result.diagnosis.isolation.testFiles[0].path, path);
    assert.equal(await readFile(join(f.project, "parser.test.mjs"), "utf8"), GREEN);
    await assert.rejects(() => readFile(join(f.project, path)), { code: "ENOENT" });
    assert.equal((await collectReviewEvidence(f.project)).snapshotId, f.pack.snapshotId);
  } finally { await f.cleanup(); }
});

test("host isolation rebuilds HEAD plus the reviewed worktree and writes only approved inline tests", async () => {
  const f = await reviewedFixture();
  try {
    const workspace = await prepareDiagnosticWorkspace(request(f));
    try {
      assert.notEqual(await realpath(workspace.cwd), f.project);
      assert.ok((await realpath(workspace.cwd)).startsWith(`${await realpath(f.tmpRoot)}/`));
      assert.equal(await readFile(join(workspace.cwd, "parser.mjs"), "utf8"), REVIEWED);
      assert.equal(await readFile(join(workspace.cwd, "parser.test.mjs"), "utf8"), RED);
      assert.equal(await readFile(join(workspace.cwd, "untracked.txt"), "utf8"), "reviewed untracked\n");
      assert.equal(await readFile(join(workspace.cwd, "renamed.txt"), "utf8"), "rename me\n");
      assert.equal((await lstat(join(workspace.cwd, "self"))).isSymbolicLink(), true);
      await assert.rejects(() => readFile(join(workspace.cwd, "deleted.txt")), /ENOENT/);
      await assert.rejects(() => readFile(join(workspace.cwd, "old-name.txt")), /ENOENT/);
      assert.equal(await readFile(join(f.project, "parser.test.mjs"), "utf8"), GREEN);
      assert.equal((await collectReviewEvidence(f.project)).snapshotId, f.pack.snapshotId);
    } finally {
      await workspace.dispose();
    }
    assert.deepEqual(await readdir(f.tmpRoot), []);
  } finally {
    await f.cleanup();
  }
});

test("nested projects and linked worktrees keep their existing call shape", async () => {
  for (const options of [{ nested: true }, { linked: true }]) {
    const f = await reviewedFixture(options);
    try {
      const workspace = await prepareDiagnosticWorkspace(request(f));
      try {
        assert.equal(await readFile(join(workspace.cwd, "parser.mjs"), "utf8"), REVIEWED);
        assert.equal(await readFile(join(workspace.cwd, "parser.test.mjs"), "utf8"), RED);
        assert.equal(await readFile(join(workspace.cwd, "untracked.txt"), "utf8"), "reviewed untracked\n");
      } finally {
        await workspace.dispose();
      }
      assert.deepEqual(await readdir(f.tmpRoot), []);
      assert.equal((await collectReviewEvidence(f.project)).snapshotId, f.pack.snapshotId);
    } finally {
      await f.cleanup();
    }
  }
});

test("inline diagnostic content can only replace exact approved files, never escape through parents or symlinks", async () => {
  const f = await reviewedFixture();
  try {
    const scope = { diagnosticFiles: ["parser.test.mjs", "self/repro.test.mjs"] };
    await assert.rejects(() => prepareDiagnosticWorkspace(request(f, { scope,
      testFiles: [{ path: "other.test.mjs", content: "tamper\n" }] })), /outside implementation.diagnosticFiles/);
    await assert.rejects(() => prepareDiagnosticWorkspace(request(f, {
      testFiles: [{ path: "parser.test.mjs", content: RED }, { path: "parser.test.mjs", content: RED }],
    })), /Duplicate diagnostic test file/);
    await assert.rejects(() => prepareDiagnosticWorkspace(request(f, {
      testFiles: [{ path: "../escape.mjs", content: RED }],
    })), /project-relative/);
    await assert.rejects(() => prepareDiagnosticWorkspace(request(f, { scope,
      testFiles: [{ path: "self/repro.test.mjs", content: RED }] })), /not a real directory/);
    assert.deepEqual(await readdir(f.tmpRoot), []);
    const added = await prepareDiagnosticWorkspace(request(f, {
      scope: { diagnosticFiles: ["test/new.repro.mjs"] },
      testFiles: [{ path: "test/new.repro.mjs", content: RED }],
    }));
    try {
      assert.equal(await readFile(join(added.cwd, "test", "new.repro.mjs"), "utf8"), RED);
    } finally {
      await added.dispose();
    }
    assert.deepEqual(await readdir(f.tmpRoot), []);
  } finally {
    await f.cleanup();
  }
});

test("production sources never enter the isolated diagnostic write set, even when listed", async () => {
  const f = await reviewedFixture();
  try {
    await assert.rejects(() => prepareDiagnosticWorkspace(request(f, {
      scope: { diagnosticFiles: ["parser.mjs"] },
      testFiles: [{ path: "parser.mjs", content: 'export const state = "tampered";\n' }],
    })), /test or fixture/);
    await assert.rejects(() => prepareDiagnosticWorkspace(request(f, {
      scope: { diagnosticFiles: ["parser.mjs", "parser.test.mjs"] },
      testFiles: [{ path: "parser.test.mjs", content: RED }],
    })), /test or fixture/);
    assert.deepEqual(await readdir(f.tmpRoot), []);
    assert.equal(await readFile(join(f.project, "parser.mjs"), "utf8"), REVIEWED);
  } finally {
    await f.cleanup();
  }
});

test("reviewed symlinks that escape the isolated workspace fail closed", async () => {
  const f = await reviewedFixture({ escape: true });
  try {
    await assert.rejects(() => prepareDiagnosticWorkspace(request(f)),
      /escapes the diagnostic workspace/);
    assert.deepEqual(await readdir(f.tmpRoot), []);
    assert.equal((await collectReviewEvidence(f.project)).snapshotId, f.pack.snapshotId);
  } finally {
    await f.cleanup();
  }
});

test("stale, incomplete or foreign reviewed evidence cannot seed an isolated diagnosis", async () => {
  const f = await reviewedFixture();
  try {
    await writeFile(join(f.project, "parser.mjs"), 'export const state = "drift";\n');
    await assert.rejects(() => prepareDiagnosticWorkspace(request(f)),
      /no longer matches the reviewed snapshot/);
    await writeFile(join(f.project, "parser.mjs"), REVIEWED);
    await assert.rejects(() => prepareDiagnosticWorkspace(request(f, { reviewedSnapshotId: "stale" })),
      /stale, incomplete or not host-collected/);
    await writeFile(f.packPath, JSON.stringify({ ...f.pack, complete: false }));
    await assert.rejects(() => prepareDiagnosticWorkspace(request(f)),
      /stale, incomplete or not host-collected/);
    assert.deepEqual(await readdir(f.tmpRoot), []);
  } finally {
    await f.cleanup();
  }
});

test("tampered reviewed pack content cannot be replayed under a trusted snapshot id", async () => {
  const f = await reviewedFixture();
  try {
    const tampered = structuredClone(f.pack);
    const source = tampered.manifest.find(entry => entry.path === "parser.mjs");
    source.content = 'export const state = "tampered";\n';
    source.sha256 = createHash("sha256").update(source.content).digest("hex");
    await writeFile(f.packPath, JSON.stringify(tampered));
    await assert.rejects(() => prepareDiagnosticWorkspace(request(f)), /does not match the host snapshot/);
    assert.deepEqual(await readdir(f.tmpRoot), []);
    await writeFile(f.packPath, JSON.stringify({ ...f.pack, diff: `${f.pack.diff}\nnot reviewed\n` }));
    await assert.rejects(() => prepareDiagnosticWorkspace(request(f)), /diff does not match/);
    assert.deepEqual(await readdir(f.tmpRoot), []);
    assert.equal(await readFile(join(f.project, "parser.mjs"), "utf8"), REVIEWED);
  } finally {
    await f.cleanup();
  }
});

test("isolated diagnosis returns bound RED evidence and leaves the reviewed worktree untouched", async () => {
  const f = await reviewedFixture();
  try {
    const result = await diagnoseRepair(contract(f), diagnosis({
      snapshotId: "model-claimed", cwd: "/tmp/model-cwd", authorized: true,
      evidencePath: "/tmp/model-evidence",
    }), diagnosticScope, f.project, undefined, exec, options(f));
    assert.equal(result.diagnosis.exitCode, 1);
    assert.match(result.diagnosis.outputSha256, /^[0-9a-f]{64}$/);
    assert.equal(result.diagnosis.isolation.reviewedDispatchId, "dispatch-1");
    assert.equal(result.diagnosis.isolation.reviewedSnapshotId, f.pack.snapshotId);
    assert.equal(result.diagnosis.isolation.scopeSha256,
      createHash("sha256").update(JSON.stringify(diagnosticScope)).digest("hex"));
    assert.deepEqual(result.diagnosis.isolation.testFiles,
      [{ path: "parser.test.mjs", sha256: createHash("sha256").update(RED).digest("hex") }]);
    assert.equal(await readFile(join(f.project, "parser.test.mjs"), "utf8"), GREEN);
    assert.equal((await collectReviewEvidence(f.project)).snapshotId, f.pack.snapshotId);
    assert.deepEqual(await readdir(f.tmpRoot), []);
  } finally {
    await f.cleanup();
  }
});

test("isolated diagnosis also preserves an already failing reviewed repro", async () => {
  const f = await reviewedFixture();
  try {
    await writeFile(join(f.project, "parser.test.mjs"), RED);
    f.pack = await collectReviewEvidence(f.project);
    await writeFile(f.packPath, JSON.stringify(f.pack));
    await assert.rejects(() => exec("node", ["parser.test.mjs"], { cwd: f.project }),
      error => error.code === 1 && error.stderr.includes("target regression"));
    const result = await diagnoseRepair(contract(f), diagnosis(), diagnosticScope,
      f.project, undefined, exec, options(f));
    assert.equal(result.diagnosis.exitCode, 1);
    assert.equal((await collectReviewEvidence(f.project)).snapshotId, f.pack.snapshotId);
    assert.deepEqual(await readdir(f.tmpRoot), []);
  } finally {
    await f.cleanup();
  }
});

test("isolated diagnosis returns only exact paths and content hashes, never inline reproduction bodies", async () => {
  const f = await reviewedFixture();
  try {
    const marker = "SYNTHETIC-INLINE-MARKER-6b1f0d9c";
    const content = `${RED}// synthetic inline marker: ${marker}\n`;
    const result = await diagnoseRepair(contract(f), diagnosis({
      testFiles: [{ path: "parser.test.mjs", content }],
    }), diagnosticScope, f.project, undefined, exec, options(f));
    assert.deepEqual(result.diagnosis.isolation.testFiles,
      [{ path: "parser.test.mjs", sha256: createHash("sha256").update(content).digest("hex") }]);
    assert.equal(Object.hasOwn(result.diagnosis.isolation.testFiles[0], "content"), false);
    assert.equal(JSON.stringify(result.diagnosis).includes(marker), false);
  } finally {
    await f.cleanup();
  }
});

test("isolated diagnosis rejects GREEN, other symptoms, production edits and cancellation while cleaning its temp area", async () => {
  const f = await reviewedFixture();
  try {
    for (const [input, error] of [
      [diagnosis({ command: "node -e \"\"" }), /did not reproduce the failure/],
      [diagnosis({ expectedFailure: "never printed" }), /different symptom/],
      [diagnosis({ command: "node parser.test.mjs; printf tamper >> parser.mjs; exit 1" }),
        /outside diagnosticFiles/],
    ]) {
      await assert.rejects(() => diagnoseRepair(contract(f), input, diagnosticScope, f.project,
        undefined, exec, options(f)), error);
      assert.deepEqual(await readdir(f.tmpRoot), []);
    }
    let observed;
    const timedOut = async (_file, _args, runtime) => {
      observed = { ...runtime, realCwd: await realpath(runtime.cwd) };
      throw Object.assign(new Error("phase timed out"), { code: null, killed: true });
    };
    await assert.rejects(() => diagnoseRepair(contract(f), diagnosis(), diagnosticScope, f.project,
      undefined, timedOut, options(f)), /timed out/);
    assert.equal(observed.timeout, 30_000);
    assert.ok(observed.realCwd.startsWith(`${await realpath(f.tmpRoot)}/`));
    assert.deepEqual(await readdir(f.tmpRoot), []);
    const controller = new AbortController();
    const cancelled = async () => {
      controller.abort(new Error("cancelled"));
      throw Object.assign(new Error("cancelled"), {
        code: 1, stdout: "target regression: parser still returns reviewed",
      });
    };
    await assert.rejects(() => diagnoseRepair(contract(f), diagnosis(), diagnosticScope, f.project,
      controller.signal, cancelled, options(f)), /cancel/);
    assert.deepEqual(await readdir(f.tmpRoot), []);
    const aborted = new AbortController();
    aborted.abort(new Error("cancelled"));
    await assert.rejects(() => diagnoseRepair(contract(f), diagnosis(), diagnosticScope, f.project,
      aborted.signal, exec, options(f)), /cancel/);
    assert.deepEqual(await readdir(f.tmpRoot), []);
    const tolerated = await diagnoseRepair(contract(f), diagnosis({
      command: "node parser.test.mjs; printf x >> parser.test.mjs; exit 1",
    }), diagnosticScope, f.project, undefined, exec, options(f));
    assert.equal(tolerated.diagnosis.exitCode, 1);
    assert.deepEqual(await readdir(f.tmpRoot), []);
    assert.equal(await readFile(join(f.project, "parser.test.mjs"), "utf8"), GREEN);
    assert.equal((await collectReviewEvidence(f.project)).snapshotId, f.pack.snapshotId);
  } finally {
    await f.cleanup();
  }
});

test("isolated command failures keep their exit classification without leaking raw output", async () => {
  const f = await reviewedFixture();
  const marker = "SYNTHETIC-RAW-DIAGNOSTIC-MARKER";
  const nonExecutable = "test/not-executable.sh";
  const scopeOf = input => ({
    diagnosticFiles: input.testFiles.map(file => file.path),
    diagnosticCommands: [input.command],
  });
  try {
    for (const [input, expected] of [
      [diagnosis({
        command: `./${nonExecutable}`,
        testFiles: [{ path: nonExecutable, content: "#!/bin/sh\nexit 1\n" }],
      }), error => error.code === 126 && /exit 126/.test(error.message) &&
        /not executable/.test(error.message) && /outputSha256=[0-9a-f]{64}/.test(error.message) &&
        !error.message.includes("Permission denied")],
      [diagnosis({ command: `node -e 'process.stderr.write("${marker}"); process.exit(2)'` }),
        error => error.code === 2 && /exit 2/.test(error.message) &&
          /outputSha256=[0-9a-f]{64}/.test(error.message) &&
          /(verify|inspect|check)/.test(error.message) && /approved command/.test(error.message) &&
          /(parameters|arguments)/.test(error.message) && /exit semantics/.test(error.message) &&
          /(local environment|local runtime|environment)/.test(error.message) &&
          !JSON.stringify(failureDetails(error)).includes(marker)],
      [diagnosis({ expectedFailure: "never printed" }),
        error => /different symptom/.test(error.message) && /interpreter/.test(error.message) &&
          /dependencies/.test(error.message) && /outputSha256=[0-9a-f]{64}/.test(error.message) &&
          error.cause?.code === 1 && !error.message.includes("parser still returns")],
    ]) {
      await assert.rejects(() => diagnoseRepair(contract(f), input, scopeOf(input), f.project,
        undefined, exec, options(f)), expected);
      assert.deepEqual(await readdir(f.tmpRoot), []);
      assert.equal((await collectReviewEvidence(f.project)).snapshotId, f.pack.snapshotId);
    }
    assert.equal(await readFile(join(f.project, "parser.test.mjs"), "utf8"), GREEN);
  } finally {
    await f.cleanup();
  }
});

test("isolated GREEN preserves a structured exit-0 hash and never unlocks the writer", async () => {
  const f = await reviewedFixture();
  const marker = "SYNTHETIC-GREEN-OUTPUT-MARKER";
  const outputSha256 = createHash("sha256").update(`${marker}\n`).digest("hex");
  try {
    const run = async () => ({ stdout: marker, stderr: "" });
    await assert.rejects(() => diagnoseRepair(contract(f), diagnosis(), diagnosticScope, f.project,
      undefined, run, options(f)), error => error.code === 0 &&
      error.outputSha256 === outputSha256 && /did not reproduce the failure/.test(error.message) &&
      error.message.includes(`outputSha256=${outputSha256}`) &&
      !JSON.stringify(failureDetails(error)).includes(marker));
    assert.deepEqual(await readdir(f.tmpRoot), []);
    assert.equal(await readFile(join(f.project, "parser.test.mjs"), "utf8"), GREEN);
    assert.equal((await collectReviewEvidence(f.project)).snapshotId, f.pack.snapshotId);
  } finally {
    await f.cleanup();
  }
});

const PYTHON_RED = [
  "import re",
  "from pathlib import Path",
  "import venv_only_dependency",
  "",
  'assert venv_only_dependency.VALUE == "venv-only"',
  'source = Path("parser.mjs").read_text(encoding="utf-8")',
  'state = re.search(r\'state = "([^"]+)"\', source).group(1)',
  'assert state == "fixed", f"target regression: parser still returns {state}"',
  "",
].join("\n");
const VENV_RUNNER = [
  "from pathlib import Path",
  "import sys",
  "",
  'if __name__ == "__main__":',
  "    script = Path(sys.argv[1])",
  '    exec(compile(script.read_text(encoding="utf-8"), str(script), "exec"),',
  '         {"__name__": "__main__", "__file__": str(script)})',
  "",
].join("\n");

test("approved absolute interpreters reach venv-only dependencies from the isolated cwd", async () => {
  const f = await reviewedFixture();
  try {
    await writeFile(join(f.project, ".gitignore"), ".venv/\n");
    const venv = join(f.project, ".venv");
    await exec("python3", ["-m", "venv", "--without-pip", venv], { timeout: 120_000 });
    const python = join(venv, "bin", "python");
    const sitePackages = (await exec(python, ["-c",
      "import sysconfig; print(sysconfig.get_paths()['purelib'])"], { timeout: 30_000 })).stdout.trim();
    await writeFile(join(sitePackages, "venv_only_dependency.py"), 'VALUE = "venv-only"\n');
    await writeFile(join(sitePackages, "venv_only_runner.py"), VENV_RUNNER);
    f.pack = await collectReviewEvidence(f.project);
    await writeFile(f.packPath, JSON.stringify(f.pack));
    const repro = [{ path: "test/repro.py", content: PYTHON_RED }];
    const isolatedScope = command => ({ diagnosticFiles: ["test/repro.py"], diagnosticCommands: [command] });
    const relative = ".venv/bin/python -B -m venv_only_runner test/repro.py";
    await assert.rejects(() => diagnoseRepair(contract(f), diagnosis({ command: relative, testFiles: repro }),
      isolatedScope(relative), f.project, undefined, exec, options(f)), error => error.code === 127 &&
      /exit 127/.test(error.message) && /interpreter/.test(error.message) &&
      /outputSha256=[0-9a-f]{64}/.test(error.message) &&
      !error.message.includes("No such file or directory"));
    assert.deepEqual(await readdir(f.tmpRoot), []);
    const command = `${python} -B -m venv_only_runner test/repro.py`;
    let observed;
    const run = async (file, args, runtime) => {
      observed = { file, args, cwd: await realpath(runtime.cwd) };
      return exec(file, args, runtime);
    };
    const result = await diagnoseRepair(contract(f), diagnosis({ command, testFiles: repro }),
      isolatedScope(command), f.project, undefined, run, options(f));
    assert.notEqual(observed.cwd, await realpath(f.project));
    assert.ok(observed.cwd.startsWith(`${await realpath(f.tmpRoot)}/`));
    assert.equal(observed.args[1], command);
    assert.equal(result.diagnosis.exitCode, 1);
    assert.equal(result.diagnosis.command, command);
    assert.equal(result.diagnosis.isolation.testFiles[0].path, "test/repro.py");
    assert.equal(await readFile(join(f.project, "parser.test.mjs"), "utf8"), GREEN);
    assert.equal((await collectReviewEvidence(f.project)).snapshotId, f.pack.snapshotId);
    assert.deepEqual(await readdir(f.tmpRoot), []);
  } finally {
    await f.cleanup();
  }
});

test("diagnosis without inline files keeps the original project-root command path", async () => {
  const f = await reviewedFixture();
  try {
    let observed;
    const run = async (_file, _args, runtime) => {
      observed = runtime;
      throw Object.assign(new Error("red"), {
        code: 1, stdout: "target regression: parser still returns reviewed",
      });
    };
    const result = await diagnoseRepair(contract(f), diagnosis({ testFiles: undefined }),
      diagnosticScope, f.project, undefined, run);
    assert.equal(observed.cwd, f.project);
    assert.equal(result.diagnosis.exitCode, 1);
    assert.equal(result.diagnosis.isolation, undefined);
  } finally {
    await f.cleanup();
  }
});

test("original worktree drift during the isolated command is rejected after the run", async () => {
  const f = await reviewedFixture();
  try {
    const command = `printf 'export const state = "drift";\\n' > ${JSON.stringify(join(f.project, "parser.mjs"))}; ` +
      "node parser.test.mjs; exit 1";
    const scope = { diagnosticFiles: ["parser.test.mjs"], diagnosticCommands: [command] };
    await assert.rejects(() => diagnoseRepair(contract(f), diagnosis({ command }), scope, f.project,
      undefined, exec, options(f)), /no longer matches the reviewed snapshot/);
    assert.deepEqual(await readdir(f.tmpRoot), []);
  } finally {
    await f.cleanup();
  }
});

test("isolated diagnosis rejects production file permission changes", async () => {
  const f = await reviewedFixture();
  const originalMode = (await lstat(join(f.project, "parser.mjs"))).mode;
  try {
    const run = async (file, args, runtime) => {
      const path = join(runtime.cwd, "parser.mjs");
      await chmod(path, ((await lstat(path)).mode & 0o777) ^ 0o100);
      return exec(file, args, runtime);
    };
    await assert.rejects(() => diagnoseRepair(contract(f), diagnosis(), diagnosticScope,
      f.project, undefined, run, options(f)), /outside diagnosticFiles/);
    assert.equal((await lstat(join(f.project, "parser.mjs"))).mode, originalMode);
    assert.deepEqual(await readdir(f.tmpRoot), []);
  } finally {
    await f.cleanup();
  }
});

test("workspace preparation preserves both build and cleanup failures", async () => {
  const f = await reviewedFixture();
  const cleanupFailure = Object.assign(new Error("synthetic cleanup failure"), { code: "EACCES" });
  const remove = fs.rm;
  const mocked = mock.method(fs, "rm", async (path, ...args) => {
    if (dirname(String(path)) === f.tmpRoot &&
        String(path).startsWith(join(f.tmpRoot, "pi-matt-diagnosis-"))) throw cleanupFailure;
    return remove(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => prepareDiagnosticWorkspace(request(f, {
      scope: { diagnosticFiles: ["self/repro.test.mjs"] },
      testFiles: [{ path: "self/repro.test.mjs", content: RED }],
    })), error => error instanceof AggregateError &&
      /not a real directory/.test(error.cause?.message) &&
      error.errors[0] === error.cause && error.errors[1] === cleanupFailure);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
    await f.cleanup();
  }
});

test("every isolated command outcome rechecks the original worktree and preserves the failure chain", async () => {
  const f = await reviewedFixture();
  const drift = 'export const state = "drift";\n';
  const restore = () => writeFile(join(f.project, "parser.mjs"), REVIEWED);
  try {
    const greenCommand = `printf 'export const state = "drift";\\n' > ${JSON.stringify(join(f.project, "parser.mjs"))}; ` +
      "node parser.test.mjs; exit 0";
    await assert.rejects(() => diagnoseRepair(contract(f), diagnosis({ command: greenCommand }),
      { diagnosticFiles: ["parser.test.mjs"], diagnosticCommands: [greenCommand] }, f.project,
      undefined, exec, options(f)), error => /did not reproduce the failure/.test(error.message) &&
      /no longer matches the reviewed snapshot/.test(error.message));
    assert.deepEqual(await readdir(f.tmpRoot), []);
    await restore();
    assert.equal((await collectReviewEvidence(f.project)).snapshotId, f.pack.snapshotId);
    const failures = [
      Object.assign(new Error("different symptom"), { code: 1, stdout: "other output" }),
      Object.assign(new Error("timed out"), { code: null, killed: true }),
    ];
    for (const failure of failures) {
      const runner = async () => {
        await writeFile(join(f.project, "parser.mjs"), drift);
        throw failure;
      };
      await assert.rejects(() => diagnoseRepair(contract(f), diagnosis(), diagnosticScope, f.project,
        undefined, runner, options(f)), error => /no longer matches the reviewed snapshot/.test(error.message) &&
        error.message.includes(failure.message) && hasCauseCode(error, failure.code));
      assert.deepEqual(await readdir(f.tmpRoot), []);
      await restore();
    }
    const controller = new AbortController();
    const cancellation = Object.assign(new Error("cancelled"), {
      code: 1, stdout: "target regression: parser still returns reviewed",
    });
    const cancelled = async () => {
      await writeFile(join(f.project, "parser.mjs"), drift);
      controller.abort(cancellation);
      throw cancellation;
    };
    await assert.rejects(() => diagnoseRepair(contract(f), diagnosis(), diagnosticScope, f.project,
      controller.signal, cancelled, options(f)), error => /no longer matches the reviewed snapshot/.test(error.message) &&
      error.message.includes("cancelled") && hasCauseCode(error, cancellation.code));
    assert.deepEqual(await readdir(f.tmpRoot), []);
    await restore();
    assert.equal((await collectReviewEvidence(f.project)).snapshotId, f.pack.snapshotId);
  } finally {
    await f.cleanup();
  }
});
