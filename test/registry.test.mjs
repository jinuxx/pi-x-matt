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
    "matt-archive",
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

  for (const name of ["matt-setup", "matt-archive", "matt-grilling", "matt-domain-modeling", "matt-grill-with-docs"]) {
    const interaction = registry.skills[name];
    assert.equal(interaction.scope, "parent");
    assert.equal(interaction.class, "interaction");
    assert.equal(interaction.dispatch, "none");
    assert.equal(interaction.agent, null);
    assert.equal(interaction.workflow, undefined);
    assert.equal(interaction.workflowPath, undefined);
  }
  assert.deepEqual(registry.skills["matt-grill-with-docs"].dependsOn, ["matt-grilling", "matt-domain-modeling"]);
  assert.deepEqual(registry.skills["matt-archive"].dependsOn, []);
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
    source: "npm:pi-subagents",
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
  assert.equal(manifest.version, "0.2.15");
  assert.equal(manifest.private, true);
  assert.equal(manifest.license, "MIT");
  assert.deepEqual(manifest.pi.extensions, ["./.pi/extensions/pi-matt-dispatch/index.ts"]);
  assert.deepEqual(manifest.pi.skills, [
    "./.pi/skills/matt-archive",
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
  assert.equal(manifest.dependencies["pi-subagents"], "0.69.0");
  assert.deepEqual(manifest.bundledDependencies, ["pi-subagents"]);
  assert.equal(manifest.peerDependencies["pi-subagents"], undefined);
  assert.equal(manifest.repository.url, "git+https://github.com/jinuxx/pi-x-matt.git");
  assert.ok(manifest.files.includes(".pi/skills"));
  assert.ok(manifest.files.includes("vendor"));
  assert.ok(manifest.files.includes("child-tools"));
});

