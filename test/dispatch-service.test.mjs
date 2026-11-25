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

function createHarness(cwd, { rpc } = {}) {
  const entries = [];
  const events = [];
  const messages = [];
  const notifications = [];
  const rpcCalls = [];
  let confirmCalls = 0;
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
    ui: {
      confirm: async () => { confirmCalls++; return true; },
      notify: (text, level) => notifications.push({ text, level }),
    },
    sessionManager: { getSessionId: () => "sess-1", getBranch: () => entries },
  };
  service.start(ctx);
  return { service, ctx, entries, events, messages, notifications, rpcCalls, getConfirmCalls: () => confirmCalls };
}

test("matt-tdd dispatches directly without confirm dialogs, prevents concurrent writers, and supports /matt-reset", async () => {
  await createRepoProject(async (cwd) => {
    const asyncDirs = [];
    const { service, ctx, entries, rpcCalls, getConfirmCalls } = createHarness(cwd, {
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
      }, undefined, { ...ctx, hasUI: false });
      assert.equal(getConfirmCalls(), 0);
      assert.equal(first.details.queued, true);

      await service.flush();
      assert.equal(rpcCalls.length, 1);
      assert.equal(rpcCalls[0].params.workflow, DISPATCH_RESOURCE);
      const resolved1 = service.resolve(rpcCalls[0].params.args);
      assert.equal(resolved1.hostCommands.map((c) => c.key).join(","), "implement-claim,verify");

      // Duplicate subagent:child-status heartbeats with identical timestamp are recorded once.
      service.childStatus({ runId: "run-1", workflowKey: "implement", childRunId: "child-1", status: "started", ts: 1000 });
      service.childStatus({ runId: "run-1", workflowKey: "implement", childRunId: "child-1", status: "started", ts: 1000 });
      service.childStatus({ runId: "run-1", workflowKey: "implement", childRunId: "child-1", status: "completed", ts: 2000 });
      const execEntries = entries
        .map((entry) => entry.data)
        .filter((data) => data.dispatchId === first.details.dispatchId && data.phase === "execution");
      assert.deepEqual(
        execEntries.map(({ state, lane, runId, at }) => ({ state, lane, runId, at })),
        [
          { state: "started", lane: "implement", runId: "child-1", at: 1000 },
          { state: "completed", lane: "implement", runId: "child-1", at: 2000 },
        ],
      );

      // While first writer is still running, a second writer in the same project is blocked.
      await assert.rejects(
        () => service.dispatch({ workflow: "matt-tdd", task: "Concurrent writer" }, undefined, ctx),
        /still active/,
      );

      // Mark first writer complete -> second dispatch with different verifyCommands succeeds immediately without prompts.
      await writeFile(join(asyncDirs[0], "status.json"), JSON.stringify({
        runId: "run-1", state: "complete", workflow: { value: [{ key: "implement", ok: true, structuredOutput: { status: "COMPLETE" } }] },
      }));
      await service.completion({ runId: "run-1" });

      const second = await service.dispatch({
        workflow: "matt-tdd",
        task: "Follow-up fix",
        resumeRunId: " writer-child-1 ",
        verifyCommands: ["node -e 'console.log(1)'"],
      }, undefined, { ...ctx, hasUI: false });
      assert.equal(getConfirmCalls(), 0);
      assert.equal(second.details.queued, true);

      await service.flush();
      const resolved2 = service.resolve(rpcCalls[1].params.args);
      assert.match(resolved2.script, /"resume":"writer-child-1"/);

      // /matt-reset clears stuck active state so a fresh writer can immediately start.
      service.reset("user-reset");
      const third = await service.dispatch({ workflow: "matt-tdd", task: "Fresh start" }, undefined, ctx);
      assert.equal(third.details.queued, true);
    } finally {
      for (const dir of asyncDirs) await rm(dir, { recursive: true, force: true });
    }
  });
});

