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
    "implement",
    "research",
    "research-executor",
    "review-spec",
    "review-standards",
    "setup-matt-pocock-skills",
    "tdd",
    "tdd-executor",
    "to-spec",
    "to-tickets",
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
  assert.deepEqual(review.workflow.lanes.map((lane) => lane.gate), [
    { field: "verdict", equals: "PASS" },
    { field: "verdict", equals: "PASS" },
  ]);

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

  for (const name of ["setup-matt-pocock-skills", "grilling", "domain-modeling", "grill-with-docs"]) {
    const interaction = registry.skills[name];
    assert.equal(interaction.scope, "parent");
    assert.equal(interaction.class, "interaction");
    assert.equal(interaction.dispatch, "none");
    assert.equal(interaction.agent, null);
    assert.equal(interaction.workflow, undefined);
    assert.equal(interaction.workflowPath, undefined);
  }
  assert.deepEqual(registry.skills["grill-with-docs"].dependsOn, ["grilling", "domain-modeling"]);
  assert.equal(registry.skills["to-spec"].scope, "parent");
  assert.match(registry.skills["to-spec"].description, /parent spec.*spec-ready/);
  assert.equal(registry.skills["to-spec"].class, "interaction");
  assert.equal(registry.skills["to-spec"].dispatch, "none");
  assert.equal(registry.skills["to-spec"].agent, null);
  assert.equal(registry.skills["to-tickets"].scope, "parent");
  assert.equal(registry.skills["to-tickets"].class, "interaction");
  assert.equal(registry.skills["to-tickets"].dispatch, "none");
  assert.equal(registry.skills["to-tickets"].agent, null);
  assert.equal(registry.skills.implement.scope, "parent");
  assert.equal(registry.skills.implement.class, "interaction");
  assert.equal(registry.skills.implement.dispatch, "none");
  assert.equal(registry.skills.implement.agent, null);
  assert.deepEqual(registry.skills.implement.dependsOn, ["domain-modeling"]);
});

test("project package filter keeps only the pi-subagents extension", async () => {
  const settings = JSON.parse(await readFile(join(ROOT, ".pi", "settings.json"), "utf8"));
  assert.equal(settings.subagents.disableBuiltins, true);
  assert.equal(settings.subagents.projectRootResolution, "nearest");
  assert.deepEqual(settings.packages, [{
    source: "npm:pi-subagents",
    extensions: ["+index.ts"],
    skills: [],
    prompts: [],
    themes: [],
  }]);
});

