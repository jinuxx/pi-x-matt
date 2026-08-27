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
    "architecture-deepening-reader",
    "architecture-design",
    "architecture-html-report",
    "architecture-interface-design",
    "architecture-scan",
    "architecture-scan-executor",
    "architecture-vocabulary-reader",
    "codebase-design",
    "matt-code-review",
    "matt-diagnosing-bugs",
    "matt-domain-modeling",
    "matt-grill-with-docs",
    "matt-grilling",
    "matt-implement",
    "matt-improve-codebase-architecture",
    "matt-prototype",
    "matt-research",
    "matt-setup",
    "matt-tdd",
    "matt-to-spec",
    "matt-to-tickets",
    "matt-wayfinder",
    "prototype-executor",
    "prototype-logic",
    "prototype-ui",
    "research-executor",
    "review-spec",
    "review-standards",
    "tdd-executor",
  ]);
  assert.deepEqual(registry.skills["matt-research"].dependsOn, ["research-executor"]);
  assert.equal(registry.skills["matt-research"].agent, "matt-researcher");
  assert.equal(registry.skills["matt-research"].workflow.mode, "single");
  assert.equal(registry.skills["research-executor"].scope, "leaf");

  const review = registry.skills["matt-code-review"];
  assert.equal(review.workflow.mode, "parallel");
  assert.deepEqual(
    review.workflow.lanes.map(({ key, agent, skills }) => ({ key, agent, skills })),
    [
      { key: "standards", agent: "matt-reviewer", skills: ["review-standards"] },
      { key: "spec", agent: "matt-reviewer", skills: ["review-spec"] },
    ],
  );
  assert.deepEqual(review.dependsOn, ["review-standards", "review-spec"]);
  assert.deepEqual(review.workflow.lanes.map((lane) => lane.gate), [
    { field: "verdict", equals: "PASS" },
    { field: "verdict", equals: "PASS" },
  ]);

  const tdd = registry.skills["matt-tdd"];
  assert.equal(tdd.workflow.mode, "pipeline");
  assert.deepEqual(
    tdd.workflow.lanes.map(({ key, stage, agent, skills, gate }) => ({ key, stage, agent, skills, gate })),
    [
      {
        key: "implement",
        stage: 1,
        agent: "matt-worker",
        skills: ["tdd-executor"],
        gate: { field: "status", equals: "COMPLETE", nonEmpty: ["confirmedSeams", "cycles", "changedFiles", "commands"] },
      },
      { key: "standards", stage: 2, agent: "matt-reviewer", skills: ["review-standards"], gate: { field: "verdict", equals: "PASS" } },
      { key: "spec", stage: 2, agent: "matt-reviewer", skills: ["review-spec"], gate: { field: "verdict", equals: "PASS" } },
    ],
  );
  assert.deepEqual(registry.skills["tdd-executor"].dependsOn, ["codebase-design"]);
  assert.equal(registry.skills["codebase-design"].agent, "matt-worker");

  const prototype = registry.skills["matt-prototype"];
  assert.equal(prototype.scope, "parent");
  assert.equal(prototype.class, "orchestration");
  assert.equal(prototype.agent, "matt-worker");
  assert.equal(prototype.dispatch, "single");
  assert.deepEqual(prototype.dependsOn, ["prototype-executor"]);
  assert.equal(prototype.workflow.lanes[0].key, "prototype");
  assert.equal(prototype.workflow.lanes[0].agent, "matt-worker");
  assert.match(prototype.workflow.lanes[0].taskPrefix, /不要 stage、commit、push/);
  assert.deepEqual(prototype.workflow.lanes[0].skills, ["prototype-executor"]);
  assert.deepEqual(registry.skills["prototype-executor"].dependsOn, ["prototype-logic", "prototype-ui"]);
  for (const name of ["prototype-executor", "prototype-logic", "prototype-ui"]) {
    assert.equal(registry.skills[name].scope, "leaf");
    assert.equal(registry.skills[name].class, "executor");
    assert.equal(registry.skills[name].agent, "matt-worker");
  }

  const architectureScan = registry.skills["architecture-scan"];
  assert.equal(architectureScan.class, "orchestration");
  assert.equal(architectureScan.dispatch, "single");
  assert.equal(architectureScan.agent, "matt-worker");
  assert.deepEqual(architectureScan.dependsOn, ["architecture-scan-executor"]);
  assert.deepEqual(architectureScan.workflow.lanes.map(({ key, agent, skills }) => ({ key, agent, skills })), [
    { key: "scan", agent: "matt-worker", skills: ["architecture-scan-executor"] },
  ]);
  assert.deepEqual(registry.skills["architecture-scan-executor"].dependsOn, ["codebase-design", "architecture-html-report"]);
  for (const name of ["architecture-scan-executor", "architecture-html-report"]) {
    assert.equal(registry.skills[name].agent, "matt-worker");
  }

  const architectureDesign = registry.skills["architecture-design"];
  assert.equal(architectureDesign.class, "orchestration");
  assert.equal(architectureDesign.dispatch, "parallel");
  assert.equal(architectureDesign.agent, "matt-reader");
  assert.deepEqual(architectureDesign.workflow.lanes.map(({ key, agent, skills }) => ({ key, agent, skills })), [
    { key: "minimal", agent: "matt-reader", skills: ["architecture-interface-design"] },
    { key: "flexible", agent: "matt-reader", skills: ["architecture-interface-design"] },
    { key: "common-caller", agent: "matt-reader", skills: ["architecture-interface-design"] },
  ]);
  assert.deepEqual(registry.skills["architecture-interface-design"].dependsOn, ["architecture-vocabulary-reader", "architecture-deepening-reader"]);
  for (const name of ["architecture-interface-design", "architecture-vocabulary-reader", "architecture-deepening-reader"]) {
    assert.equal(registry.skills[name].scope, "leaf");
    assert.equal(registry.skills[name].class, "executor");
    assert.equal(registry.skills[name].agent, "matt-reader");
  }

  for (const name of ["matt-setup", "matt-grilling", "matt-domain-modeling", "matt-grill-with-docs"]) {
    const interaction = registry.skills[name];
    assert.equal(interaction.scope, "parent");
    assert.equal(interaction.class, "interaction");
    assert.equal(interaction.dispatch, "none");
    assert.equal(interaction.agent, null);
    assert.equal(interaction.workflow, undefined);
    assert.equal(interaction.workflowPath, undefined);
  }
  assert.deepEqual(registry.skills["matt-grill-with-docs"].dependsOn, ["matt-grilling", "matt-domain-modeling"]);
  assert.equal(registry.skills["matt-to-spec"].scope, "parent");
  assert.match(registry.skills["matt-to-spec"].description, /parent spec.*spec-ready/);
  assert.equal(registry.skills["matt-to-spec"].class, "interaction");
  assert.equal(registry.skills["matt-to-spec"].dispatch, "none");
  assert.equal(registry.skills["matt-to-spec"].agent, null);
  assert.equal(registry.skills["matt-to-tickets"].scope, "parent");
  assert.equal(registry.skills["matt-to-tickets"].class, "interaction");
  assert.equal(registry.skills["matt-to-tickets"].dispatch, "none");
  assert.equal(registry.skills["matt-to-tickets"].agent, null);
  assert.equal(registry.skills["matt-implement"].scope, "parent");
  assert.equal(registry.skills["matt-implement"].class, "interaction");
  assert.equal(registry.skills["matt-implement"].dispatch, "none");
  assert.equal(registry.skills["matt-implement"].agent, null);
  assert.deepEqual(registry.skills["matt-implement"].dependsOn, ["matt-domain-modeling"]);
  assert.equal(registry.skills["matt-diagnosing-bugs"].scope, "parent");
  assert.equal(registry.skills["matt-diagnosing-bugs"].class, "interaction");
  assert.equal(registry.skills["matt-diagnosing-bugs"].dispatch, "none");
  assert.equal(registry.skills["matt-diagnosing-bugs"].agent, null);
  assert.deepEqual(registry.skills["matt-diagnosing-bugs"].dependsOn, ["matt-implement"]);
  assert.equal(registry.skills["matt-wayfinder"].scope, "parent");
  assert.equal(registry.skills["matt-wayfinder"].class, "interaction");
  assert.equal(registry.skills["matt-wayfinder"].dispatch, "none");
  assert.equal(registry.skills["matt-wayfinder"].agent, null);
  assert.deepEqual(registry.skills["matt-wayfinder"].dependsOn, ["matt-grilling", "matt-domain-modeling", "matt-to-spec"]);
  assert.equal(registry.skills["matt-improve-codebase-architecture"].scope, "parent");
  assert.equal(registry.skills["matt-improve-codebase-architecture"].class, "interaction");
  assert.equal(registry.skills["matt-improve-codebase-architecture"].dispatch, "none");
  assert.equal(registry.skills["matt-improve-codebase-architecture"].agent, null);
  assert.deepEqual(registry.skills["matt-improve-codebase-architecture"].dependsOn, ["matt-grilling", "matt-domain-modeling"]);
});

