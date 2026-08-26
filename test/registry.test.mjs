import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildRegistry, serializeRegistry } from "../scripts/generate-registry.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function write(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

test("checked-in registry is deterministic and current", async () => {
  const expected = serializeRegistry(await buildRegistry(ROOT));
  const current = await readFile(join(ROOT, "config", "skill-registry.json"), "utf8");
  assert.equal(current, expected);
});

test("registry captures parent workflows and their private leaves", async () => {
  const registry = await buildRegistry(ROOT);
  assert.deepEqual(Object.keys(registry.skills), [
    "code-review",
    "research",
    "research-executor",
    "review-spec",
    "review-standards",
  ]);
  assert.deepEqual(registry.skills.research.dependsOn, ["research-executor"]);
  assert.equal(registry.skills.research.agent, "researcher");
  assert.equal(registry.skills.research.workflow.mode, "single");
  assert.equal(registry.skills["research-executor"].scope, "leaf");

  const review = registry.skills["code-review"];
  assert.equal(review.workflow.mode, "parallel");
  assert.deepEqual(
    review.workflow.lanes.map(({ key, agent, skills }) => ({ key, agent, skills })),
    [
      { key: "standards", agent: "reviewer", skills: ["review-standards"] },
      { key: "spec", agent: "reviewer", skills: ["review-spec"] },
    ],
  );
  assert.deepEqual(review.dependsOn, ["review-standards", "review-spec"]);
});

test("project package filter keeps only the pi-subagents extension", async () => {
  const settings = JSON.parse(await readFile(join(ROOT, ".pi", "settings.json"), "utf8"));
  assert.equal(settings.subagents.disableBuiltins, true);
  assert.deepEqual(settings.packages, [{
    source: "npm:pi-subagents",
    extensions: ["+index.ts"],
    skills: [],
    prompts: [],
    themes: [],
  }]);
});

test("all project agents are leaf-only and use the private skill path", async () => {
  for (const name of ["reader", "researcher", "reviewer", "worker"]) {
    const content = await readFile(join(ROOT, ".pi", "agents", `${name}.md`), "utf8");
    assert.match(content, /inheritSkills:\s*false/);
    assert.match(content, /skillPath:\s*\.\.\/\.\.\/skillpacks\/leaf/);
    assert.match(content, /maxSubagentDepth:\s*0/);
    assert.doesNotMatch(content.match(/^tools:.*$/m)?.[0] ?? "", /\bsubagent\b/);
  }

  const reviewer = await readFile(join(ROOT, ".pi", "agents", "reviewer.md"), "utf8");
  assert.match(reviewer, /tools:.*\bgit_read\b/);
  assert.match(reviewer, /subagentOnlyExtensions:\s*\.\.\/\.\.\/child-tools\/review-readonly-git\.ts/);
});

test("workflow schemas require structured output and distinct review axes", async () => {
  const registry = await buildRegistry(ROOT);
  const researchLane = registry.skills.research.workflow.lanes[0];
  assert.deepEqual(researchLane.outputSchema.required, ["question", "summary", "findings", "sources", "gaps"]);

  const [standards, spec] = registry.skills["code-review"].workflow.lanes;
  assert.deepEqual(standards.outputSchema.properties.axis.enum, ["standards"]);
  assert.deepEqual(spec.outputSchema.properties.axis.enum, ["spec"]);
  for (const lane of [standards, spec]) {
    assert.equal(lane.timeoutMs, 300000);
    assert.deepEqual(lane.turnBudget, { maxTurns: 12, graceTurns: 2 });
    assert.deepEqual(lane.outputSchema.required, ["axis", "verdict", "summary", "findings", "notes"]);
    assert.equal(lane.outputSchema.properties.findings.items.properties.severity.enum.join(","), "P0,P1,P2");
  }
});

test("registry generation fails closed on a missing dependency", async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-x-matt-registry-"));
  try {
    await cp(join(ROOT, ".pi", "agents"), join(temp, ".pi", "agents"), { recursive: true });
    await cp(join(ROOT, "vendor"), join(temp, "vendor"), { recursive: true });
    await cp(join(ROOT, ".pi", "skills"), join(temp, ".pi", "skills"), { recursive: true });
    const workflowPath = join(temp, ".pi", "skills", "research", "workflow.json");
    const workflow = JSON.parse(await readFile(workflowPath, "utf8"));
    workflow.lanes[0].skills = ["missing-leaf"];
    await write(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`);
    await cp(join(ROOT, "skillpacks"), join(temp, "skillpacks"), { recursive: true });
    await assert.rejects(() => buildRegistry(temp), /missing dependency 'missing-leaf'/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