test("read-only workflows support worktree/committed reviewScope, single-axis lanes rerun, and direct script launch", async () => {
  await createRepoProject(async (cwd, git, fixedPoint) => {
    const { service, ctx, rpcCalls, getConfirmCalls } = createHarness(cwd);

    const wt = await service.dispatch({
      workflow: "matt-code-review",
      task: "Review worktree",
      reviewScope: { kind: "worktree" },
      laneTasks: { standards: "Check standards", spec: "Check spec" },
    }, undefined, { ...ctx, hasUI: false });
    assert.equal(getConfirmCalls(), 0);
    assert.ok(wt.details.reviewEvidencePath);

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

    const research = await service.dispatch({ workflow: "matt-research", task: "Check docs" }, undefined, { ...ctx, hasUI: false });
    assert.equal(research.details.queued, true);
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
      () => service.dispatch({ workflow: "matt-tdd", task: "hi", resumeRunId: "   " }, undefined, ctx),
      /non-empty string/,
    );
    await assert.rejects(
      () => service.dispatch({ workflow: "matt-tdd", task: "hi", reviewScope: { kind: "worktree" } }, undefined, ctx),
      /reviewScope only applies to matt-code-review/,
    );
  });
});

test("autonomous round soft-brake pauses excess rounds on same HEAD, ignores failures, and resets on user input or commit", async () => {
  await createRepoProject(async (cwd, git) => {
    const asyncDirs = [];
    const { service, ctx, rpcCalls, getConfirmCalls } = createHarness(cwd, {
      rpc: async (method, params) => {
        rpcCalls.push({ method, params });
        const asyncDir = await mkdtemp(join(tmpdir(), "pi-matt-budget-"));
        asyncDirs.push(asyncDir);
        return { details: { runId: `run-${rpcCalls.length}`, asyncDir } };
      },
    });

    const settle = async (index, state, workflowValue = [{ key: "implement", ok: true, structuredOutput: { status: "COMPLETE" } }]) => {
      await writeFile(join(asyncDirs[index], "status.json"), JSON.stringify({
        runId: `run-${index + 1}`, state, workflow: { value: workflowValue },
      }));
      await service.completion({ runId: `run-${index + 1}` });
    };

    try {
      // Round 1 failed (e.g. upstream stream disconnect) must NOT consume round budget.
      await service.dispatch({ workflow: "matt-tdd", task: "Attempt 1" }, undefined, ctx);
      await service.flush();
      await settle(0, "failed");

      // Completed rounds 1 and 2 on same HEAD pass cleanly with 0 confirm prompts.
      await service.dispatch({ workflow: "matt-tdd", task: "Round 1" }, undefined, ctx);
      await service.flush();
      await settle(1, "complete");

      await service.dispatch({ workflow: "matt-tdd", task: "Round 2" }, undefined, ctx);
      await service.flush();
      await settle(2, "complete");

      // Autonomous round 3 on same HEAD is soft-paused without throwing or prompting.
      const pausedTdd = await service.dispatch({ workflow: "matt-tdd", task: "Round 3" }, undefined, ctx);
      assert.equal(pausedTdd.details.paused, true);
      assert.equal(pausedTdd.details.reason, "autonomous-round-budget");
      assert.equal(rpcCalls.length, 3);
      assert.equal(getConfirmCalls(), 0);

      // User input resets the streak immediately without any lock or unlock command.
      service.noteUserInput();
      const resumedTdd = await service.dispatch({ workflow: "matt-tdd", task: "User approved fix" }, undefined, ctx);
      assert.equal(resumedTdd.details.queued, true);
      await service.flush();
      await settle(3, "complete");

      // 1 completed code review on same HEAD -> 2nd autonomous review is soft-paused.
      await service.dispatch({ workflow: "matt-code-review", task: "Review 1", reviewScope: { kind: "worktree" } }, undefined, ctx);
      await service.flush();
      await settle(4, "complete", [
        { key: "standards", ok: true, structuredOutput: { verdict: "PASS" } },
        { key: "spec", ok: true, structuredOutput: { verdict: "PASS" } },
      ]);

      const pausedReview = await service.dispatch({ workflow: "matt-code-review", task: "Review 2", reviewScope: { kind: "worktree" } }, undefined, ctx);
      assert.equal(pausedReview.details.paused, true);
      assert.equal(pausedReview.details.reason, "autonomous-round-budget");
      assert.equal(rpcCalls.length, 5);

      // New commit changes HEAD -> budget resets automatically.
      await writeFile(join(cwd, "app.js"), "export const a = 3;\n");
      git("add", "app.js");
      git("commit", "-qm", "next ticket");
      const nextReview = await service.dispatch({ workflow: "matt-code-review", task: "Next HEAD review", reviewScope: { kind: "worktree" } }, undefined, ctx);
      assert.equal(nextReview.details.queued, true);
      assert.equal(getConfirmCalls(), 0);
    } finally {
      for (const dir of asyncDirs) await rm(dir, { recursive: true, force: true });
    }
  });
});
