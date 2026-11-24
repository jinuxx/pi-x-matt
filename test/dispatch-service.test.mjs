import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDispatchService, DISPATCH_RESOURCE } from "../lib/dispatch-service.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function createRepoProject(run) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-matt-service-")));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Test");
    await mkdir(join(dir, ".pi"), { recursive: true });
    await writeFile(join(dir, ".pi", "settings.json"), "{}\n");
    await writeFile(join(dir, "app.js"), "export const a = 1;\n");
    git("add", ".");
    git("commit", "-qm", "init");
    const fixedPoint = git("rev-parse", "HEAD");
    await run(dir, git, fixedPoint);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function createHarness(cwd, { confirm = async () => true, rpc } = {}) {
  const entries = [];
  const events = [];
  const messages = [];
  const notifications = [];
  const rpcCalls = [];
  const pi = {
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    sendUserMessage: (text, opts) => messages.push({ text, opts }),
    events: { emit: (name, data) => events.push({ name, data }) },
  };
  const service = createDispatchService(pi, ROOT, {
    rpc: rpc ?? (async (method, params) => {
      rpcCalls.push({ method, params });
      const asyncDir = await mkdtemp(join(tmpdir(), "pi-matt-async-"));
      return { details: { runId: `run-${rpcCalls.length}`, asyncDir } };
    }),
  });
  const ctx = {
    cwd,
    hasUI: true,
    isProjectTrusted: () => true,
    ui: { confirm, notify: (text, level) => notifications.push({ text, level }) },
    sessionManager: { getSessionId: () => "sess-1", getBranch: () => entries },
  };
  service.start(ctx, "startup");
  return { service, ctx, entries, events, messages, notifications, rpcCalls };
}

test("matt-tdd confirms once per session, allows repeated fresh or resumed dispatches, and supports /matt-reset", async () => {
  await createRepoProject(async (cwd) => {
    let confirmCount = 0;
    const asyncDirs = [];
    const { service, ctx, rpcCalls } = createHarness(cwd, {
      confirm: async () => { confirmCount++; return true; },
      rpc: async (method, params) => {
        rpcCalls.push({ method, params });
        const asyncDir = await mkdtemp(join(tmpdir(), "pi-matt-run-"));
        asyncDirs.push(asyncDir);
        return { details: { runId: `run-${rpcCalls.length}`, asyncDir } };
      },
    });

    try {
      const first = await service.dispatch({
        workflow: "matt-tdd",
        task: "Implement feature A",
        verifyCommands: ["node -e 'process.exit(0)'"],
      }, undefined, ctx);
      assert.equal(confirmCount, 1);
      assert.equal(first.details.authorization, "user-confirmed");

      await service.flush();
      assert.equal(rpcCalls.length, 1);
      assert.equal(rpcCalls[0].params.workflow, DISPATCH_RESOURCE);
      const resolved1 = service.resolve(rpcCalls[0].params.args);
      assert.equal(resolved1.hostCommands.map((c) => c.key).join(","), "implement-claim,verify");

      // While first writer is still running, a second writer in the same project is blocked.
      await assert.rejects(
        () => service.dispatch({ workflow: "matt-tdd", task: "Concurrent writer" }, undefined, ctx),
        /still active/,
      );

      // Mark first writer complete -> second dispatch succeeds immediately with reused grant (no deadlock!).
      await writeFile(join(asyncDirs[0], "status.json"), JSON.stringify({
        runId: "run-1", state: "complete", workflow: { value: [{ key: "implement", ok: true, structuredOutput: { status: "COMPLETE" } }] },
      }));
      await service.completion({ runId: "run-1" });

      const second = await service.dispatch({
        workflow: "matt-tdd",
        task: "Follow-up fix",
        resumeRunId: "writer-child-1",
        verifyCommands: ["node -e 'process.exit(0)'"],
      }, undefined, ctx);
      assert.equal(confirmCount, 1, "reuses session grant without re-prompting");
      assert.equal(second.details.authorization, "reused-session-grant");

      await service.flush();
      const resolved2 = service.resolve(rpcCalls[1].params.args);
      assert.match(resolved2.script, /"resume":"writer-child-1"/);

      // /matt-reset clears stuck active state so a fresh writer can immediately start.
      service.reset("user-reset");
      const third = await service.dispatch({ workflow: "matt-tdd", task: "Fresh start" }, undefined, ctx);
      assert.equal(third.details.queued, true);
      assert.equal(confirmCount, 1, "reset does not revoke session authorization");

      // /matt-revoke cancels queued dispatch and revokes authorization.
      service.revoke("user-cancelled");
      assert.equal(service.authorization.matches(cwd, []), false);
    } finally {
      for (const dir of asyncDirs) await rm(dir, { recursive: true, force: true });
    }
  });
});

