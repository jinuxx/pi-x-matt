#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, "..");
const RESERVED_SKILL_NAMES = new Set(["pi-subagents"]);
const COMMON_METADATA = [
  "pi-scope",
  "pi-class",
  "pi-upstream-path",
  "pi-upstream-sha",
];
const LEAF_METADATA = ["pi-agent", "pi-dispatch", "pi-depends-on"];
const INTERACTION_METADATA = ["pi-dispatch", "pi-depends-on"];

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function unquote(value) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseSkillFrontmatter(content, sourcePath = "SKILL.md") {
  const normalized = content.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) {
    throw new Error(`${sourcePath}: missing YAML frontmatter`);
  }

  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) throw new Error(`${sourcePath}: unterminated YAML frontmatter`);

  const lines = normalized.slice(4, end).split("\n");
  const root = {};
  const metadata = {};
  let section = "root";

  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const match = line.trim().match(/^([a-zA-Z0-9-]+):(?:\s*(.*))?$/);
    if (!match) throw new Error(`${sourcePath}: unsupported frontmatter line: ${line}`);

    const [, key, rawValue = ""] = match;
    if (indent === 0) {
      section = key === "metadata" ? "metadata" : "root";
      if (key !== "metadata") root[key] = unquote(rawValue);
      continue;
    }

    if (indent === 2 && section === "metadata") {
      metadata[key] = unquote(rawValue);
      continue;
    }

    throw new Error(`${sourcePath}: only scalar root fields and two-space metadata fields are supported`);
  }

  return { ...root, metadata };
}

async function findSkillFiles(baseDir) {
  const found = [];

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name === "SKILL.md") found.push(path);
    }
  }

  await walk(baseDir);
  return found;
}

