import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  authorizeWriterDispatch,
  createDispatchAuthorization,
  normalizeVerifyCommands,
} from "../lib/dispatch-authorization.mjs";
import { findProjectRoot, loadCurrentRegistry, prepareDispatchRequest } from "../lib/dispatcher-core.mjs";
import { resolveReviewWorkflow } from "../lib/review-workflow.mjs";
import { buildDispatchRequest } from "./helpers/dispatch-plan.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function withTempProject(run) {
  const temp = await mkdtemp(join(tmpdir(), "pi-x-matt-dispatcher-"));
  try {
    for (const source of [".pi/agents", ".pi/skills", "skillpacks", "vendor", "config"]) {
      await cp(join(ROOT, source), join(temp, source), { recursive: true });
    }
    await cp(join(ROOT, ".pi", "settings.json"), join(temp, ".pi", "settings.json"));
    await run(temp);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

test("findProjectRoot locates nearest .pi/settings.json and fails outside projects", async () => {
  assert.equal(await findProjectRoot(join(ROOT, "lib")), ROOT);
  const isolated = await mkdtemp(join(tmpdir(), "pi-no-project-"));
  try {
    await assert.rejects(() => findProjectRoot(isolated), /\.pi\/settings\.json/);
  } finally {
    await rm(isolated, { recursive: true, force: true });
  }
});

test("loadCurrentRegistry rejects stale on-disk registry cache", async () => {
  await withTempProject(async (temp) => {
    const registryPath = join(temp, "config", "skill-registry.json");
    const raw = await readFile(registryPath, "utf8");
    await writeFile(registryPath, `${raw}\n`);
    await assert.rejects(() => loadCurrentRegistry(temp), /run npm run registry/);
  });
});

test("session authorization confirms once per project, reuses across dispatches, and prompts only for new verifyCommands", async () => {
  const entries = [];
  const auth = createDispatchAuthorization({ persist: (data) => entries.push({ type: "custom", customType: "pi-x-matt.authorization", data }) });
  auth.start("s1");

  let prompts = 0;
  const ctx = { hasUI: true, ui: { confirm: async () => { prompts++; return true; } } };

  assert.equal(await authorizeWriterDispatch({
    workflowName: "matt-tdd", projectRoot: ROOT, branch: "main", verifyCommands: ["npm test"], ctx, authorization: auth,
  }), "user-confirmed");
  assert.equal(prompts, 1);

  assert.equal(await authorizeWriterDispatch({
    workflowName: "matt-tdd", projectRoot: ROOT, branch: "main", verifyCommands: ["npm test"], ctx: { hasUI: false }, authorization: auth,
  }), "reused-session-grant");
  assert.equal(prompts, 1);

  // Adding a new verifyCommand prompts once more and merges it into the session grant.
  assert.equal(await authorizeWriterDispatch({
    workflowName: "matt-tdd", projectRoot: ROOT, branch: "main", verifyCommands: ["npm test", "npm run lint"], ctx, authorization: auth,
  }), "user-confirmed");
  assert.equal(prompts, 2);

  // Restoring from custom session entries preserves the grant.
  const restored = createDispatchAuthorization();
  restored.start("s1", entries, true);
  assert.equal(restored.matches(ROOT, ["npm test", "npm run lint"]), true);

  restored.revoke("user-cancelled");
  assert.equal(restored.matches(ROOT, []), false);
});

test("authorization fails cleanly without UI or when declined, and validates verifyCommands", async () => {
  const auth = createDispatchAuthorization();
  auth.start("s1");
  await assert.rejects(() => authorizeWriterDispatch({
    workflowName: "matt-tdd", projectRoot: ROOT, ctx: { hasUI: false }, authorization: auth,
  }), /interactive session/);
  await assert.rejects(() => authorizeWriterDispatch({
    workflowName: "matt-tdd", projectRoot: ROOT, ctx: { hasUI: true, ui: { confirm: async () => false } }, authorization: auth,
  }), /not authorized/);

  assert.deepEqual(normalizeVerifyCommands(["npm test", " npm test ", "npm run lint"]), ["npm test", "npm run lint"]);
  assert.throws(() => normalizeVerifyCommands(["bad\ncommand"]), /single-line/);
  assert.throws(() => normalizeVerifyCommands(Array(9).fill("echo hi")), /at most 8/);
});

test("prepareDispatchRequest resolves leaf closures, rejects interaction parents, and supports lane subset filtering", async () => {
  const registry = await loadCurrentRegistry(ROOT);
  assert.throws(
    () => prepareDispatchRequest(registry, registry.skills["matt-grilling"], "hi", ROOT),
    /not a parent orchestration workflow/,
  );

  const review = prepareDispatchRequest(registry, registry.skills["matt-code-review"], "shared", ROOT, {
    lanes: ["standards"],
    laneTasks: { standards: "Check coding rules" },
  });
  assert.deepEqual(review.lanes.map((lane) => lane.key), ["standards"]);
  assert.deepEqual(review.lanes[0].skills, ["review-standards"]);
  assert.match(review.lanes[0].task, /Check coding rules/);

  assert.throws(
    () => prepareDispatchRequest(registry, registry.skills["matt-code-review"], "shared", ROOT, { lanes: ["unknown"] }),
    /unknown lane 'unknown'/,
  );
});

test("buildDispatchRequest supports matt-tdd fresh/resume, verifyCommands, and matt-code-review shared evidence pack", async () => {
  const registry = await loadCurrentRegistry(ROOT);

  const tddFresh = buildDispatchRequest(registry, registry.skills["matt-tdd"], "Implement parser", ROOT, {
    hostControls: { claimCommand: "claim-cmd", verifyCommand: "verify-cmd" },
  });
  assert.deepEqual(tddFresh.lanes.map((lane) => lane.key), ["implement"]);
  assert.deepEqual(tddFresh.lanes[0].skills, ["codebase-design", "tdd-executor"]);
  assert.deepEqual(tddFresh.hostCommands, [
    { key: "implement-claim", command: "claim-cmd" },
    { key: "verify", command: "verify-cmd" },
  ]);
  assert.match(tddFresh.rpcParams.script, /"agent":"matt-worker"/);
  assert.match(tddFresh.rpcParams.script, /runs\.host\("verify"/);

  const tddResume = buildDispatchRequest(registry, registry.skills["matt-tdd"], "Fix failing test", ROOT, {
    resumeRunId: "prev-writer-run",
    hostControls: { claimCommand: "claim-cmd" },
  });
  assert.match(tddResume.rpcParams.script, /"resume":"prev-writer-run"/);
  assert.doesNotMatch(tddResume.rpcParams.script, /"agent":"matt-worker"/);

  const review = buildDispatchRequest(registry, registry.skills["matt-code-review"], "Review diff", ROOT, {
    laneTasks: { standards: "Standards rules", spec: "Spec criteria" },
    hostControls: { evidenceKind: "worktree", evidenceCommand: "collect-cmd", evidencePath: "/tmp/review.md" },
  });
  assert.deepEqual(review.hostCommands, [{ key: "review-evidence", command: "collect-cmd" }]);
  assert.equal(review.reviewEvidencePath, "/tmp/review.md");
  assert.doesNotMatch(review.rpcParams.script, /did not equal 'PASS'/);

  const plans = new Map([["d1", review]]);
  const resolved = resolveReviewWorkflow(plans, { dispatchId: "d1" });
  assert.equal(resolved.script, review.rpcParams.script);
  assert.deepEqual(resolved.hostCommands, review.hostCommands);
  assert.match(resolveReviewWorkflow(plans, { dispatchId: "d1" }).error, /Unknown or expired/);
});