test("project package filter keeps only the pi-subagents extension", async () => {
  const settings = JSON.parse(await readFile(join(ROOT, ".pi", "settings.json"), "utf8"));
  assert.equal(settings.subagents.disableBuiltins, true);
  assert.equal(settings.subagents.projectRootResolution, "nearest");
  assert.equal(settings.subagents.agentOverrides, undefined);
  assert.deepEqual(settings.packages, [{
    source: "npm:pi-subagents@0.57.0",
    autoload: false,
    extensions: ["+index.ts"],
    skills: [],
    prompts: [],
    themes: [],
  }]);
});

test("package manifest exposes namespaced resources", async () => {
  const manifest = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  assert.equal(manifest.name, "pi-x-matt");
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.private, true);
  assert.equal(manifest.license, "MIT");
  assert.deepEqual(manifest.pi.extensions, ["./.pi/extensions/pi-matt-dispatch/index.ts"]);
  assert.deepEqual(manifest.pi.skills, [
    "./.pi/skills/matt-code-review",
    "./.pi/skills/matt-diagnosing-bugs",
    "./.pi/skills/matt-domain-modeling",
    "./.pi/skills/matt-grill-with-docs",
    "./.pi/skills/matt-grilling",
    "./.pi/skills/matt-implement",
    "./.pi/skills/matt-improve-codebase-architecture",
    "./.pi/skills/matt-prototype",
    "./.pi/skills/matt-research",
    "./.pi/skills/matt-setup",
    "./.pi/skills/matt-tdd",
    "./.pi/skills/matt-to-spec",
    "./.pi/skills/matt-to-tickets",
    "./.pi/skills/matt-wayfinder",
  ]);
  assert.deepEqual(manifest.pi.subagents.agents, ["./.pi/agents"]);
  assert.equal(manifest.repository.url, "git+https://github.com/jinuxx/pi-x-matt.git");
  assert.ok(manifest.files.includes(".pi/skills"));
  assert.ok(manifest.files.includes("vendor"));
  assert.ok(manifest.files.includes("child-tools"));
});