test("read-only workflows skip confirmation, support worktree/committed reviewScope and single-axis lanes rerun", async () => {
  await createRepoProject(async (cwd, git, fixedPoint) => {
    let prompted = false;
    const { service, ctx, rpcCalls } = createHarness(cwd, {
      confirm: async () => { prompted = true; return true; },
    });

    // Worktree code review without any UI confirmation
    const wt = await service.dispatch({
      workflow: "matt-code-review",
      task: "Review worktree",
      reviewScope: { kind: "worktree" },
      laneTasks: { standards: "Check standards", spec: "Check spec" },
    }, undefined, { ...ctx, hasUI: false });
    assert.equal(prompted, false);
    assert.equal(wt.details.authorization, "not-required");
    assert.ok(wt.details.reviewEvidencePath);

    // Committed code review with single-axis rerun
    await writeFile(join(cwd, "app.js"), "export const a = 2;\n");
    git("add", "app.js");
    git("commit", "-qm", "update a");

    const committed = await service.dispatch({
      workflow: "matt-code-review",
      task: "Rerun standards only",
      lanes: ["standards"],
      reviewScope: { kind: "committed", fixedPoint },
    }, undefined, { ...ctx, hasUI: false });
    assert.deepEqual(committed.details.lanes.map((lane) => lane.key), ["standards"]);

    await service.flush();
    assert.equal(rpcCalls.length, 2);
    assert.equal(rpcCalls[0].params.workflow, DISPATCH_RESOURCE);
    assert.equal(rpcCalls[1].params.workflow, DISPATCH_RESOURCE);

    const plan2 = service.resolve(rpcCalls[1].params.args);
    assert.equal(plan2.hostCommands.length, 1);
    assert.equal(plan2.hostCommands[0].key, "review-evidence");

    // Pure research workflow runs directly via script without needing workflow resource
    const research = await service.dispatch({ workflow: "matt-research", task: "Check docs" }, undefined, { ...ctx, hasUI: false });
    assert.equal(research.details.authorization, "not-required");
    await service.flush();
    assert.equal(rpcCalls[2].params.workflow, undefined);
    assert.equal(typeof rpcCalls[2].params.script, "string");
  });
});

test("rejects workflow-specific parameter misuse and untrusted projects", async () => {
  await createRepoProject(async (cwd) => {
    const { service, ctx } = createHarness(cwd);
    await assert.rejects(
      () => service.dispatch({ workflow: "matt-research", task: "hi" }, undefined, { ...ctx, isProjectTrusted: () => false }),
      /untrusted/,
    );
    await assert.rejects(
      () => service.dispatch({ workflow: "matt-code-review", task: "hi", resumeRunId: "r1" }, undefined, ctx),
      /resumeRunId only applies to matt-tdd/,
    );
    await assert.rejects(
      () => service.dispatch({ workflow: "matt-tdd", task: "hi", reviewScope: { kind: "worktree" } }, undefined, ctx),
      /reviewScope only applies to matt-code-review/,
    );
  });
});