test("dispatcher keeps the package root in the extension", async () => {
  const extension = await readFile(join(ROOT, ".pi", "extensions", "pi-matt-dispatch", "index.ts"), "utf8");
  assert.match(extension, /const PACKAGE_ROOT = resolve\(dirname\(fileURLToPath\(import\.meta\.url\)\), "\.\.\/\.\.\/\.\."\)/);
  assert.match(extension, /loadCurrentRegistry\(PACKAGE_ROOT\)/);
  assert.match(extension, /registerWorkflowResource/);
  assert.match(extension, /workflow: "pi-x-matt\.tdd"/);
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

test("project dispatcher requires runtime user authorization before queuing matt-tdd", async () => {
  const extension = await readFile(join(ROOT, ".pi", "extensions", "pi-matt-dispatch", "index.ts"), "utf8");
  assert.match(extension, /import \{ createDispatchAuthorization, authorizeWorkflowDispatch \} from "\.\.\/\.\.\/\.\.\/lib\/dispatch-authorization\.mjs"/);
  assert.match(extension, /createDispatchAuthorization\(\)/);
  assert.match(extension, /pi\.on\("input"/);
  assert.match(extension, /authorization\.observeInput\(event\.text, event\.source\)/);
  assert.match(extension, /pi\.on\("session_start"/);
  assert.match(extension, /authorization\.reset\(\)/);
  assert.match(extension, /await authorizeWorkflowDispatch\(workflow\.name, signal, ctx, authorization\)/);
  assert.match(extension, /authorization: authorizationReason/);
  const authorizationIndex = extension.indexOf("await authorizeWorkflowDispatch(workflow.name, signal, ctx, authorization)");
  const queueIndex = extension.indexOf("pendingDispatches.push");
  assert.notEqual(authorizationIndex, -1);
  assert.notEqual(queueIndex, -1);
  assert.ok(authorizationIndex < queueIndex, "matt-tdd authorization must happen before the dispatch is queued");
});

test("repository tracker setup is executable and discoverable by Pi", async () => {
  const agents = await readFile(join(ROOT, "AGENTS.md"), "utf8");
  assert.equal((agents.match(/^## Agent skills$/gm) ?? []).length, 1);
  assert.match(agents, /\.x-matt\/agents\/issue-tracker\.md/);
  assert.match(agents, /\.x-matt\/agents\/triage-labels\.md/);
  assert.match(agents, /\.x-matt\/agents\/domain\.md/);

  const tracker = await readFile(join(ROOT, ".x-matt", "agents", "issue-tracker.md"), "utf8");
  assert.match(tracker, /Issue Tracker: Local Markdown/);
  assert.match(tracker, /\.x-matt\/work\/<feature-slug>\/spec\.md/);
  assert.match(tracker, /issues\/<NN>-<slug>\.md/);
  assert.match(tracker, /Type: spec/);
  assert.match(tracker, /Status: spec-ready/);
  assert.match(tracker, /Status.*`spec-ready`.*`shipped`/);
  assert.match(tracker, /\.x-matt\/work\/shipped\/<feature-slug>\//);
  assert.match(tracker, /Parent spec 归档/);
  assert.match(tracker, /独立步骤中显式调用 `matt-archive`/);
  assert.match(tracker, /默认对模型不可见/);
  assert.match(tracker, /同一会话明确点名/);
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
  assert.match(tracker, /\.x-matt\/work\/<effort>\/map\.md/);
  assert.match(tracker, /decisions\/<NN>-<slug>\.md/);
  assert.match(tracker, /Type: wayfinder-map/);
  assert.match(tracker, /Status: active/);
  assert.match(tracker, /<长期约束；不得包含 agent 自行授予的 execution override>/);
  assert.match(tracker, /Type: <research\|prototype\|grilling\|task>/);
  assert.match(tracker, /Claimed by:/);
  assert.match(tracker, /pi:<PI_SESSION_ID>/);
  assert.match(tracker, /PI_SESSION_ID.*必须非空/);
  assert.match(tracker, /Status: cleared/);
  assert.match(tracker, /Frontier/);
  assert.match(tracker, /\*\*Release\*\*.*Status: open.*Claimed by: None/);
  assert.match(tracker, /implementation.*`issues\/` 冲突/);

  const labels = await readFile(join(ROOT, ".x-matt", "agents", "triage-labels.md"), "utf8");
  assert.match(labels, /`ready-for-agent` \| `ready-for-agent`/);
  assert.match(labels, /`spec-ready`/);
  assert.match(labels, /`shipped`/);
  assert.match(labels, /`resolved`/);
  assert.match(labels, /`active` \/ `cleared`/);
  assert.match(labels, /`open` \/ `claimed` \/ `resolved` \/ `out-of-scope`/);
  const domain = await readFile(join(ROOT, ".x-matt", "agents", "domain.md"), "utf8");
  assert.match(domain, /single-context/);
  assert.match(domain, /\.x-matt\/context\/CONTEXT\.md/);
  assert.match(domain, /\.x-matt\/context\/<context>\/CONTEXT\.md/);
  assert.match(domain, /\.x-matt\/adr\/<context>\//);
  assert.match(tracker, /\.x-matt\/work\//);
  assert.match(agents, /\.x-matt\/agents\//);
});

test("all project agents are leaf-only and use the private skill path", async () => {
  for (const name of ["matt-reader", "matt-researcher", "matt-reviewer", "matt-worker"]) {
    const content = await readFile(join(ROOT, ".pi", "agents", `${name}.md`), "utf8");
    assert.match(content, /inheritSkills:\s*false/);
    assert.match(content, /skillPath:\s*\.\.\/\.\.\/skillpacks\/leaf/);
    assert.match(content, /maxSubagentDepth:\s*0/);
    assert.doesNotMatch(content.match(/^tools:.*$/m)?.[0] ?? "", /\bsubagent\b/);
  }

  for (const name of ["matt-reader", "matt-reviewer", "matt-worker"]) {
    const content = await readFile(join(ROOT, ".pi", "agents", `${name}.md`), "utf8");
    assert.match(content, /tools:.*\bffgrep\b/);
    assert.match(content, /tools:.*\bfffind\b/);
  }

  const reviewer = await readFile(join(ROOT, ".pi", "agents", "matt-reviewer.md"), "utf8");
  assert.match(reviewer, /tools:.*\bgit_read\b/);
  assert.doesNotMatch(reviewer.match(/^tools:.*$/m)?.[0] ?? "", /\b(edit|write|apply_patch|bash)\b/);
  assert.match(reviewer, /subagentOnlyExtensions:\s*\.\.\/\.\.\/child-tools\/review-readonly-git\.ts/);
  const reviewerBudget = reviewer.match(/^toolBudget:\s*(\{.*\})$/m);
  assert.ok(reviewerBudget);
  assert.deepEqual(JSON.parse(reviewerBudget[1]), {
    hard: 50,
    block: ["read", "grep", "find", "ffgrep", "fffind", "ls", "git_read"],
  });
  const gitTool = await readFile(join(ROOT, "child-tools", "review-readonly-git.ts"), "utf8");
  assert.match(gitTool, /"worktree-files"/);
  assert.match(gitTool, /"worktree-diff"/);

  const worker = await readFile(join(ROOT, ".pi", "agents", "matt-worker.md"), "utf8");
  assert.match(worker, /tools:.*\bedit\b/);
  assert.match(worker, /tools:.*\bwrite\b/);
  assert.match(worker, /tools:.*\bapply_patch\b/);
  assert.match(worker, /mutationTools:\s*apply_patch/);
  for (const name of ["matt-reader", "matt-researcher", "matt-reviewer"]) {
    const content = await readFile(join(ROOT, ".pi", "agents", `${name}.md`), "utf8");
    assert.doesNotMatch(content.match(/^tools:.*$/m)?.[0] ?? "", /\b(edit|write|apply_patch)\b/);
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
  assert.match(setup, /\.x-matt\/agents\/issue-tracker\.md/);
  assert.match(setup, /\.x-matt\/agents\/triage-labels\.md/);
  assert.match(setup, /\.x-matt\/agents\/domain\.md/);
  assert.match(setup, /\.x-matt\/context\/<context>\/CONTEXT\.md/);
  assert.match(setup, /\.x-matt\/adr\/<context>\//);
  assert.match(setup, /\.x-matt\/work\/<feature-slug>\//);
  assert.match(setup, /不创建远端 issue、label/);
  assert.match(setup, /Pi-only/);
  assert.match(setup, /`spec-ready`、`shipped`、`ready-for-agent`、`resolved` 与 `out-of-scope`/);
  assert.match(setup, /`ready-for-agent` 是 canonical triage role/);
  assert.match(setup, /使用 Pi 为已加载 `matt-setup` 提供的绝对 skill `location`/);
  assert.match(setup, /从该 `SKILL\.md` 所在目录逐级向上/);
  assert.match(setup, /第一个同时包含 `package\.json` 与 `config\/skill-registry\.json`/);
  assert.match(setup, /不得从目标项目 cwd 或目标项目的 `\.pi\/` 猜测 package 内容/);
  assert.match(setup, /`config\/skill-registry\.json` 为 skill 存在性和 `scope` \/ `class` \/ `dispatch` metadata 的权威来源/);
  assert.match(setup, /`package\.json#pi\.skills` 只交叉核验对应 skill 路径已作为 package resource 暴露/);
  assert.match(setup, /不能用它推导 metadata/);
  assert.match(setup, /本版本 invariant 是 `triage` 未登记，`matt-wayfinder` 与 `matt-archive` 都已登记为 `parent` \/ `interaction` \/ `dispatch: none`/);
  assert.match(setup, /Wayfinding operations/);
  assert.match(setup, /claim、release、resolve、out-of-scope、fog graduation/);
  assert.match(setup, /\.x-matt\/work\/<effort>\/map\.md/);
  assert.match(setup, /\.x-matt\/work\/<effort>\/decisions\/<NN>-<slug>\.md/);
  assert.match(setup, /Type: wayfinder-map/);
  assert.match(setup, /Status: active/);
  assert.match(setup, /<长期约束；不得包含 agent 自行授予的 execution override>/);
  assert.match(setup, /Type: <research\|prototype\|grilling\|task>/);
  assert.match(setup, /Parent: <仓库相对 map 路径>/);
  assert.match(setup, /Status: open/);
  assert.match(setup, /Claimed by: None/);
  assert.match(setup, /Blocked by: <仓库相对 decision ticket 路径，或 None>/);
  assert.match(setup, /pi:<PI_SESSION_ID>/);
  assert.match(setup, /不得使用 metadata 字段 `Claim:`/);
  assert.match(setup, /发现 metadata 行 `Claim:`.*核验失败并停止/);
  assert.doesNotMatch(setup, /^Claim:/m);
  assert.doesNotMatch(setup, /尚未移植的 wayfinder/);
  assert.match(setup, /setup 所需的 tracker、label、domain 和 Wayfinding 行为契约内置/);
  assert.doesNotMatch(setup, /vendor\/mattpocock-skills/);

  const archive = await readFile(join(ROOT, ".pi", "skills", "matt-archive", "SKILL.md"), "utf8");
  assert.match(archive, /disable-model-invocation:\s*true/);
  assert.match(archive, /pi-class:\s*interaction/);
  assert.match(archive, /pi-dispatch:\s*none/);
  assert.match(archive, /准确的 `<feature-slug>`/);
  assert.match(archive, /Status: spec-ready.*Status: shipped/s);
  assert.match(archive, /resolved` 或 `out-of-scope/);
  assert.match(archive, /跨 feature blocker 时拒绝/);
  assert.match(archive, /Commits landed/);
  assert.match(archive, /Durable knowledge settled/);
  assert.match(archive, /git diff --check/);
  assert.match(archive, /chore: 归档 <feature-slug> 规格/);
  assert.match(archive, /普通会话必须把 `\.x-matt\/work\/shipped\/` 视为不存在/);
  assert.doesNotMatch(archive, /workflow\.json/);

  const grilling = await readFile(join(ROOT, ".pi", "skills", "matt-grilling", "SKILL.md"), "utf8");
  assert.match(grilling, /ask_user_question/);
  assert.match(grilling, /Frontier/);
  assert.match(grilling, /shared understanding/);
  assert.match(grilling, /Transition handoff/);
  assert.match(grilling, /控制权交还给用户/);
  assert.match(grilling, /不得.*调用 `matt-tdd`/);
  assert.match(grilling, /发布 spec 并继续拆 tickets.*直接实现一个单 slice.*暂停/);
  assert.match(grilling, /不得代替用户执行命令/);

  const domain = await readFile(join(ROOT, ".pi", "skills", "matt-domain-modeling", "SKILL.md"), "utf8");
  assert.match(domain, /CONTEXT\.md/);
  assert.match(domain, /ADR gate/);
  assert.match(domain, /架构形状/);
  assert.match(domain, /唯一写者/);

  const combined = await readFile(join(ROOT, ".pi", "skills", "matt-grill-with-docs", "SKILL.md"), "utf8");
  assert.match(combined, /disable-model-invocation:\s*true/);
  assert.match(combined, /pi-depends-on:\s*matt-grilling, matt-domain-modeling/);
  assert.match(combined, /Shared-understanding gate/);
  assert.match(combined, /不得在同一 invocation 中.*生成 spec\/tickets 或写生产实现/);
  assert.match(combined, /已移植的手动 `matt-wayfinder`/);
  assert.match(combined, /显式 transition handoff/);
  assert.match(combined, /greenfield 项目.*事实\/说明\/样例\/约束/);
  assert.match(combined, /不以特定项目或材料类型为限/);
  assert.match(combined, /不得代替用户执行命令/);

  const toSpec = await readFile(join(ROOT, ".pi", "skills", "matt-to-spec", "SKILL.md"), "utf8");
  assert.match(toSpec, /不重新 interview/);
  assert.match(toSpec, /Seam gate/);
  assert.match(toSpec, /tracker/);
  assert.match(toSpec, /ready-for-agent/);
  assert.match(toSpec, /已移植的 `matt-setup`/);
  assert.match(toSpec, /\.x-matt\/agents\/issue-tracker\.md/);
  assert.match(toSpec, /\.x-matt\/agents\/triage-labels\.md/);
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
  assert.match(toSpec, /Source session: pi:<PI_SESSION_ID>/);
  assert.match(toSpec, /## Reference Inputs/);
  assert.match(toSpec, /用户提供且后续实现、验证或运维需要依赖的事实、说明性内容、样例和约束/);
  assert.match(toSpec, /不以特定项目或材料类型为限/);
  assert.match(toSpec, /不得.*静默跳过到 implement/);
  assert.match(toSpec, /默认跳过 `\.x-matt\/work\/shipped\/`/);

  assert.match(toSpec, /不要为了“完整”发明用户未确认的需求/);

  const toTickets = await readFile(join(ROOT, ".pi", "skills", "matt-to-tickets", "SKILL.md"), "utf8");
  assert.match(toTickets, /tracer bullet/);
  assert.match(toTickets, /Blocking edges/);
  assert.match(toTickets, /ask_user_question/);
  assert.match(toTickets, /ready-for-agent/);
  assert.match(toTickets, /已移植的 `matt-setup`/);
  assert.match(toTickets, /\.x-matt\/agents\/issue-tracker\.md/);
  assert.match(toTickets, /\.x-matt\/agents\/triage-labels\.md/);
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
  assert.match(toTickets, /Source session: pi:<PI_SESSION_ID>/);
  assert.match(toTickets, /不得.*静默跳过到 implement/);
  assert.match(toTickets, /active `\.x-matt\/work\/<feature-slug>\/spec\.md`/);
  assert.match(toTickets, /不能重新拆 tickets/);

  const implement = await readFile(join(ROOT, ".pi", "skills", "matt-implement", "SKILL.md"), "utf8");
  assert.match(implement, /一个 ticket/);
  assert.match(implement, /workflow`: `matt-tdd`/);
  assert.match(implement, /不要再调用 `matt-code-review` 重复评审同一 worktree/);
  assert.match(implement, /只有以下任一条件成立时才额外调用 `matt-code-review`/);
  assert.match(implement, /同一轮全部 findings/);
  assert.match(implement, /聚焦 `matt-tdd`/);
  assert.match(implement, /不再追加 standalone code review/);
  assert.match(implement, /`laneTasks`: 必须同时提供 `implement`、`standards`、`spec`/);
  assert.match(implement, /旧 worker transcript 代替 diff/);
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
  assert.match(implement, /只做 Parent 字段存在性与 shipped 非入口 preflight/);
  assert.match(implement, /缺少 ticket 本身不构成 direct-slice 授权/);
  assert.match(implement, /依赖用户提供且不能安全压缩的事实、说明、样例或约束/);
  assert.match(implement, /材料类型不限于技术 contract/);
  assert.match(implement, /禁止父会话直接创建或改写 `\.x-matt\/work\/` 来解阻/);
  assert.match(implement, /无法确认本次实现由你显式发起时才要求运行时确认/);
  assert.match(implement, /本 session 用 `\/skill:matt-implement` 显式启动时直接放行/);
  assert.match(implement, /无 UI 的 print\/JSON mode.*fail closed/);
  assert.match(implement, /ticket 路径、Parent 或任何待读取 blocker.*`\.x-matt\/work\/shipped\/`/);
  assert.match(implement, /已随 spec 归档/);
  assert.match(implement, /独立步骤显式运行 `matt-archive`/);

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
  assert.match(diagnosing, /不得写入、枚举或把 `\.x-matt\/work\/shipped\/` 用作诊断路径/);
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
  assert.match(wayfinder, /metadata `Type:` 只能是 `research`、`prototype`、`grilling`、`task`/);
  assert.match(wayfinder, /`matt-research`、`matt-prototype` 与 `matt-grilling` 是 resolver skill\/workflow 名，不是 `Type:` 值/);
  assert.doesNotMatch(wayfinder, /每个 decision ticket 只能是 `matt-research`/);
  assert.match(wayfinder, /每个初始 `Type: research` ticket.*先按 tracker claim 协议/);
  assert.match(wayfinder, /tracker release 协议.*open\/unclaimed/);
  assert.match(wayfinder, /Decisions so far/);
  assert.match(wayfinder, /Not yet specified/);
  assert.match(wayfinder, /普通 prose output 不能作为答案/);
  assert.match(wayfinder, /完整读取并应用已登记的 `matt-prototype` parent/);
  assert.match(wayfinder, /prototype.*workflow.*artifact.*verdict.*context pointer/);
  assert.match(wayfinder, /Cleared-map gate/);
  assert.match(wayfinder, /不要直接进入 `matt-to-tickets` 或 `matt-implement`/);
  assert.match(wayfinder, /默认跳过整个 `\.x-matt\/work\/shipped\/`/);
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
  assert.match(tdd, /disable-model-invocation:\s*true/);
  assert.match(tdd, /`matt-implement` 使用的内部执行 parent/);
  assert.match(tdd, /不得使用 `write`\/`edit` 创建 spec 或 ticket 解阻/);
  assert.match(tdd, /没有明确 spec\/验收行为.*时停止/);
  assert.match(tdd, /只在无法确认用户显式发起实现时才拦截/);
  assert.match(tdd, /本 session 由用户执行 `\/skill:matt-implement` 启动时直接放行/);
  assert.match(tdd, /没有可响应的 UI 时必须拒绝调度/);
  assert.match(tdd, /位于 `\.x-matt\/work\/shipped\/` 就立即 fail closed/);

  const research = await readFile(join(ROOT, ".pi", "skills", "matt-research", "SKILL.md"), "utf8");
  assert.match(research, /跨会话证据/);
  assert.match(research, /research note/);

  const readme = await readFile(join(ROOT, "README.md"), "utf8");
  assert.match(readme, /11 个交互式 parent/);
  assert.match(readme, /6 个执行型 parent.*`architecture-scan`.*`architecture-design`/);
  assert.match(readme, /交互式 parent（`matt-setup`、`matt-archive`、`matt-grilling`、`matt-domain-modeling`、`matt-grill-with-docs`、`matt-wayfinder`、`matt-to-spec`、`matt-to-tickets`、`matt-implement`、`matt-diagnosing-bugs`、`matt-improve-codebase-architecture`）/);
  assert.match(readme, /`matt-setup`、`matt-archive`、`matt-grilling`、`matt-domain-modeling`、`matt-grill-with-docs`、`matt-wayfinder`、`matt-to-spec`、`matt-to-tickets`、`matt-implement`、`matt-diagnosing-bugs` 和 `matt-improve-codebase-architecture` 是 `dispatch: none`/);
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
  assert.match(readme, /shared understanding 确认后必须停止并把控制权交还给用户/);
  assert.match(readme, /`Reference Inputs`/);
  assert.match(readme, /TDD 使用内部 `workflow: "matt-tdd"`/);
  assert.match(readme, /`matt-tdd` 只在无法确认本次实现由用户显式发起时才要求 TUI\/RPC 授权/);
  assert.match(readme, /本 session 以 `\/skill:matt-implement` 启动时直接放行/);
  assert.match(readme, /取消或 print\/JSON mode 没有 UI 时 fail closed/);
  assert.match(readme, /pi install -l git:github\.com\/jinuxx\/pi-x-matt@v0\.2\.15/);
  assert.match(readme, /pi update git:github\.com\/jinuxx\/pi-x-matt@v0\.2\.15/);
  assert.match(readme, /三个只读 `architecture-design` lanes/);
  assert.match(readme, /`matt-archive <feature-slug>`/);
  assert.match(readme, /默认把 `\.x-matt\/work\/shipped\/` 视为不存在/);
});

test("parent workflows require structured completion results", async () => {
  for (const name of ["matt-research", "matt-prototype", "architecture-scan", "architecture-design", "matt-code-review", "matt-tdd"]) {
    const content = await readFile(join(ROOT, ".pi", "skills", name, "SKILL.md"), "utf8");
    assert.match(content, /structuredOutput/);
    assert.match(content, /fail|失败/);
  }
});

test("reviewers stay inside a bounded evidence envelope", async () => {
  const standardsSkill = await readFile(join(ROOT, "skillpacks", "leaf", "review-standards", "SKILL.md"), "utf8");
  assert.match(standardsSkill, /Review Evidence Pack/);
  assert.match(standardsSkill, /完整、未截断的 combined/);
  assert.match(standardsSkill, /untracked 必须获得全文/);
  assert.match(standardsSkill, /rename 核对 old\/new/);
  assert.match(standardsSkill, /禁止用 `ref\.\.\.HEAD` 作为工作区唯一证据/);
  assert.match(standardsSkill, /默认只能读取 manifest 内文件/);
  assert.match(standardsSkill, /不得为了制造 `PASS` 扩大文件范围/);

  const specSkill = await readFile(join(ROOT, "skillpacks", "leaf", "review-spec", "SKILL.md"), "utf8");
  assert.match(specSkill, /先读取 \*\*Review Evidence Pack\*\*/);
  assert.match(specSkill, /不要求先逐个读取 ticket\/spec 文件/);
  assert.match(specSkill, /untracked 必须获得全文/);
  assert.match(specSkill, /默认只能读取 manifest 内文件/);
  assert.match(specSkill, /不得读取 sibling\/future tickets、ADR、context、roadmap/);
  assert.match(specSkill, /不得为了制造 `PASS` 扩大文档或代码范围/);

  const reviewParent = await readFile(join(ROOT, ".pi", "skills", "matt-code-review", "SKILL.md"), "utf8");
  assert.match(reviewParent, /`reviewKind`/);
  assert.match(reviewParent, /rename 核验 old\/new/);
  assert.match(reviewParent, /默认只读 manifest/);
  assert.match(reviewParent, /`laneTasks`/);

  const implementParent = await readFile(join(ROOT, ".pi", "skills", "matt-implement", "SKILL.md"), "utf8");
  assert.match(implementParent, /`reviewKind=worktree`/);
  assert.match(implementParent, /Implementation Context Pack/);
  assert.match(implementParent, /新文件全文\/hash/);
  const tddParent = await readFile(join(ROOT, ".pi", "skills", "matt-tdd", "SKILL.md"), "utf8");
  assert.match(tddParent, /TDD 固定 `reviewKind=worktree`/);
  assert.match(tddParent, /deleted\/rename old\/new/);
  assert.match(tddParent, /独立采集完整 Git Review Evidence Pack/);

  const reviewWorkflow = JSON.parse(await readFile(join(ROOT, ".pi", "skills", "matt-code-review", "workflow.json"), "utf8"));
  assert.ok(reviewWorkflow.lanes.every((lane) => /reviewKind/.test(lane.taskPrefix)));
  assert.ok(reviewWorkflow.lanes.every((lane) => /untracked 获得全文/.test(lane.taskPrefix)));
  assert.ok(reviewWorkflow.lanes.every((lane) => /old\/new/.test(lane.taskPrefix)));
  assert.ok(reviewWorkflow.lanes.every((lane) => /禁止扫描整个 module/.test(lane.taskPrefix)));
  assert.ok(reviewWorkflow.lanes.every((lane) => /NO_EVIDENCE/.test(lane.taskPrefix)));
  assert.match(reviewWorkflow.lanes.find((lane) => lane.key === "spec").taskPrefix, /内联内容不重复 read/);

  const tddWorkflow = JSON.parse(await readFile(join(ROOT, ".pi", "skills", "matt-tdd", "workflow.json"), "utf8"));
  const tddReviewers = tddWorkflow.lanes.filter((lane) => lane.stage === 2);
  assert.equal(tddReviewers.length, 2);
  assert.ok(tddReviewers.every((lane) => /reviewKind 固定为 worktree/.test(lane.taskPrefix)));
  assert.ok(tddReviewers.every((lane) => /新文件内容\/hash/.test(lane.taskPrefix)));
  assert.ok(tddReviewers.every((lane) => /不得扫描整个 module/.test(lane.taskPrefix)));
  assert.ok(tddReviewers.every((lane) => /NO_EVIDENCE/.test(lane.taskPrefix)));
  assert.ok(tddReviewers.every((lane) => /implement\/report-only/.test(lane.taskPrefix)));
  assert.ok(tddReviewers.every((lane) => /旧 transcript 替代 diff/.test(lane.taskPrefix)));
  assert.ok(tddReviewers.every((lane) => /Review Evidence Pack/.test(lane.taskPrefix)));
  assert.match(tddReviewers.find((lane) => lane.key === "spec").taskPrefix, /来源明确的内容不重复 read/);
  for (const text of [standardsSkill, specSkill, ...tddReviewers.map(lane => lane.taskPrefix)]) {
    assert.doesNotMatch(text, /首个工具步骤必须 read 当前 ticket|tracked.*逐文件使用|不要使用无 `path`/);
    assert.match(text, /截断/);
    assert.match(text, /hash/);
    assert.match(text, /安全\/数据完整性/);
  }

  const readme = await readFile(join(ROOT, "README.md"), "utf8");
  assert.match(readme, /reviewKind=worktree\|committed\|files/);
  assert.match(readme, /Spec lane 只接收 ticket acceptance matrix/);
  assert.match(readme, /只保留 hard 50 的只读工具预算/);
});

test("workflow schemas require structured output and distinct review axes", async () => {
  const registry = await buildRegistry(ROOT);
  const researchLane = registry.skills["matt-research"].workflow.lanes[0];
  assert.equal(researchLane.timeoutMs, 600000);
  assert.deepEqual(researchLane.outputSchema.required, ["question", "summary", "findings", "sources", "gaps"]);

  const prototypeLane = registry.skills["matt-prototype"].workflow.lanes[0];
  assert.equal(prototypeLane.timeoutMs, 1200000);
  assert.equal(prototypeLane.outputSchema.properties.status.enum.join(","), "BUILT,BLOCKED");
  assert.equal("turnBudget" in prototypeLane, false);
  assert.deepEqual(prototypeLane.gate, {
    field: "status",
    equals: "BUILT",
    nonEmpty: ["artifactPaths", "runInstructions", "reviewTargets", "changedFiles", "commands", "cleanupPlan"],
  });
  assert.deepEqual(prototypeLane.outputSchema.required, [
    "status", "summary", "question", "branch", "artifactPaths", "runInstructions", "reviewTargets", "changedFiles", "commands", "cleanupPlan", "residualRisks",
  ]);

  const scanLane = registry.skills["architecture-scan"].workflow.lanes[0];
  assert.equal(scanLane.timeoutMs, 1200000);
  assert.equal(scanLane.outputSchema.properties.status.enum.join(","), "REPORTED,BLOCKED");
  assert.deepEqual(scanLane.gate, { field: "status", equals: "REPORTED", nonEmpty: ["scopeEvidence", "commands"] });
  assert.equal(scanLane.outputSchema.properties.candidates.maxItems, 6);

  const designLanes = registry.skills["architecture-design"].workflow.lanes;
  assert.deepEqual(designLanes.map((lane) => lane.key), ["minimal", "flexible", "common-caller"]);
  assert.deepEqual(designLanes.map((lane) => lane.outputSchema.properties.strategy.enum[0]), ["minimal", "flexible", "common-caller"]);
  assert.ok(designLanes.every((lane) => lane.agent === "matt-reader"));
  assert.ok(designLanes.every((lane) => lane.timeoutMs === 600000));
  assert.ok(designLanes.every((lane) => lane.gate.field === "status" && lane.gate.equals === "COMPLETE"));
  assert.ok(designLanes.every((lane) => lane.gate.nonEmpty.join(",") === "entries,tradeoffs"));

  const [standards, spec] = registry.skills["matt-code-review"].workflow.lanes;
  assert.deepEqual(standards.outputSchema.properties.axis.enum, ["standards"]);
  assert.deepEqual(spec.outputSchema.properties.axis.enum, ["spec"]);
  for (const lane of [standards, spec]) {
    assert.equal(lane.timeoutMs, 900000);
    assert.equal("turnBudget" in lane, false);
    assert.deepEqual(lane.outputSchema.required, ["axis", "verdict", "summary", "findings", "notes"]);
    assert.equal(lane.outputSchema.properties.findings.items.properties.severity.enum.join(","), "P0,P1,P2");
  }

  const [implement, tddStandards, tddSpec] = registry.skills["matt-tdd"].workflow.lanes;
  assert.equal(implement.timeoutMs, 1200000);
  assert.equal(tddStandards.timeoutMs, 900000);
  assert.equal(tddSpec.timeoutMs, 900000);
  assert.equal(implement.outputSchema.properties.status.enum.join(","), "COMPLETE,BLOCKED");
  assert.equal("turnBudget" in implement, false);
  assert.deepEqual(implement.gate, {
    field: "status",
    equals: "COMPLETE",
    nonEmpty: ["confirmedSeams", "cycles", "changedFiles", "commands"],
  });
  assert.equal(implement.outputSchema.properties.confirmedSeams.minItems, 1);
  assert.equal(implement.outputSchema.properties.cycles.minItems, 1);
  assert.equal(implement.outputSchema.properties.commands.minItems, 2);
  assert.deepEqual(implement.outputSchema.properties.commands.items.required, ["command", "phase", "exitCode", "testCount", "outcome"]);
  const workerSkill = await readFile(join(ROOT, "skillpacks/leaf/tdd-executor/SKILL.md"), "utf8");
  assert.match(workerSkill, /Implementation Context Pack/);
  assert.match(workerSkill, /一次定向搜索/);
  assert.match(workerSkill, /最多扩展一层直接依赖/);
  assert.doesNotMatch(workerSkill, /读取 `\.x-matt\/context\/`、`\.x-matt\/adr\/`/);
  assert.equal(implement.outputSchema.properties.cycles.items.properties.redEvidence.minLength, 1);
  assert.equal(implement.outputSchema.properties.cycles.items.properties.greenEvidence.minLength, 1);
  assert.deepEqual([implement.stage, tddStandards.stage, tddSpec.stage], [1, 2, 2]);
  assert.deepEqual(tddStandards.gate, { field: "verdict", equals: "PASS" });
  assert.deepEqual(tddSpec.gate, { field: "verdict", equals: "PASS" });
});

test("TDD keeps full validation in the parent and filters low-value tests", async () => {
  const implementSkill = await readFile(join(ROOT, ".pi", "skills", "matt-implement", "SKILL.md"), "utf8");
  assert.match(implementSkill, /不得把父会话最终验证命令作为 worker 执行项下发/);
  assert.match(implementSkill, /显式 acceptance criterion.*必须有测试/);
  assert.match(implementSkill, /无分支且无业务语义.*低风险简单变更/);
  assert.match(implementSkill, /多个紧密相关的简单字段优先由一个行为级测试覆盖/);

  const tddSkill = await readFile(join(ROOT, ".pi", "skills", "matt-tdd", "SKILL.md"), "utf8");
  assert.match(tddSkill, /测试价值 gate/);
  assert.match(tddSkill, /完整测试套件.*worker 不得运行/);
  assert.match(tddSkill, /省略测试的候选项及理由/);

  const executorSkill = await readFile(join(ROOT, "skillpacks", "leaf", "tdd-executor", "SKILL.md"), "utf8");
  assert.match(executorSkill, /不要运行完整测试套件、全量 build/);
  assert.match(executorSkill, /不可达或规格明确排除的假设性边缘情况/);
  assert.match(executorSkill, /residualRisks.*未新增独立测试/);

  const workflow = JSON.parse(await readFile(join(ROOT, ".pi", "skills", "matt-tdd", "workflow.json"), "utf8"));
  assert.match(workflow.lanes[0].taskPrefix, /只运行任务列明的 RED\/GREEN 最小命令和 worker 相关回归命令/);
  assert.match(workflow.lanes[0].taskPrefix, /不得跳过显式验收/);

  const readme = await readFile(join(ROOT, "README.md"), "utf8");
  assert.match(readme, /完整测试套件、全量 build 与最终验证不下发给 worker/);
  assert.match(readme, /紧密相关的简单字段可以合并到一个行为级测试/);
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
    workflow.lanes[0].turnBudget = { maxTurns: 36, graceTurns: 4 };
    await write(path, `${JSON.stringify(workflow, null, 2)}\n`);
    await assert.rejects(() => buildRegistry(temp), /uses unsupported turnBudget/);
  });

  await withTempProject(async (temp) => {
    const path = join(temp, ".pi", "skills", "matt-tdd", "workflow.json");
    const workflow = JSON.parse(await readFile(path, "utf8"));
    workflow.lanes[0].key = "implement-settlement";
    await write(path, `${JSON.stringify(workflow, null, 2)}\n`);
    await assert.rejects(() => buildRegistry(temp), /reserved settlement suffix/);
  });

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