test("dispatcher keeps the package root in the extension", async () => {
  const extension = await readFile(join(ROOT, ".pi", "extensions", "pi-matt-dispatch", "index.ts"), "utf8");
  assert.match(extension, /const PACKAGE_ROOT = resolve\(dirname\(fileURLToPath\(import\.meta\.url\)\), "\.\.\/\.\.\/\.\."\)/);
  assert.match(extension, /loadCurrentRegistry\(PACKAGE_ROOT\)/);
});

test("project dispatcher defers pi-subagents RPC until turn_end", async () => {
  const extension = await readFile(join(ROOT, ".pi", "extensions", "pi-matt-dispatch", "index.ts"), "utf8");
  assert.match(extension, /const pendingDispatches: PendingDispatch\[\] = \[\]/);
  assert.match(extension, /pi\.on\("turn_end"/);
  assert.match(extension, /pendingDispatches\.push/);
  assert.match(extension, /const PACKAGE_ROOT = resolve\(dirname\(fileURLToPath\(import\.meta\.url\)\), "\.\.\/\.\.\/\.\."\)/);
  assert.match(extension, /loadCurrentRegistry\(PACKAGE_ROOT\)/);
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
  assert.match(tracker, /不接受裸编号、标题或绝对路径/);
  assert.match(tracker, /Parent.*存在性 preflight/);
  assert.match(tracker, /当前会话单 slice.*`None`/);
  assert.match(tracker, /Type: spec.*Status: spec-ready/);
  assert.match(tracker, /Status: resolved/);
  assert.match(tracker, /## Comments/);
  assert.match(tracker, /同一个最终提交/);
  assert.match(tracker, /重新读取目标文件/);
  assert.match(tracker, /## Wayfinding operations/);
  assert.match(tracker, /\.scratch\/<effort>\/map\.md/);
  assert.match(tracker, /decisions\/<NN>-<slug>\.md/);
  assert.match(tracker, /Type: wayfinder-map/);
  assert.match(tracker, /Status: active/);
  assert.match(tracker, /Claimed by:/);
  assert.match(tracker, /pi:<PI_SESSION_ID>/);
  assert.match(tracker, /PI_SESSION_ID.*必须非空/);
  assert.match(tracker, /Status: cleared/);
  assert.match(tracker, /Frontier/);
  assert.match(tracker, /\*\*Release\*\*.*Status: open.*Claimed by: None/);
  assert.match(tracker, /implementation.*`issues\/` 冲突/);

  const labels = await readFile(join(ROOT, "docs", "agents", "triage-labels.md"), "utf8");
  assert.match(labels, /`ready-for-agent` \| `ready-for-agent`/);
  assert.match(labels, /`spec-ready`/);
  assert.match(labels, /`resolved`/);
  assert.match(labels, /`active` \/ `cleared`/);
  assert.match(labels, /`open` \/ `claimed` \/ `resolved` \/ `out-of-scope`/);
  const domain = await readFile(join(ROOT, "docs", "agents", "domain.md"), "utf8");
  assert.match(domain, /single-context/);
  assert.match(domain, /CONTEXT\.md/);
  assert.match(domain, /docs\/adr\//);
});

test("all project agents are leaf-only and use the private skill path", async () => {
  for (const name of ["matt-reader", "matt-researcher", "matt-reviewer", "matt-worker"]) {
    const content = await readFile(join(ROOT, ".pi", "agents", `${name}.md`), "utf8");
    assert.match(content, /inheritSkills:\s*false/);
    assert.match(content, /skillPath:\s*\.\.\/\.\.\/skillpacks\/leaf/);
    assert.match(content, /maxSubagentDepth:\s*0/);
    assert.doesNotMatch(content.match(/^tools:.*$/m)?.[0] ?? "", /\bsubagent\b/);
  }

  const reviewer = await readFile(join(ROOT, ".pi", "agents", "matt-reviewer.md"), "utf8");
  assert.match(reviewer, /tools:.*\bgit_read\b/);
  assert.doesNotMatch(reviewer.match(/^tools:.*$/m)?.[0] ?? "", /\b(edit|write|bash)\b/);
  assert.match(reviewer, /subagentOnlyExtensions:\s*\.\.\/\.\.\/child-tools\/review-readonly-git\.ts/);
  const gitTool = await readFile(join(ROOT, "child-tools", "review-readonly-git.ts"), "utf8");
  assert.match(gitTool, /"worktree-files"/);
  assert.match(gitTool, /"worktree-diff"/);

  const worker = await readFile(join(ROOT, ".pi", "agents", "matt-worker.md"), "utf8");
  assert.match(worker, /tools:.*\bedit\b/);
  assert.match(worker, /tools:.*\bwrite\b/);
  for (const name of ["matt-reader", "matt-researcher", "matt-reviewer"]) {
    const content = await readFile(join(ROOT, ".pi", "agents", `${name}.md`), "utf8");
    assert.doesNotMatch(content.match(/^tools:.*$/m)?.[0] ?? "", /\b(edit|write)\b/);
  }

  const researcher = await readFile(join(ROOT, ".pi", "agents", "matt-researcher.md"), "utf8");
  assert.doesNotMatch(researcher, /^async:/m);
  assert.doesNotMatch(researcher, /^output:/m);
});

test("interactive parent skills preserve HITL and document boundaries", async () => {
  const setup = await readFile(join(ROOT, ".pi", "skills", "matt-setup", "SKILL.md"), "utf8");
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
  assert.match(setup, /Wayfinding operations/);
  assert.match(setup, /claim、release、resolve、out-of-scope、fog graduation/);
  assert.match(setup, /Wayfinding artifacts.*独立/);
  assert.doesNotMatch(setup, /尚未移植的 wayfinder/);
  assert.match(setup, /setup 所需的 tracker、label、domain 和 Wayfinding 行为契约内置/);
  assert.doesNotMatch(setup, /vendor\/mattpocock-skills/);

  const grilling = await readFile(join(ROOT, ".pi", "skills", "matt-grilling", "SKILL.md"), "utf8");
  assert.match(grilling, /ask_user_question/);
  assert.match(grilling, /Frontier/);
  assert.match(grilling, /shared understanding/);

  const domain = await readFile(join(ROOT, ".pi", "skills", "matt-domain-modeling", "SKILL.md"), "utf8");
  assert.match(domain, /CONTEXT\.md/);
  assert.match(domain, /ADR gate/);
  assert.match(domain, /架构形状/);
  assert.match(domain, /唯一写者/);

  const combined = await readFile(join(ROOT, ".pi", "skills", "matt-grill-with-docs", "SKILL.md"), "utf8");
  assert.match(combined, /disable-model-invocation:\s*true/);
  assert.match(combined, /pi-depends-on:\s*matt-grilling, matt-domain-modeling/);
  assert.match(combined, /Shared-understanding gate/);
  assert.match(combined, /不要在本 skill 中生成 spec、tickets 或生产实现/);
  assert.match(combined, /已移植的手动 `matt-wayfinder`/);
  assert.match(combined, /小变更直接进入 `matt-implement`/);

  const toSpec = await readFile(join(ROOT, ".pi", "skills", "matt-to-spec", "SKILL.md"), "utf8");
  assert.match(toSpec, /不重新 interview/);
  assert.match(toSpec, /Seam gate/);
  assert.match(toSpec, /tracker/);
  assert.match(toSpec, /ready-for-agent/);
  assert.match(toSpec, /已移植的 `matt-setup`/);
  assert.match(toSpec, /docs\/agents\/issue-tracker\.md/);
  assert.match(toSpec, /docs\/agents\/triage-labels\.md/);
  assert.match(toSpec, /Type: spec/);
  assert.match(toSpec, /Status: spec-ready/);
  assert.match(toSpec, /^description:.*parent spec.*spec-ready/m);
  assert.match(toSpec, /尽可能穷举为 numbered user stories/);
  assert.match(toSpec, /`matt-to-tickets` 已移植/);
  assert.match(toSpec, /`matt-implement`，它每次只处理一个已确认 ticket/);
  assert.match(toSpec, /research note/);
  assert.match(toSpec, /外部 runner.*排除 parent spec/);
  assert.match(toSpec, /Type: wayfinder-map/);
  assert.match(toSpec, /Status: cleared/);
  assert.match(toSpec, /Decisions so far/);
  assert.match(toSpec, /linked resolved ticket/);

  assert.match(toSpec, /不要为了“完整”发明用户未确认的需求/);

  const toTickets = await readFile(join(ROOT, ".pi", "skills", "matt-to-tickets", "SKILL.md"), "utf8");
  assert.match(toTickets, /tracer bullet/);
  assert.match(toTickets, /Blocking edges/);
  assert.match(toTickets, /ask_user_question/);
  assert.match(toTickets, /ready-for-agent/);
  assert.match(toTickets, /已移植的 `matt-setup`/);
  assert.match(toTickets, /docs\/agents\/issue-tracker\.md/);
  assert.match(toTickets, /docs\/agents\/triage-labels\.md/);
  assert.match(toTickets, /wide refactor/i);
  assert.match(toTickets, /native relationship/);
  assert.match(toTickets, /Real tracker issue template/);
  assert.match(toTickets, /Type: ticket/);
  assert.match(toTickets, /^Parent:/m);
  assert.match(toTickets, /## Comments/);
  assert.match(toTickets, /Blocked by: <Local Markdown 使用仓库相对 ticket 路径/);
  assert.match(toTickets, /## Parent/);
  assert.match(toTickets, /## Acceptance criteria/);
  assert.match(toTickets, /`matt-implement` 已移植/);
  assert.match(toTickets, /每次只处理一个 ticket/);

  const implement = await readFile(join(ROOT, ".pi", "skills", "matt-implement", "SKILL.md"), "utf8");
  assert.match(implement, /一个 ticket/);
  assert.match(implement, /workflow`: `matt-tdd`/);
  assert.match(implement, /workflow`: `matt-code-review`/);
  assert.match(implement, /当前 branch/);
  assert.match(implement, /不 push/);
  assert.match(implement, /只处理一个 ticket/);
  assert.match(implement, /contact_supervisor/);
  assert.match(implement, /domain-modeling/);
  assert.match(implement, /Status: resolved/);
  assert.match(implement, /同一提交/);
  assert.match(implement, /blocker.*Type: ticket.*Status: resolved/);
  assert.match(implement, /spec-ready.*必须先进入 `matt-to-tickets`/);
  assert.match(implement, /Parent: None.*当前会话单 slice/);
  assert.match(implement, /Parent.*Type: spec.*Status: spec-ready/);
  assert.match(implement, /只做 Parent 字段存在性 preflight/);

  const diagnosing = await readFile(join(ROOT, ".pi", "skills", "matt-diagnosing-bugs", "SKILL.md"), "utf8");
  assert.doesNotMatch(diagnosing, /disable-model-invocation:\s*true/);
  assert.match(diagnosing, /pi-class:\s*interaction/);
  assert.match(diagnosing, /pi-dispatch:\s*none/);
  assert.match(diagnosing, /pi-depends-on:\s*matt-implement/);
  assert.match(diagnosing, /Redact gate/);
  assert.match(diagnosing, /no red-capable command, no hypothesis/i);
  assert.match(diagnosing, /Phase 3：Hypothesis checkpoint/);
  assert.match(diagnosing, /ask_user_question/);
  assert.match(diagnosing, /Root-cause gate/);
  assert.match(diagnosing, /\[DEBUG-<id>\]/);
  assert.match(diagnosing, /交给 Implement/);
  assert.match(diagnosing, /一个且仅一个当前会话 slice/);
  assert.match(diagnosing, /没有正确 regression seam.*停止/);
  assert.match(diagnosing, /已移植的 `matt-improve-codebase-architecture`/);
  assert.match(diagnosing, /不得在诊断阶段自动开始 refactor/);
  assert.doesNotMatch(diagnosing, /workflow\.json/);

  const improve = await readFile(join(ROOT, ".pi", "skills", "matt-improve-codebase-architecture", "SKILL.md"), "utf8");
  assert.match(improve, /disable-model-invocation:\s*true/);
  assert.match(improve, /pi-class:\s*interaction/);
  assert.match(improve, /pi-dispatch:\s*none/);
  assert.match(improve, /pi-depends-on:\s*matt-grilling, matt-domain-modeling/);
  assert.match(improve, /deletion test/);
  assert.match(improve, /workflow`: `architecture-scan`/);
  assert.match(improve, /OS temp/);
  assert.match(improve, /没有 candidate 是合法结果/);
  assert.match(improve, /只保留报告，暂不探索/);
  assert.match(improve, /一个且仅一个/);
  assert.match(improve, /Design it twice/);
  assert.match(improve, /workflow`: `architecture-design`/);
  assert.match(improve, /minimal.*flexible.*common-caller/);
  assert.match(improve, /三个 readers 永远只读/);
  assert.match(improve, /不修改生产代码/);
  assert.match(improve, /进入 `matt-to-spec`/);
  assert.doesNotMatch(improve, /workflow\.json/);

  const wayfinder = await readFile(join(ROOT, ".pi", "skills", "matt-wayfinder", "SKILL.md"), "utf8");
  assert.match(wayfinder, /disable-model-invocation:\s*true/);
  assert.match(wayfinder, /pi-class:\s*interaction/);
  assert.match(wayfinder, /pi-dispatch:\s*none/);
  assert.match(wayfinder, /pi-depends-on:\s*matt-grilling, matt-domain-modeling, matt-to-spec/);
  assert.match(wayfinder, /Tracker gate/);
  assert.match(wayfinder, /claim、release、resolve、out-of-scope、fog graduation/);
  assert.match(wayfinder, /不得沿用上游的隐式 local fallback/);
  assert.match(wayfinder, /Mode A：Chart the map/);
  assert.match(wayfinder, /Mode B：Work through the map/);
  assert.match(wayfinder, /一个 session 最多 resolve 一个 decision ticket/);
  assert.match(wayfinder, /先 claim，再工作/);
  assert.match(wayfinder, /pi:<PI_SESSION_ID>/);
  assert.match(wayfinder, /每个初始 `matt-research` ticket.*先按 tracker claim 协议/);
  assert.match(wayfinder, /tracker release 协议.*open\/unclaimed/);
  assert.match(wayfinder, /Decisions so far/);
  assert.match(wayfinder, /Not yet specified/);
  assert.match(wayfinder, /普通 prose output 不能作为答案/);
  assert.match(wayfinder, /完整读取并应用已登记的 `matt-prototype` parent/);
  assert.match(wayfinder, /prototype.*workflow.*artifact.*verdict.*context pointer/);
  assert.match(wayfinder, /Cleared-map gate/);
  assert.match(wayfinder, /不要直接进入 `matt-to-tickets` 或 `matt-implement`/);
  assert.doesNotMatch(wayfinder, /workflow\.json/);

  const prototype = await readFile(join(ROOT, ".pi", "skills", "matt-prototype", "SKILL.md"), "utf8");
  assert.doesNotMatch(prototype, /disable-model-invocation:\s*true/);
  assert.match(prototype, /pi-class:\s*orchestration/);
  assert.match(prototype, /Question gate/);
  assert.match(prototype, /Workspace gate/);
  assert.match(prototype, /workflow`: `matt-prototype`/);
  assert.match(prototype, /structuredOutput/);
  assert.match(prototype, /不写 tests/);
  assert.match(prototype, /Logic 必须是一个自包含 HTML 文件/);
  assert.match(prototype, /UI.*3.*5 个/i);
  assert.match(prototype, /HITL verdict/);
  assert.match(prototype, /prototype\/<slug>/);
  assert.match(prototype, /不创建 branch、不 commit、不 stage、不 push/);
  assert.match(prototype, /不 push/);
  assert.match(prototype, /原 branch 无 prototype 残留/);
  assert.match(prototype, /生产实现.*implement.*tdd.*code-review/);

  const tdd = await readFile(join(ROOT, ".pi", "skills", "matt-tdd", "SKILL.md"), "utf8");
  assert.match(tdd, /没有明确 spec\/验收行为时停止/);

  const research = await readFile(join(ROOT, ".pi", "skills", "matt-research", "SKILL.md"), "utf8");
  assert.match(research, /跨会话证据/);
  assert.match(research, /research note/);

  const readme = await readFile(join(ROOT, "README.md"), "utf8");
  assert.match(readme, /10 个交互式 parent/);
  assert.match(readme, /6 个执行型 parent.*`architecture-scan`.*`architecture-design`/);
  assert.match(readme, /交互式 parent（`matt-setup`、`matt-grilling`、`matt-domain-modeling`、`matt-grill-with-docs`、`matt-wayfinder`、`matt-to-spec`、`matt-to-tickets`、`matt-implement`、`matt-diagnosing-bugs`、`matt-improve-codebase-architecture`）/);
  assert.match(readme, /`matt-setup`、`matt-grilling`、`matt-domain-modeling`、`matt-grill-with-docs`、`matt-wayfinder`、`matt-to-spec`、`matt-to-tickets`、`matt-implement`、`matt-diagnosing-bugs` 和 `matt-improve-codebase-architecture` 是 `dispatch: none`/);
  assert.match(readme, /首次使用发布链前运行 `matt-setup`/);
  assert.match(readme, /spec-ready.*ready-for-agent.*resolved/);
  assert.match(readme, /interaction parent 本身不定义 `workflow\.json`/);
  assert.match(readme, /`matt-implement`.*调用 `matt-tdd` 和 `matt-code-review`/);
  assert.match(readme, /model-invoked 的 `matt-diagnosing-bugs`/);
  assert.match(readme, /red-capable command/);
  assert.match(readme, /交给 `matt-implement`/);
  assert.match(readme, /`matt-wayfinder`.*Destination/);
  assert.match(readme, /decision tickets.*`decisions\/`/);
  assert.match(readme, /cleared.*`matt-to-spec`/);
  assert.match(readme, /model-invoked `matt-prototype`/);
  assert.match(readme, /prototype\/<slug>/);
  assert.match(readme, /`matt-improve-codebase-architecture`.*deletion-test report/);
  assert.match(readme, /pi install -l git:github\.com\/jinuxx\/pi-x-matt@v0\.1\.0/);
  assert.match(readme, /pi update git:github\.com\/jinuxx\/pi-x-matt@v0\.1\.0/);
  assert.match(readme, /三个只读 `architecture-design` lanes/);
});

test("parent workflows require structured completion results", async () => {
  for (const name of ["matt-research", "matt-prototype", "architecture-scan", "architecture-design", "matt-code-review", "matt-tdd"]) {
    const content = await readFile(join(ROOT, ".pi", "skills", name, "SKILL.md"), "utf8");
    assert.match(content, /structuredOutput/);
    assert.match(content, /fail|失败/);
  }
});

test("workflow schemas require structured output and distinct review axes", async () => {
  const registry = await buildRegistry(ROOT);
  const researchLane = registry.skills["matt-research"].workflow.lanes[0];
  assert.deepEqual(researchLane.outputSchema.required, ["question", "summary", "findings", "sources", "gaps"]);

  const prototypeLane = registry.skills["matt-prototype"].workflow.lanes[0];
  assert.equal(prototypeLane.outputSchema.properties.status.enum.join(","), "BUILT,BLOCKED");
  assert.deepEqual(prototypeLane.turnBudget, { maxTurns: 24, graceTurns: 4 });
  assert.deepEqual(prototypeLane.gate, {
    field: "status",
    equals: "BUILT",
    nonEmpty: ["artifactPaths", "runInstructions", "reviewTargets", "changedFiles", "commands", "cleanupPlan"],
  });
  assert.deepEqual(prototypeLane.outputSchema.required, [
    "status", "summary", "question", "branch", "artifactPaths", "runInstructions", "reviewTargets", "changedFiles", "commands", "cleanupPlan", "residualRisks",
  ]);

  const scanLane = registry.skills["architecture-scan"].workflow.lanes[0];
  assert.equal(scanLane.outputSchema.properties.status.enum.join(","), "REPORTED,BLOCKED");
  assert.deepEqual(scanLane.gate, { field: "status", equals: "REPORTED", nonEmpty: ["scopeEvidence", "commands"] });
  assert.equal(scanLane.outputSchema.properties.candidates.maxItems, 6);

  const designLanes = registry.skills["architecture-design"].workflow.lanes;
  assert.deepEqual(designLanes.map((lane) => lane.key), ["minimal", "flexible", "common-caller"]);
  assert.deepEqual(designLanes.map((lane) => lane.outputSchema.properties.strategy.enum[0]), ["minimal", "flexible", "common-caller"]);
  assert.ok(designLanes.every((lane) => lane.agent === "matt-reader"));
  assert.ok(designLanes.every((lane) => lane.gate.field === "status" && lane.gate.equals === "COMPLETE"));
  assert.ok(designLanes.every((lane) => lane.gate.nonEmpty.join(",") === "entries,tradeoffs"));

  const [standards, spec] = registry.skills["matt-code-review"].workflow.lanes;
  assert.deepEqual(standards.outputSchema.properties.axis.enum, ["standards"]);
  assert.deepEqual(spec.outputSchema.properties.axis.enum, ["spec"]);
  for (const lane of [standards, spec]) {
    assert.equal(lane.timeoutMs, 600000);
    assert.deepEqual(lane.turnBudget, { maxTurns: 12, graceTurns: 2 });
    assert.deepEqual(lane.outputSchema.required, ["axis", "verdict", "summary", "findings", "notes"]);
    assert.equal(lane.outputSchema.properties.findings.items.properties.severity.enum.join(","), "P0,P1,P2");
  }

  const [implement, tddStandards, tddSpec] = registry.skills["matt-tdd"].workflow.lanes;
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
    const workflowPath = join(temp, ".pi", "skills", "matt-research", "workflow.json");
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
    await replace(path, "pi-agent: matt-researcher", "pi-agent: missing-agent");
    await assert.rejects(() => buildRegistry(temp), /unknown metadata\.pi-agent 'missing-agent'/);
  });

  await withTempProject(async (temp) => {
    const path = join(temp, "skillpacks", "leaf", "review-spec", "SKILL.md");
    await replace(path, 'pi-depends-on: ""', "pi-depends-on: research-executor");
    await assert.rejects(() => buildRegistry(temp), /targets agent 'matt-researcher', expected 'matt-reviewer'/);
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
    const path = join(temp, ".pi", "skills", "matt-research", "SKILL.md");
    await replace(path, "pi-upstream-path: skills/engineering/research/SKILL.md", "pi-upstream-path: ../../outside.md");
    await assert.rejects(() => buildRegistry(temp), /Upstream path for 'matt-research'.*inside the project root/);
  });
});

test("registry generation permits at most one declared writer lane", async () => {
  await withTempProject(async (temp) => {
    const path = join(temp, ".pi", "skills", "matt-tdd", "workflow.json");
    const workflow = JSON.parse(await readFile(path, "utf8"));
    workflow.lanes[1].agent = "matt-worker";
    workflow.lanes[1].skills = ["tdd-executor"];
    await write(path, `${JSON.stringify(workflow, null, 2)}\n`);
    await assert.rejects(() => buildRegistry(temp), /workflow may define at most one writer lane/);
  });

  await withTempProject(async (temp) => {
    const path = join(temp, ".pi", "agents", "matt-worker.md");
    await replace(path, "acceptanceRole: writer", "acceptanceRole: unknown");
    await assert.rejects(() => buildRegistry(temp), /acceptanceRole must be 'writer' or 'read-only'/);
  });
});

test("registry generation rejects invalid interaction parent routing", async () => {
  await withTempProject(async (temp) => {
    const path = join(temp, ".pi", "skills", "matt-grilling", "SKILL.md");
    await replace(path, "pi-dispatch: none", "pi-dispatch: parallel");
    await assert.rejects(() => buildRegistry(temp), /interaction parent metadata\.pi-dispatch must be 'none'/);
  });

  await withTempProject(async (temp) => {
    const path = join(temp, ".pi", "skills", "matt-grill-with-docs", "SKILL.md");
    await replace(path, "pi-depends-on: matt-grilling, matt-domain-modeling", "pi-depends-on: matt-research");
    await assert.rejects(() => buildRegistry(temp), /interaction dependency 'matt-research' must be an interaction parent skill/);
  });

  await withTempProject(async (temp) => {
    const path = join(temp, ".pi", "skills", "matt-grilling", "SKILL.md");
    await replace(path, "pi-class: interaction", "pi-class: interaction\n  pi-agent: matt-worker");
    await assert.rejects(() => buildRegistry(temp), /interaction parent skills must not define metadata\.pi-agent/);
  });

  await withTempProject(async (temp) => {
    const path = join(temp, ".pi", "skills", "matt-research", "SKILL.md");
    await replace(path, "pi-class: orchestration", "pi-class: orchestration\n  pi-dispatch: single");
    await assert.rejects(() => buildRegistry(temp), /orchestration parent skills must not define metadata\.pi-dispatch/);
  });

  await withTempProject(async (temp) => {
    const path = join(temp, ".pi", "skills", "matt-research", "SKILL.md");
    await replace(path, "pi-class: orchestration", "pi-class: orchestration\n  pi-agent: matt-researcher\n  pi-depends-on: research-executor");
    await assert.rejects(() => buildRegistry(temp), /orchestration parent skills must not define metadata\.pi-agent/);
  });
});

test("registry generation rejects weak workflow schemas and invalid leaf dispatch", async () => {
  await withTempProject(async (temp) => {
    const path = join(temp, ".pi", "skills", "matt-research", "workflow.json");
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
    const path = join(temp, ".pi", "skills", "matt-tdd", "workflow.json");
    const workflow = JSON.parse(await readFile(path, "utf8"));
    workflow.lanes[1].stage = 3;
    workflow.lanes[2].stage = 3;
    await write(path, `${JSON.stringify(workflow, null, 2)}\n`);
    await assert.rejects(() => buildRegistry(temp), /pipeline stages must be contiguous/);
  });

  await withTempProject(async (temp) => {
    const path = join(temp, ".pi", "skills", "matt-tdd", "workflow.json");
    const workflow = JSON.parse(await readFile(path, "utf8"));
    workflow.lanes[0].gate.equals = "NOT_DECLARED";
    await write(path, `${JSON.stringify(workflow, null, 2)}\n`);
    await assert.rejects(() => buildRegistry(temp), /gate must match a declared enum value/);
  });

  await withTempProject(async (temp) => {
    const path = join(temp, ".pi", "skills", "matt-tdd", "workflow.json");
    const workflow = JSON.parse(await readFile(path, "utf8"));
    workflow.lanes[0].gate.nonEmpty = ["summary"];
    await write(path, `${JSON.stringify(workflow, null, 2)}\n`);
    await assert.rejects(() => buildRegistry(temp), /gate\.nonEmpty must name unique array properties/);
  });

  await withTempProject(async (temp) => {
    const path = join(temp, ".pi", "skills", "matt-research", "workflow.json");
    const workflow = JSON.parse(await readFile(path, "utf8"));
    workflow.lanes[0].stage = 1;
    await write(path, `${JSON.stringify(workflow, null, 2)}\n`);
    await assert.rejects(() => buildRegistry(temp), /only pipeline lanes may define stage/);
  });

  await withTempProject(async (temp) => {
    const path = join(temp, ".pi", "skills", "matt-research", "workflow.json");
    const workflow = JSON.parse(await readFile(path, "utf8"));
    workflow.lanes[0].gate = { field: "missing", equals: "PASS" };
    await write(path, `${JSON.stringify(workflow, null, 2)}\n`);
    await assert.rejects(() => buildRegistry(temp), /lane 'research' has an invalid gate/);
  });
});