function splitDependencies(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function loadWorkflow(projectRoot, skillPath, skillName, agentNames, writerAgentNames) {
  const workflowPath = join(dirname(skillPath), "workflow.json");
  const sourcePath = assertProjectPath(projectRoot, workflowPath, "Workflow path");
  const raw = await readFile(workflowPath, "utf8").catch(() => {
    throw new Error(`${sourcePath}: parent skills require workflow.json`);
  });
  let workflow;
  try {
    workflow = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${sourcePath}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (workflow.version !== 1) throw new Error(`${sourcePath}: version must be 1`);
  if (workflow.name !== skillName) throw new Error(`${sourcePath}: name must match '${skillName}'`);
  if (workflow.mode !== "single" && workflow.mode !== "parallel" && workflow.mode !== "pipeline") {
    throw new Error(`${sourcePath}: mode must be 'single', 'parallel', or 'pipeline'`);
  }
  if (!Array.isArray(workflow.lanes) || workflow.lanes.length === 0) {
    throw new Error(`${sourcePath}: lanes must be a non-empty array`);
  }
  if (workflow.mode === "single" && workflow.lanes.length !== 1) {
    throw new Error(`${sourcePath}: single mode requires exactly one lane`);
  }
  if (workflow.mode === "parallel" && workflow.lanes.length < 2) {
    throw new Error(`${sourcePath}: parallel mode requires at least two lanes`);
  }
  if (workflow.mode === "pipeline" && workflow.lanes.length < 2) {
    throw new Error(`${sourcePath}: pipeline mode requires at least two lanes`);
  }

  const laneKeys = new Set();
  const lanes = workflow.lanes.map((lane, index) => {
    if (!isObject(lane)) throw new Error(`${sourcePath}: lane ${index} must be an object`);
    if (typeof lane.key !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(lane.key)) {
      throw new Error(`${sourcePath}: lane ${index} has an invalid key`);
    }
    if (lane.key.endsWith("-settlement")) {
      throw new Error(`${sourcePath}: lane '${lane.key}' uses reserved settlement suffix`);
    }
    if (laneKeys.has(lane.key)) throw new Error(`${sourcePath}: duplicate lane key '${lane.key}'`);
    laneKeys.add(lane.key);
    if (typeof lane.agent !== "string" || !agentNames.has(lane.agent)) {
      throw new Error(`${sourcePath}: lane '${lane.key}' has unknown agent '${String(lane.agent)}'`);
    }
    if (!Array.isArray(lane.skills) || lane.skills.length === 0 || lane.skills.some((name) => typeof name !== "string" || !name.trim())) {
      throw new Error(`${sourcePath}: lane '${lane.key}' requires non-empty skill names`);
    }
    if (typeof lane.taskPrefix !== "string" || !lane.taskPrefix.trim()) {
      throw new Error(`${sourcePath}: lane '${lane.key}' requires taskPrefix`);
    }
    if (!isObject(lane.outputSchema) || lane.outputSchema.type !== "object") {
      throw new Error(`${sourcePath}: lane '${lane.key}' outputSchema must have type 'object'`);
    }
    if (!isObject(lane.outputSchema.properties)) {
      throw new Error(`${sourcePath}: lane '${lane.key}' outputSchema requires properties`);
    }
    if (
      !Array.isArray(lane.outputSchema.required) ||
      lane.outputSchema.required.length === 0 ||
      lane.outputSchema.required.some((name) => typeof name !== "string" || !(name in lane.outputSchema.properties)) ||
      new Set(lane.outputSchema.required).size !== lane.outputSchema.required.length
    ) {
      throw new Error(`${sourcePath}: lane '${lane.key}' outputSchema requires unique declared properties`);
    }
    if (lane.outputSchema.additionalProperties !== false) {
      throw new Error(`${sourcePath}: lane '${lane.key}' outputSchema must set additionalProperties to false`);
    }
    if (!Number.isInteger(lane.timeoutMs) || lane.timeoutMs <= 0) {
      throw new Error(`${sourcePath}: lane '${lane.key}' requires a positive timeoutMs`);
    }
    if (lane.turnBudget !== undefined) {
      throw new Error(`${sourcePath}: lane '${lane.key}' uses unsupported turnBudget; pi-subagents 0.68 removed assistant turn budgets`);
    }

    let stage;
    if (workflow.mode === "pipeline") {
      if (!Number.isInteger(lane.stage) || lane.stage <= 0) {
        throw new Error(`${sourcePath}: pipeline lane '${lane.key}' requires a positive stage`);
      }
      stage = lane.stage;
    } else if (lane.stage !== undefined) {
      throw new Error(`${sourcePath}: only pipeline lanes may define stage`);
    }

    let gate;
    if (lane.gate !== undefined) {
      if (
        !isObject(lane.gate) ||
        typeof lane.gate.field !== "string" ||
        !lane.gate.field ||
        !(lane.gate.field in lane.outputSchema.properties) ||
        typeof lane.gate.equals !== "string"
      ) {
        throw new Error(`${sourcePath}: lane '${lane.key}' has an invalid gate`);
      }
      const gatedProperty = lane.outputSchema.properties[lane.gate.field];
      if (!isObject(gatedProperty) || !Array.isArray(gatedProperty.enum) || !gatedProperty.enum.includes(lane.gate.equals)) {
        throw new Error(`${sourcePath}: lane '${lane.key}' gate must match a declared enum value`);
      }
      let nonEmpty;
      if (lane.gate.nonEmpty !== undefined) {
        if (
          !Array.isArray(lane.gate.nonEmpty) ||
          lane.gate.nonEmpty.length === 0 ||
          lane.gate.nonEmpty.some((name) => typeof name !== "string" || lane.outputSchema.properties[name]?.type !== "array") ||
          new Set(lane.gate.nonEmpty).size !== lane.gate.nonEmpty.length
        ) {
          throw new Error(`${sourcePath}: lane '${lane.key}' gate.nonEmpty must name unique array properties`);
        }
        nonEmpty = [...lane.gate.nonEmpty];
      }
      gate = { field: lane.gate.field, equals: lane.gate.equals, ...(nonEmpty ? { nonEmpty } : {}) };
    }

    return {
      key: lane.key,
      ...(stage !== undefined ? { stage } : {}),
      agent: lane.agent,
      skills: [...new Set(lane.skills.map((name) => name.trim()))],
      timeoutMs: lane.timeoutMs,
      taskPrefix: lane.taskPrefix.trim(),
      ...(gate ? { gate } : {}),
      outputSchema: lane.outputSchema,
    };
  });

  if (workflow.mode === "pipeline") {
    const stages = [...new Set(lanes.map((lane) => lane.stage))].sort((a, b) => a - b);
    if (stages.length < 2 || stages.some((stage, index) => stage !== index + 1)) {
      throw new Error(`${sourcePath}: pipeline stages must be contiguous and include at least stages 1 and 2`);
    }
  }

  const writableLanes = lanes.filter((lane) => writerAgentNames.has(lane.agent));
  if (writableLanes.length > 1) {
    throw new Error(`${sourcePath}: workflow may define at most one writer lane`);
  }

  return {
    path: sourcePath,
    digest: sha256(raw),
    definition: { version: 1, name: skillName, mode: workflow.mode, lanes },
  };
}

function assertAbsentMetadata(metadata, keys, sourcePath, kind) {
  for (const key of keys) {
    if (key in metadata) throw new Error(`${sourcePath}: ${kind} must not define metadata.${key}`);
  }
}

async function assertNoWorkflow(projectRoot, skillPath, skillName) {
  const workflowPath = join(dirname(skillPath), "workflow.json");
  try {
    await readFile(workflowPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${assertProjectPath(projectRoot, workflowPath, "Workflow path")}: interaction parent '${skillName}' must not define workflow.json`);
}

function assertProjectPath(root, path, label) {
  const rel = relative(root, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`${label} must be inside the project root`);
  }
  return rel.split(sep).join("/");
}

async function loadAgentRouting(root) {
  const agentDir = join(root, ".pi", "agents");
  const names = new Set();
  const writerNames = new Set();
  const entries = await readdir(agentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const path = join(agentDir, entry.name);
    const parsed = parseSkillFrontmatter(await readFile(path, "utf8"), assertProjectPath(root, path, "Agent path"));
    if (!parsed.name) throw new Error(`${path}: missing agent name`);
    if (parsed.acceptanceRole !== "writer" && parsed.acceptanceRole !== "read-only") {
      throw new Error(`${path}: acceptanceRole must be 'writer' or 'read-only'`);
    }
    names.add(parsed.name);
    if (parsed.acceptanceRole === "writer") writerNames.add(parsed.name);
  }
  return { names, writerNames };
}

function assertNoDependencyCycles(entriesByName) {
  const visiting = new Set();
  const visited = new Set();

  function visit(name, chain) {
    if (visiting.has(name)) throw new Error(`Skill dependency cycle: ${[...chain, name].join(" -> ")}`);
    if (visited.has(name)) return;
    visiting.add(name);
    const entry = entriesByName.get(name);
    for (const dependency of entry.dependsOn) visit(dependency, [...chain, name]);
    visiting.delete(name);
    visited.add(name);
  }

  for (const name of entriesByName.keys()) visit(name, []);
}

export async function buildRegistry(root = DEFAULT_ROOT) {
  const projectRoot = resolve(root);
  const upstreamSha = (await readFile(join(projectRoot, "vendor", "UPSTREAM_SHA"), "utf8")).trim();
  if (!/^[0-9a-f]{40}$/.test(upstreamSha)) throw new Error("vendor/UPSTREAM_SHA must contain a full 40-character Git SHA");

  const { names: agentNames, writerNames: writerAgentNames } = await loadAgentRouting(projectRoot);
  const sourceRoots = [
    { scope: "parent", dir: join(projectRoot, ".pi", "skills") },
    { scope: "leaf", dir: join(projectRoot, "skillpacks", "leaf") },
  ];
  const entries = [];

  for (const sourceRoot of sourceRoots) {
    for (const skillPath of await findSkillFiles(sourceRoot.dir)) {
      const sourcePath = assertProjectPath(projectRoot, skillPath, "Skill path");
      const content = await readFile(skillPath, "utf8");
      const parsed = parseSkillFrontmatter(content, sourcePath);
      const metadata = parsed.metadata;

      if (!parsed.name || !parsed.description) throw new Error(`${sourcePath}: name and description are required`);
      if (RESERVED_SKILL_NAMES.has(parsed.name)) throw new Error(`${sourcePath}: '${parsed.name}' is reserved`);
      for (const key of COMMON_METADATA) {
        if (!(key in metadata)) throw new Error(`${sourcePath}: metadata.${key} is required`);
      }
      if (metadata["pi-scope"] !== sourceRoot.scope) {
        throw new Error(`${sourcePath}: metadata.pi-scope must be '${sourceRoot.scope}'`);
      }
      if (metadata["pi-upstream-sha"] !== upstreamSha) {
        throw new Error(`${sourcePath}: pi-upstream-sha does not match vendor/UPSTREAM_SHA`);
      }
      if (
        sourceRoot.scope === "parent" &&
        metadata["pi-class"] !== "orchestration" &&
        metadata["pi-class"] !== "interaction"
      ) {
        throw new Error(`${sourcePath}: parent metadata.pi-class must be 'orchestration' or 'interaction'`);
      }
      if (sourceRoot.scope === "leaf" && metadata["pi-class"] !== "executor" && metadata["pi-class"] !== "reviewer") {
        throw new Error(`${sourcePath}: leaf metadata.pi-class must be 'executor' or 'reviewer'`);
      }

      const upstreamRoot = join(projectRoot, "vendor", "mattpocock-skills");
      const upstreamPath = resolve(upstreamRoot, metadata["pi-upstream-path"]);
      assertProjectPath(upstreamRoot, upstreamPath, `Upstream path for '${parsed.name}'`);
      const upstreamContent = await readFile(upstreamPath, "utf8").catch(() => {
        throw new Error(`${sourcePath}: upstream path not found: ${metadata["pi-upstream-path"]}`);
      });

      let agent;
      let dispatch;
      let dependsOn;
      let workflow;
      let workflowPath;
      let workflowDigest;
      if (sourceRoot.scope === "parent") {
        if (metadata["pi-class"] === "orchestration") {
          assertAbsentMetadata(metadata, ["pi-agent", "pi-dispatch", "pi-depends-on"], sourcePath, "orchestration parent skills");
          const loaded = await loadWorkflow(projectRoot, skillPath, parsed.name, agentNames, writerAgentNames);
          workflow = loaded.definition;
          workflowPath = loaded.path;
          workflowDigest = loaded.digest;
          dispatch = workflow.mode;
          dependsOn = [...new Set(workflow.lanes.flatMap((lane) => lane.skills))];
          const agents = [...new Set(workflow.lanes.map((lane) => lane.agent))];
          agent = agents.length === 1 ? agents[0] : null;
        } else {
          assertAbsentMetadata(metadata, ["pi-agent"], sourcePath, "interaction parent skills");
          for (const key of INTERACTION_METADATA) {
            if (!(key in metadata)) throw new Error(`${sourcePath}: metadata.${key} is required for interaction parent skills`);
          }
          if (metadata["pi-dispatch"] !== "none") {
            throw new Error(`${sourcePath}: interaction parent metadata.pi-dispatch must be 'none'`);
          }
          await assertNoWorkflow(projectRoot, skillPath, parsed.name);
          agent = null;
          dispatch = "none";
          dependsOn = splitDependencies(metadata["pi-depends-on"]);
        }
      } else {
        for (const key of LEAF_METADATA) {
          if (!(key in metadata)) throw new Error(`${sourcePath}: metadata.${key} is required for leaf skills`);
        }
        if (!agentNames.has(metadata["pi-agent"])) {
          throw new Error(`${sourcePath}: unknown metadata.pi-agent '${metadata["pi-agent"]}'`);
        }
        if (metadata["pi-dispatch"] !== "none") {
          throw new Error(`${sourcePath}: leaf metadata.pi-dispatch must be 'none'`);
        }
        agent = metadata["pi-agent"];
        dispatch = "none";
        dependsOn = splitDependencies(metadata["pi-depends-on"]);
      }

      entries.push({
        name: parsed.name,
        description: parsed.description,
        scope: metadata["pi-scope"],
        class: metadata["pi-class"],
        agent,
        dispatch,
        dependsOn,
        sourcePath,
        sourceDigest: sha256(content),
        ...(workflow ? { workflowPath, workflowDigest, workflow } : {}),
        upstreamPath: metadata["pi-upstream-path"],
        upstreamSha: metadata["pi-upstream-sha"],
        upstreamDigest: sha256(upstreamContent),
      });
    }
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  const entriesByName = new Map();
  for (const entry of entries) {
    if (entriesByName.has(entry.name)) throw new Error(`Duplicate skill name: ${entry.name}`);
    entriesByName.set(entry.name, entry);
  }

  for (const entry of entries) {
    for (const dependency of entry.dependsOn) {
      const target = entriesByName.get(dependency);
      if (!target) throw new Error(`${entry.name}: missing dependency '${dependency}'`);
      if (entry.scope === "parent" && entry.class === "interaction") {
        if (target.scope !== "parent" || target.class !== "interaction") {
          throw new Error(`${entry.name}: interaction dependency '${dependency}' must be an interaction parent skill`);
        }
      } else {
        if (target.scope !== "leaf") throw new Error(`${entry.name}: dependency '${dependency}' must be a leaf skill`);
        if (entry.scope === "leaf" && target.agent !== entry.agent) {
          throw new Error(`${entry.name}: dependency '${dependency}' targets agent '${target.agent}', expected '${entry.agent}'`);
        }
      }
    }

    if (entry.scope === "parent" && entry.class === "orchestration") {
      for (const lane of entry.workflow.lanes) {
        for (const skillName of lane.skills) {
          const target = entriesByName.get(skillName);
          if (!target) throw new Error(`${entry.name}: lane '${lane.key}' has missing skill '${skillName}'`);
          if (target.scope !== "leaf") throw new Error(`${entry.name}: lane '${lane.key}' skill '${skillName}' must be leaf`);
          if (target.agent !== lane.agent) {
            throw new Error(`${entry.name}: lane '${lane.key}' cannot grant '${skillName}' to agent '${lane.agent}'`);
          }
        }
      }
    } else if (entry.scope === "parent") {
      if (entry.class !== "interaction" || entry.dispatch !== "none" || entry.agent !== null) {
        throw new Error(`${entry.name}: invalid interaction parent routing`);
      }
    } else if (entry.dispatch !== "none") {
      throw new Error(`${entry.name}: leaf dispatch must be 'none'`);
    }
  }

  assertNoDependencyCycles(entriesByName);

  return {
    version: 1,
    upstream: {
      repository: "https://github.com/mattpocock/skills",
      sha: upstreamSha,
    },
    skills: Object.fromEntries(entries.map((entry) => [entry.name, entry])),
  };
}

export function serializeRegistry(registry) {
  return `${JSON.stringify(registry, null, 2)}\n`;
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  const outputPath = join(DEFAULT_ROOT, "config", "skill-registry.json");
  const expected = serializeRegistry(await buildRegistry(DEFAULT_ROOT));

  if (checkOnly) {
    const current = await readFile(outputPath, "utf8").catch(() => "");
    if (current !== expected) {
      console.error("config/skill-registry.json is stale; run npm run registry");
      process.exitCode = 1;
      return;
    }
    console.log("skill registry is current");
    return;
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, expected, "utf8");
  console.log(`wrote ${relative(DEFAULT_ROOT, outputPath)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