test("project dispatcher defers pi-subagents RPC until turn_end", async () => {
  const extension = await readFile(join(ROOT, ".pi", "extensions", "pi-matt-dispatch", "index.ts"), "utf8");
  assert.match(extension, /const pendingDispatches: PendingDispatch\[\] = \[\]/);
  assert.match(extension, /pi\.on\("turn_end"/);
  assert.match(extension, /pendingDispatches\.push/);
  assert.match(extension, /await requestRpc\(pi, "spawn", dispatch\.rpcParams\)/);
  assert.doesNotMatch(extension, /const result = await requestRpc/);
});

test("repository tracker setup is executable and discoverable by Pi", async () => {
  const agents = await readFile(join(ROOT, "AGENTS.md"), "utf8");
  assert.equal((agents.match(/^## Agent skills$/gm) ?? []).length, 1);
  assert.match(agents, /docs\/agents\/issue-tracker\.md/);
  assert.match(agents, /docs\/agents\/triage-labels\.md/);
  assert.match(agents, /docs\/agents\/domain\.md/);

  const tracker = await readFile(join(ROOT, "docs", "agents", "issue-tracker.md"), "utf8");
  assert.match(tracker, /Issue Tracker: Local Markdown/);
  assert.match(tracker, /\.scratch\/<feature-slug>\/spec\.md/);
  assert.match(tracker, /issues\/<NN>-<slug>\.md/);
  assert.match(tracker, /Type: spec/);
  assert.match(tracker, /Status: spec-ready/);
  assert.match(tracker, /Type: ticket/);
  assert.match(tracker, /Parent:/);
  assert.match(tracker, /Status: ready-for-agent/);
  assert.match(tracker, /Blocked by:/);
  assert.match(tracker, /Status: resolved/);
  assert.match(tracker, /## Comments/);
  assert.match(tracker, /同一个最终提交/);
  assert.match(tracker, /重新读取目标文件/);

  const labels = await readFile(join(ROOT, "docs", "agents", "triage-labels.md"), "utf8");
  assert.match(labels, /`ready-for-agent` \| `ready-for-agent`/);
  assert.match(labels, /`spec-ready`/);
  assert.match(labels, /`resolved`/);
  const domain = await readFile(join(ROOT, "docs", "agents", "domain.md"), "utf8");
  assert.match(domain, /single-context/);
  assert.match(domain, /CONTEXT\.md/);
  assert.match(domain, /docs\/adr\//);
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
  const setup = await readFile(join(ROOT, ".pi", "skills", "setup-matt-pocock-skills", "SKILL.md"), "utf8");
  assert.match(setup, /disable-model-invocation:\s*true/);
  assert.match(setup, /pi-class:\s*interaction/);
  assert.match(setup, /ask_user_question/);
  assert.match(setup, /docs\/agents\/issue-tracker\.md/);
  assert.match(setup, /docs\/agents\/triage-labels\.md/);
  assert.match(setup, /docs\/agents\/domain\.md/);
  assert.match(setup, /不创建远端 issue、label/);
  assert.match(setup, /Pi-only/);
  assert.match(setup, /`spec-ready`、`ready-for-agent` 与 `resolved`/);
  assert.match(setup, /`ready-for-agent` 是 canonical triage role/);
  for (const seed of ["issue-tracker-github.md", "issue-tracker-gitlab.md", "issue-tracker-local.md", "domain.md"]) {
    const relativeSeed = `vendor/mattpocock-skills/skills/engineering/setup-matt-pocock-skills/${seed}`;
    assert.ok(setup.includes(relativeSeed), `setup must reference ${relativeSeed}`);
    await readFile(join(ROOT, relativeSeed), "utf8");
  }

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
  assert.match(combined, /小变更直接进入 `implement`/);

  const toSpec = await readFile(join(ROOT, ".pi", "skills", "to-spec", "SKILL.md"), "utf8");
  assert.match(toSpec, /不重新 interview/);
  assert.match(toSpec, /Seam gate/);
  assert.match(toSpec, /tracker/);
  assert.match(toSpec, /ready-for-agent/);
  assert.match(toSpec, /已移植的 `setup-matt-pocock-skills`/);
  assert.match(toSpec, /docs\/agents\/issue-tracker\.md/);
  assert.match(toSpec, /docs\/agents\/triage-labels\.md/);
  assert.match(toSpec, /Type: spec/);
  assert.match(toSpec, /Status: spec-ready/);
  assert.match(toSpec, /^description:.*parent spec.*spec-ready/m);
  assert.match(toSpec, /尽可能穷举为 numbered user stories/);
  assert.match(toSpec, /`to-tickets` 已移植/);
  assert.match(toSpec, /`implement`，它每次只处理一个已确认 ticket/);
  assert.match(toSpec, /research note/);
  assert.match(toSpec, /外部 runner.*排除 parent spec/);

  assert.match(toSpec, /不要为了“完整”发明用户未确认的需求/);

  const toTickets = await readFile(join(ROOT, ".pi", "skills", "to-tickets", "SKILL.md"), "utf8");
  assert.match(toTickets, /tracer bullet/);
  assert.match(toTickets, /Blocking edges/);
  assert.match(toTickets, /ask_user_question/);
  assert.match(toTickets, /ready-for-agent/);
  assert.match(toTickets, /已移植的 `setup-matt-pocock-skills`/);
  assert.match(toTickets, /docs\/agents\/issue-tracker\.md/);
  assert.match(toTickets, /docs\/agents\/triage-labels\.md/);
  assert.match(toTickets, /wide refactor/i);
  assert.match(toTickets, /native relationship/);
  assert.match(toTickets, /Real tracker issue template/);
  assert.match(toTickets, /Type: ticket/);
  assert.match(toTickets, /^Parent:/m);
  assert.match(toTickets, /## Comments/);
  assert.match(toTickets, /Blocked by: <ticket 路径\/编号/);
  assert.match(toTickets, /## Parent/);
  assert.match(toTickets, /## Acceptance criteria/);
  assert.match(toTickets, /`implement` 已移植/);
  assert.match(toTickets, /每次只处理一个 ticket/);

  const implement = await readFile(join(ROOT, ".pi", "skills", "implement", "SKILL.md"), "utf8");
  assert.match(implement, /一个 ticket/);
  assert.match(implement, /workflow`: `tdd`/);
  assert.match(implement, /workflow`: `code-review`/);
  assert.match(implement, /当前 branch/);
  assert.match(implement, /不 push/);
  assert.match(implement, /只处理一个 ticket/);
  assert.match(implement, /contact_supervisor/);
  assert.match(implement, /domain-modeling/);
  assert.match(implement, /Status: resolved/);
  assert.match(implement, /同一提交/);
  assert.match(implement, /blocker.*Type: ticket.*Status: resolved/);
  assert.match(implement, /spec-ready.*必须先进入 `to-tickets`/);

  const tdd = await readFile(join(ROOT, ".pi", "skills", "tdd", "SKILL.md"), "utf8");
  assert.match(tdd, /没有明确 spec\/验收行为时停止/);

  const research = await readFile(join(ROOT, ".pi", "skills", "research", "SKILL.md"), "utf8");
  assert.match(research, /跨会话证据/);
  assert.match(research, /research note/);

  const readme = await readFile(join(ROOT, "README.md"), "utf8");
  assert.match(readme, /7 个交互式 parent/);
  assert.match(readme, /交互式 parent（`setup-matt-pocock-skills`、`grilling`、`domain-modeling`、`grill-with-docs`、`to-spec`、`to-tickets`、`implement`）/);
  assert.match(readme, /`setup-matt-pocock-skills`、`grilling`、`domain-modeling`、`grill-with-docs`、`to-spec`、`to-tickets` 和 `implement` 是 `dispatch: none`/);
  assert.match(readme, /首次使用发布链前运行 `setup-matt-pocock-skills`/);
  assert.match(readme, /spec-ready.*ready-for-agent.*resolved/);
  assert.match(readme, /interaction parent 本身不定义 `workflow\.json`/);
  assert.match(readme, /`implement`.*调用 `tdd` 和 `code-review`/);
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
  assert.deepEqual(implement.turnBudget, { maxTurns: 36, graceTurns: 4 });
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

test("registry generation rejects upstream paths outside the vendored root", async () => {
  await withTempProject(async (temp) => {
    const path = join(temp, ".pi", "skills", "research", "SKILL.md");
    await replace(path, "pi-upstream-path: skills/engineering/research/SKILL.md", "pi-upstream-path: ../../outside.md");
    await assert.rejects(() => buildRegistry(temp), /Upstream path for 'research'.*inside the project root/);
  });
});

test("registry generation permits at most one declared writer lane", async () => {
  await withTempProject(async (temp) => {
    const path = join(temp, ".pi", "skills", "tdd", "workflow.json");
    const workflow = JSON.parse(await readFile(path, "utf8"));
    workflow.lanes[1].agent = "worker";
    workflow.lanes[1].skills = ["tdd-executor"];
    await write(path, `${JSON.stringify(workflow, null, 2)}\n`);
    await assert.rejects(() => buildRegistry(temp), /workflow may define at most one writer lane/);
  });

  await withTempProject(async (temp) => {
    const path = join(temp, ".pi", "agents", "worker.md");
    await replace(path, "acceptanceRole: writer", "acceptanceRole: unknown");
    await assert.rejects(() => buildRegistry(temp), /acceptanceRole must be 'writer' or 'read-only'/);
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
    await assert.rejects(() => buildRegistry(temp), /only pipeline lanes may define stage/);
  });

  await withTempProject(async (temp) => {
    const path = join(temp, ".pi", "skills", "research", "workflow.json");
    const workflow = JSON.parse(await readFile(path, "utf8"));
    workflow.lanes[0].gate = { field: "missing", equals: "PASS" };
    await write(path, `${JSON.stringify(workflow, null, 2)}\n`);
    await assert.rejects(() => buildRegistry(temp), /lane 'research' has an invalid gate/);
  });
});
