import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildRegistry, parseSkillFrontmatter, serializeRegistry } from "../scripts/generate-registry.mjs";

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

test("registry uses strict YAML frontmatter like Pi skill discovery", () => {
  const skill = (fields) => `---\nname: example\n${fields}\n---\n\nBody\n`;
  assert.equal(
    parseSkillFrontmatter(skill('description: "Review code: find regressions"')).description,
    "Review code: find regressions",
  );
  for (const fields of ["description: Review code: find regressions", "description: first\ndescription: second"]) {
    assert.throws(
      () => parseSkillFrontmatter(skill(fields), "broken/SKILL.md"),
      /broken\/SKILL\.md: invalid YAML frontmatter/,
    );
  }
});

test("workflow guidance uses Chinese testing terms without renaming the JSON protocol", async () => {
  const registry = await buildRegistry(ROOT);
  for (const skill of Object.values(registry.skills)) {
    assert.doesNotMatch(await readFile(join(ROOT, skill.sourcePath), "utf8"), /\bseams?\b/i, skill.sourcePath);
    for (const lane of skill.workflow?.lanes ?? []) {
      assert.doesNotMatch(lane.taskPrefix, /\bseams?\b/i, `${skill.name}:${lane.key}`);
    }
  }
  for (const path of ["README.md", ".pi/skills/matt-tdd/context-packs.md", ".x-matt/agents/issue-tracker.md"]) {
    assert.doesNotMatch(await readFile(join(ROOT, path), "utf8"), /\bseams?\b/i, path);
  }
  const tdd = registry.skills["matt-tdd"];
  assert.ok("confirmedSeams" in tdd.workflow.lanes[0].outputSchema.properties);
  assert.match(await readFile(join(ROOT, tdd.sourcePath), "utf8"), /测试切入点/);
  assert.match(await readFile(join(ROOT, "skillpacks/leaf/codebase-design/SKILL.md"), "utf8"), /\*\*可替换点\*\*/);
});

test("registry captures all parent workflows, advisory code review, and single-lane TDD", async () => {
  const registry = await buildRegistry(ROOT);
  assert.equal(Object.keys(registry.skills).length, 31);

  const review = registry.skills["matt-code-review"];
  assert.equal(review.workflow.mode, "parallel");
  assert.deepEqual(
    review.workflow.lanes.map(({ key, agent, skills, gate }) => ({ key, agent, skills, gate })),
    [
      { key: "standards", agent: "matt-reviewer", skills: ["review-standards"], gate: undefined },
      { key: "spec", agent: "matt-reviewer", skills: ["review-spec"], gate: undefined },
    ],
  );
  for (const lane of review.workflow.lanes) {
    assert.deepEqual(lane.outputSchema.properties.verdict.enum, ["PASS", "ISSUES", "NO_EVIDENCE"]);
    assert.deepEqual(lane.outputSchema.properties.findings.items.required, [
      "severity", "title", "locations", "trigger", "impact", "evidence", "suggestion",
    ]);
  }

  const tdd = registry.skills["matt-tdd"];
  assert.equal(tdd.workflow.mode, "single");
  assert.equal(tdd.agent, "matt-worker");
  assert.equal(tdd.workflow.lanes[0].timeoutMs, 2700000);
  assert.deepEqual(
    tdd.workflow.lanes.map(({ key, agent, skills, gate }) => ({ key, agent, skills, gate })),
    [{ key: "implement", agent: "matt-worker", skills: ["tdd-executor"], gate: undefined }],
  );
  assert.deepEqual(registry.skills["tdd-executor"].dependsOn, ["codebase-design"]);

  assert.equal(registry.skills["matt-research"].workflow.mode, "single");
  assert.equal(registry.skills["matt-prototype"].workflow.mode, "single");
  assert.equal(registry.skills["architecture-scan"].workflow.mode, "single");
  assert.equal(registry.skills["architecture-design"].workflow.mode, "parallel");
});

