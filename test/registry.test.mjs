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

async function withTempProject(run) {
  const temp = await mkdtemp(join(tmpdir(), "pi-x-matt-registry-"));
  try {
    await cp(join(ROOT, ".pi", "agents"), join(temp, ".pi", "agents"), { recursive: true });
    await cp(join(ROOT, "vendor"), join(temp, "vendor"), { recursive: true });
    await cp(join(ROOT, ".pi", "skills"), join(temp, ".pi", "skills"), { recursive: true });
    await cp(join(ROOT, "skillpacks"), join(temp, "skillpacks"), { recursive: true });
    await run(temp);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function replace(path, from, to) {
  const content = await readFile(path, "utf8");
  assert.ok(content.includes(from), `fixture replacement not found in ${path}`);
  await write(path, content.replace(from, to));
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
    "codebase-design",
    "domain-modeling",
    "grill-with-docs",
    "grilling",
    "research",
    "research-executor",
    "review-spec",
    "review-standards",
    "tdd",
    "tdd-executor",
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

  const tdd = registry.skills.tdd;
  assert.equal(tdd.workflow.mode, "pipeline");
  assert.deepEqual(
    tdd.workflow.lanes.map(({ key, stage, agent, skills, gate }) => ({ key, stage, agent, skills, gate })),
    [
      {
        key: "implement",
        stage: 1,
        agent: "worker",
        skills: ["tdd-executor"],
        gate: { field: "status", equals: "COMPLETE", nonEmpty: ["confirmedSeams", "cycles", "changedFiles", "commands"] },
      },
      { key: "standards", stage: 2, agent: "reviewer", skills: ["review-standards"], gate: { field: "verdict", equals: "PASS" } },
      { key: "spec", stage: 2, agent: "reviewer", skills: ["review-spec"], gate: { field: "verdict", equals: "PASS" } },
    ],
  );
  assert.deepEqual(registry.skills["tdd-executor"].dependsOn, ["codebase-design"]);
  assert.equal(registry.skills["codebase-design"].agent, "worker");

  for (const name of ["grilling", "domain-modeling", "grill-with-docs"]) {
    const interaction = registry.skills[name];
    assert.equal(interaction.scope, "parent");
    assert.equal(interaction.class, "interaction");
    assert.equal(interaction.dispatch, "none");
    assert.equal(interaction.agent, null);
    assert.equal(interaction.workflow, undefined);
    assert.equal(interaction.workflowPath, undefined);
  }
  assert.deepEqual(registry.skills["grill-with-docs"].dependsOn, ["grilling", "domain-modeling"]);
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
  assert.doesNotMatch(reviewer.match(/^tools:.*$/m)?.[0] ?? "", /\b(edit|write|bash)\b/);
  assert.match(reviewer, /subagentOnlyExtensions:\s*\.\.\/\.\.\/child-tools\/review-readonly-git\.ts/);
  const gitTool = await readFile(join(ROOT, "child-tools", "review-readonly-git.ts"), "utf8");
  assert.match(gitTool, /"worktree-files"/);
  assert.match(gitTool, /"worktree-diff"/);

  const worker = await readFile(join(ROOT, ".pi", "agents", "worker.md"), "utf8");
  assert.match(worker, /tools:.*\bedit\b/);
  assert.match(worker, /tools:.*\bwrite\b/);
  for (const name of ["reader", "researcher", "reviewer"]) {
    const content = await readFile(join(ROOT, ".pi", "agents", `${name}.md`), "utf8");
    assert.doesNotMatch(content.match(/^tools:.*$/m)?.[0] ?? "", /\b(edit|write)\b/);
  }

  const researcher = await readFile(join(ROOT, ".pi", "agents", "researcher.md"), "utf8");
  assert.doesNotMatch(researcher, /^async:/m);
  assert.doesNotMatch(researcher, /^output:/m);
});

test("interactive parent skills preserve HITL and document boundaries", async () => {
  const grilling = await readFile(join(ROOT, ".pi", "skills", "grilling", "SKILL.md"), "utf8");
  assert.match(grilling, /ask_user_question/);
  assert.match(grilling, /Frontier/);
  assert.match(grilling, /shared understanding/);

  const domain = await readFile(join(ROOT, ".pi", "skills", "domain-modeling", "SKILL.md"), "utf8");
  assert.match(domain, /CONTEXT\.md/);
  assert.match(domain, /ADR gate/);
  assert.match(domain, /架构形状/);
  assert.match(domain, /唯一写者/);

  const combined = await readFile(join(ROOT, ".pi", "skills", "grill-with-docs", "SKILL.md"), "utf8");
  assert.match(combined, /disable-model-invocation:\s*true/);
  assert.match(combined, /pi-depends-on:\s*grilling, domain-modeling/);
  assert.match(combined, /Shared-understanding gate/);
  assert.match(combined, /不要在本 skill 中生成 spec、tickets 或生产实现/);
  assert.match(combined, /wayfinding.*尚未移植/);
});

test("parent workflows require structured completion results", async () => {
  for (const name of ["research", "code-review", "tdd"]) {
    const content = await readFile(join(ROOT, ".pi", "skills", name, "SKILL.md"), "utf8");
    assert.match(content, /structuredOutput/);
    assert.match(content, /fail|失败/);
  }
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

  const [implement, tddStandards, tddSpec] = registry.skills.tdd.workflow.lanes;
  assert.equal(implement.outputSchema.properties.status.enum.join(","), "COMPLETE,BLOCKED");
  assert.deepEqual(implement.gate, {
    field: "status",
    equals: "COMPLETE",
    nonEmpty: ["confirmedSeams", "cycles", "changedFiles", "commands"],
  });
  assert.equal(implement.outputSchema.properties.confirmedSeams.minItems, 1);
  assert.equal(implement.outputSchema.properties.cycles.minItems, 1);
  assert.equal(implement.outputSchema.properties.commands.minItems, 2);
  assert.equal(implement.outputSchema.properties.cycles.items.properties.redEvidence.minLength, 1);
  assert.equal(implement.outputSchema.properties.cycles.items.properties.greenEvidence.minLength, 1);
  assert.deepEqual([implement.stage, tddStandards.stage, tddSpec.stage], [1, 2, 2]);
  assert.deepEqual(tddStandards.gate, { field: "verdict", equals: "PASS" });
  assert.deepEqual(tddSpec.gate, { field: "verdict", equals: "PASS" });
});

test("registry generation fails closed on a missing dependency", async () => {
  await withTempProject(async (temp) => {
    const workflowPath = join(temp, ".pi", "skills", "research", "workflow.json");
    const workflow = JSON.parse(await readFile(workflowPath, "utf8"));
    workflow.lanes[0].skills = ["missing-leaf"];
    await write(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`);
    await assert.rejects(() => buildRegistry(temp), /missing dependency 'missing-leaf'/);
  });
});

test("registry generation rejects duplicate and reserved skill names", async () => {
  await withTempProject(async (temp) => {
    await cp(
      join(temp, "skillpacks", "leaf", "research-executor", "SKILL.md"),
      join(temp, "skillpacks", "leaf", "duplicate", "SKILL.md"),
      { recursive: true },
    );
    await assert.rejects(() => buildRegistry(temp), /Duplicate skill name: research-executor/);
  });

  await withTempProject(async (temp) => {
    const path = join(temp, "skillpacks", "leaf", "research-executor", "SKILL.md");
    await replace(path, "name: research-executor", "name: pi-subagents");
    await assert.rejects(() => buildRegistry(temp), /'pi-subagents' is reserved/);
  });
});

test("registry generation rejects unknown agents and cross-agent dependencies", async () => {
  await withTempProject(async (temp) => {
    const path = join(temp, "skillpacks", "leaf", "research-executor", "SKILL.md");
    await replace(path, "pi-agent: researcher", "pi-agent: missing-agent");
    await assert.rejects(() => buildRegistry(temp), /unknown metadata\.pi-agent 'missing-agent'/);
  });

  await withTempProject(async (temp) => {
    const path = join(temp, "skillpacks", "leaf", "review-spec", "SKILL.md");
    await replace(path, 'pi-depends-on: ""', "pi-depends-on: research-executor");
    await assert.rejects(() => buildRegistry(temp), /targets agent 'researcher', expected 'reviewer'/);
  });
});

test("registry generation rejects dependency cycles and upstream SHA mismatch", async () => {
  await withTempProject(async (temp) => {
    const path = join(temp, "skillpacks", "leaf", "research-executor", "SKILL.md");
    await replace(path, 'pi-depends-on: ""', "pi-depends-on: research-executor");
    await assert.rejects(() => buildRegistry(temp), /Skill dependency cycle: .*research-executor -> research-executor/);
  });

  await withTempProject(async (temp) => {
    const path = join(temp, "skillpacks", "leaf", "research-executor", "SKILL.md");
    await replace(path, /pi-upstream-sha: [0-9a-f]{40}/.exec(await readFile(path, "utf8"))[0], `pi-upstream-sha: ${"0".repeat(40)}`);
    await assert.rejects(() => buildRegistry(temp), /pi-upstream-sha does not match/);
  });
});

test("registry generation rejects invalid interaction parent routing", async () => {
  await withTempProject(async (temp) => {
    const path = join(temp, ".pi", "skills", "grilling", "SKILL.md");
    await replace(path, "pi-dispatch: none", "pi-dispatch: parallel");
    await assert.rejects(() => buildRegistry(temp), /interaction parent metadata\.pi-dispatch must be 'none'/);
  });

  await withTempProject(async (temp) => {
    const path = join(temp, ".pi", "skills", "grill-with-docs", "SKILL.md");
    await replace(path, "pi-depends-on: grilling, domain-modeling", "pi-depends-on: research");
    await assert.rejects(() => buildRegistry(temp), /interaction dependency 'research' must be an interaction parent skill/);
  });

  await withTempProject(async (temp) => {
    const path = join(temp, ".pi", "skills", "grilling", "SKILL.md");
    await replace(path, "pi-class: interaction", "pi-class: interaction\n  pi-agent: worker");
    await assert.rejects(() => buildRegistry(temp), /interaction parent skills must not define metadata\.pi-agent/);
  });

  await withTempProject(async (temp) => {
    const path = join(temp, ".pi", "skills", "research", "SKILL.md");
    await replace(path, "pi-class: orchestration", "pi-class: orchestration\n  pi-dispatch: single");
    await assert.rejects(() => buildRegistry(temp), /orchestration parent skills must not define metadata\.pi-dispatch/);
  });

  await withTempProject(async (temp) => {
    const path = join(temp, ".pi", "skills", "research", "SKILL.md");
    await replace(path, "pi-class: orchestration", "pi-class: orchestration\n  pi-agent: researcher\n  pi-depends-on: research-executor");
    await assert.rejects(() => buildRegistry(temp), /orchestration parent skills must not define metadata\.pi-agent/);
  });
});

test("registry generation rejects weak workflow schemas and invalid leaf dispatch", async () => {
  await withTempProject(async (temp) => {
    const path = join(temp, ".pi", "skills", "research", "workflow.json");
    const workflow = JSON.parse(await readFile(path, "utf8"));
    workflow.lanes[0].outputSchema = {};
    await write(path, `${JSON.stringify(workflow, null, 2)}\n`);
    await assert.rejects(() => buildRegistry(temp), /outputSchema must have type 'object'/);
  });

  await withTempProject(async (temp) => {
    const path = join(temp, "skillpacks", "leaf", "review-spec", "SKILL.md");
    await replace(path, "pi-dispatch: none", "pi-dispatch: parallel");
    await assert.rejects(() => buildRegistry(temp), /leaf metadata\.pi-dispatch must be 'none'/);
  });
});

test("registry generation rejects malformed pipeline stages and gates", async () => {
  await withTempProject(async (temp) => {
    const path = join(temp, ".pi", "skills", "tdd", "workflow.json");
    const workflow = JSON.parse(await readFile(path, "utf8"));
    workflow.lanes[1].stage = 3;
    workflow.lanes[2].stage = 3;
    await write(path, `${JSON.stringify(workflow, null, 2)}\n`);
    await assert.rejects(() => buildRegistry(temp), /pipeline stages must be contiguous/);
  });

  await withTempProject(async (temp) => {
    const path = join(temp, ".pi", "skills", "tdd", "workflow.json");
    const workflow = JSON.parse(await readFile(path, "utf8"));
    workflow.lanes[0].gate.equals = "NOT_DECLARED";
    await write(path, `${JSON.stringify(workflow, null, 2)}\n`);
    await assert.rejects(() => buildRegistry(temp), /gate must match a declared enum value/);
  });

  await withTempProject(async (temp) => {
    const path = join(temp, ".pi", "skills", "tdd", "workflow.json");
    const workflow = JSON.parse(await readFile(path, "utf8"));
    workflow.lanes[0].gate.nonEmpty = ["summary"];
    await write(path, `${JSON.stringify(workflow, null, 2)}\n`);
    await assert.rejects(() => buildRegistry(temp), /gate\.nonEmpty must name unique array properties/);
  });

  await withTempProject(async (temp) => {
    const path = join(temp, ".pi", "skills", "research", "workflow.json");
    const workflow = JSON.parse(await readFile(path, "utf8"));
    workflow.lanes[0].stage = 1;
    await write(path, `${JSON.stringify(workflow, null, 2)}\n`);
    await assert.rejects(() => buildRegistry(temp), /only pipeline lanes may define stage or gate/);
  });
});