test("project settings, manifest, extension and agents keep clean boundaries", async () => {
  const settings = JSON.parse(await readFile(join(ROOT, ".pi", "settings.json"), "utf8"));
  assert.equal(settings.subagents.disableBuiltins, true);
  assert.equal(settings.subagents.projectRootResolution, "nearest");
  assert.equal(settings.packages.length, 1);
  assert.equal(settings.packages[0].source, "npm:pi-subagents@0.90.0");
  assert.equal(settings.packages[0].autoload, false);
  assert.ok(settings.packages[0].extensions.some((entry) => /^[+-]bundle\/index\.js$/.test(entry)));
  assert.deepEqual(settings.packages[0].skills, []);
  assert.deepEqual(settings.packages[0].prompts, []);
  assert.deepEqual(settings.packages[0].themes, []);

  const manifest = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  assert.equal(manifest.name, "pi-x-matt");
  assert.equal(manifest.dependencies["pi-subagents"], "0.90.0");
  assert.deepEqual(manifest.pi.extensions, ["./.pi/extensions/pi-matt-dispatch/index.ts"]);
  const readme = await readFile(join(ROOT, "README.md"), "utf8");
  assert.ok(readme.includes(`git:github.com/jinuxx/pi-x-matt@v${manifest.version}`), "README install tag matches package.json version");

  const extension = await readFile(join(ROOT, ".pi", "extensions", "pi-matt-dispatch", "index.ts"), "utf8");
  assert.match(extension, /createDispatchService\(pi, PACKAGE_ROOT\)/);
  assert.match(extension, /registerWorkflowResource/);
  assert.match(extension, /registerCommand\("matt-reset"/);
  assert.doesNotMatch(extension, /registerCommand\("matt-revoke"/);

  for (const name of ["matt-reader", "matt-researcher", "matt-reviewer", "matt-worker"]) {
    const content = await readFile(join(ROOT, ".pi", "agents", `${name}.md`), "utf8");
    assert.match(content, /inheritSkills:\s*false/);
    assert.match(content, /skillPath:\s*\.\.\/\.\.\/skillpacks\/leaf/);
    assert.match(content, /maxSubagentDepth:\s*0/);
    assert.doesNotMatch(content.match(/^tools:.*$/m)?.[0] ?? "", /\bsubagent\b/);
  }
  const reviewer = await readFile(join(ROOT, ".pi", "agents", "matt-reviewer.md"), "utf8");
  assert.match(reviewer, /tools:.*\bgit_read\b/);
  assert.doesNotMatch(reviewer.match(/^tools:.*$/m)?.[0] ?? "", /\b(edit|write|apply_patch|bash)\b/);
  assert.match(reviewer, /subagentOnlyExtensions:\s*\.\.\/\.\.\/child-tools\/review-readonly-git\.ts/);
});

test("registry generation fails closed on invalid skills, cycles, drift, and multi-writer workflows", async () => {
  await withTempProject(async (temp) => {
    const workflowPath = join(temp, ".pi", "skills", "matt-research", "workflow.json");
    const workflow = JSON.parse(await readFile(workflowPath, "utf8"));
    workflow.lanes[0].skills = ["missing-leaf"];
    await write(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`);
    await assert.rejects(() => buildRegistry(temp), /missing dependency 'missing-leaf'/);
  });

  await withTempProject(async (temp) => {
    const path = join(temp, "skillpacks", "leaf", "research-executor", "SKILL.md");
    await replace(path, "name: research-executor", "name: pi-subagents");
    await assert.rejects(() => buildRegistry(temp), /'pi-subagents' is reserved/);
  });

  await withTempProject(async (temp) => {
    const path = join(temp, "skillpacks", "leaf", "review-spec", "SKILL.md");
    await replace(path, 'pi-depends-on: ""', "pi-depends-on: research-executor");
    await assert.rejects(() => buildRegistry(temp), /targets agent 'matt-researcher', expected 'matt-reviewer'/);
  });

  await withTempProject(async (temp) => {
    const path = join(temp, "skillpacks", "leaf", "research-executor", "SKILL.md");
    await replace(path, 'pi-depends-on: ""', "pi-depends-on: research-executor");
    await assert.rejects(() => buildRegistry(temp), /Skill dependency cycle/);
  });

  await withTempProject(async (temp) => {
    const path = join(temp, "skillpacks", "leaf", "research-executor", "SKILL.md");
    await replace(path, /pi-upstream-sha: [0-9a-f]{40}/.exec(await readFile(path, "utf8"))[0], `pi-upstream-sha: ${"a".repeat(40)}`);
    await assert.rejects(() => buildRegistry(temp), /pi-upstream-sha does not match/);
  });

  await withTempProject(async (temp) => {
    const path = join(temp, ".pi", "skills", "matt-code-review", "workflow.json");
    const workflow = JSON.parse(await readFile(path, "utf8"));
    workflow.lanes[0].agent = "matt-worker";
    workflow.lanes[0].skills = ["tdd-executor"];
    workflow.lanes[1].agent = "matt-worker";
    workflow.lanes[1].skills = ["tdd-executor"];
    await write(path, `${JSON.stringify(workflow, null, 2)}\n`);
    await assert.rejects(() => buildRegistry(temp), /workflow may define at most one writer lane/);
  });

  await withTempProject(async (temp) => {
    const path = join(temp, ".pi", "skills", "matt-grilling", "SKILL.md");
    await replace(path, "pi-dispatch: none", "pi-dispatch: parallel");
    await assert.rejects(() => buildRegistry(temp), /interaction parent metadata\.pi-dispatch must be 'none'/);
  });
});
