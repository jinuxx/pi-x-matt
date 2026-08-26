import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
const RPC_VERSION = 1;
const RPC_TIMEOUT_MS = 10_000;

type WorkflowLane = {
  key: string;
  agent: string;
  skills: string[];
  timeoutMs: number;
  turnBudget: { maxTurns: number; graceTurns?: number };
  taskPrefix: string;
  outputSchema: Record<string, unknown>;
};

type RegistrySkill = {
  name: string;
  scope: "parent" | "leaf";
  class: string;
  agent: string | null;
  dispatch: "single" | "parallel" | "none";
  dependsOn: string[];
  sourcePath: string;
  sourceDigest: string;
  workflowPath?: string;
  workflowDigest?: string;
  workflow?: {
    version: 1;
    name: string;
    mode: "single" | "parallel";
    lanes: WorkflowLane[];
  };
};

type Registry = {
  version: number;
  skills: Record<string, RegistrySkill>;
};

type RpcReply =
  | { version: number; requestId: string; success: true; data: unknown }
  | { version: number; requestId: string; success: false; error?: { code?: string; message?: string } };

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function findProjectRoot(cwd: string): Promise<string> {
  let current = resolve(cwd);
  while (true) {
    const settingsPath = join(current, ".pi", "settings.json");
    try {
      await readFile(settingsPath, "utf8");
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) throw new Error("pi-matt-dispatch requires a project .pi/settings.json");
      current = parent;
    }
  }
}

async function loadCurrentRegistry(projectRoot: string): Promise<Registry> {
  const registryPath = join(projectRoot, "config", "skill-registry.json");
  const registry = JSON.parse(await readFile(registryPath, "utf8")) as Registry;
  if (registry.version !== 1 || !registry.skills || typeof registry.skills !== "object") {
    throw new Error("Unsupported or malformed config/skill-registry.json; run npm run registry");
  }

  for (const entry of Object.values(registry.skills)) {
    const sourcePath = join(projectRoot, entry.sourcePath);
    const current = await readFile(sourcePath, "utf8").catch(() => null);
    if (current === null || sha256(current) !== entry.sourceDigest) {
      throw new Error(`Registry is stale for '${entry.name}'; run npm run registry`);
    }
    if (entry.scope === "parent") {
      if (!entry.workflowPath || !entry.workflowDigest || !entry.workflow) {
        throw new Error(`Registry has no workflow definition for '${entry.name}'`);
      }
      const workflowSource = await readFile(join(projectRoot, entry.workflowPath), "utf8").catch(() => null);
      if (workflowSource === null || sha256(workflowSource) !== entry.workflowDigest) {
        throw new Error(`Workflow registry is stale for '${entry.name}'; run npm run registry`);
      }
    }
  }

  return registry;
}

function resolveLeafClosure(registry: Registry, workflowName: string, lane: WorkflowLane): RegistrySkill[] {
  const resolved: RegistrySkill[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(name: string): void {
    if (visiting.has(name)) throw new Error(`Skill dependency cycle at '${name}'`);
    if (visited.has(name)) return;
    const entry = registry.skills[name];
    if (!entry) throw new Error(`Workflow '${workflowName}' has missing dependency '${name}'`);
    if (entry.scope !== "leaf") throw new Error(`Workflow dependency '${name}' is not a leaf skill`);
    if (entry.agent !== lane.agent) {
      throw new Error(`Workflow '${workflowName}' lane '${lane.key}' cannot grant '${name}' to agent '${lane.agent}'`);
    }

    visiting.add(name);
    for (const dependency of entry.dependsOn) visit(dependency);
    visiting.delete(name);
    visited.add(name);
    resolved.push(entry);
  }

  for (const skillName of lane.skills) visit(skillName);
  return resolved;
}

function requestRpc(pi: ExtensionAPI, method: string, params: unknown): Promise<unknown> {
  const requestId = randomUUID();
  const replyEvent = `${RPC_REPLY_PREFIX}${requestId}`;

  return new Promise((resolveReply, rejectReply) => {
    let done = false;
    let unsubscribe: (() => void) | undefined;
    const finish = (callback: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe?.();
      callback();
    };
    const timer = setTimeout(() => {
      finish(() => rejectReply(new Error("pi-subagents RPC did not reply; verify the extension-only package filter and reload Pi")));
    }, RPC_TIMEOUT_MS);

    const maybeUnsubscribe = pi.events.on(replyEvent, (payload) => {
      const reply = payload as RpcReply;
      if (!reply || reply.requestId !== requestId || reply.version !== RPC_VERSION) return;
      finish(() => {
        if (reply.success) resolveReply(reply.data);
        else rejectReply(new Error(`${reply.error?.code ?? "rpc_error"}: ${reply.error?.message ?? "pi-subagents spawn failed"}`));
      });
    });
    if (typeof maybeUnsubscribe === "function") unsubscribe = maybeUnsubscribe;

    pi.events.emit(RPC_REQUEST_EVENT, {
      version: RPC_VERSION,
      requestId,
      method,
      params,
      source: { extension: "pi-x-matt" },
    });
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "pi_matt_dispatch",
    label: "Pi Matt Dispatch",
    description: "Validate a Pi-native parent workflow against the generated registry, compute its private leaf-skill closure, and launch the allowed project subagent asynchronously through pi-subagents.",
    promptSnippet: "Dispatch a registered Pi-native workflow through a least-privilege leaf subagent",
    promptGuidelines: [
      "Use pi_matt_dispatch for workflows defined by this project's parent skills; do not bypass its registry validation with a direct subagent launch.",
    ],
    parameters: Type.Object({
      workflow: Type.String({ description: "Parent workflow skill name, for example research" }),
      task: Type.String({ minLength: 1, description: "Concrete delegated task, evidence requirements, output contract, and stop conditions" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      if (!ctx.isProjectTrusted()) throw new Error("pi-matt-dispatch refuses untrusted project configuration");

      const projectRoot = await findProjectRoot(ctx.cwd);
      const registry = await loadCurrentRegistry(projectRoot);
      const workflow = registry.skills[params.workflow];
      if (!workflow) throw new Error(`Unknown Pi-native workflow '${params.workflow}'`);
      if (workflow.scope !== "parent" || workflow.class !== "orchestration") {
        throw new Error(`'${params.workflow}' is not a parent orchestration workflow`);
      }
      if (!workflow.workflow || workflow.workflow.mode !== workflow.dispatch) {
        throw new Error(`Workflow '${params.workflow}' has an invalid generated routing definition`);
      }
      if (!params.task.trim()) throw new Error("Dispatch task must not be empty");

      const lanes = workflow.workflow.lanes.map((lane) => {
        const leafSkills = resolveLeafClosure(registry, workflow.name, lane);
        if (leafSkills.length === 0) throw new Error(`Workflow '${workflow.name}' lane '${lane.key}' has no leaf skills`);
        return {
          key: lane.key,
          agent: lane.agent,
          skills: leafSkills.map((entry) => entry.name),
          task: `${lane.taskPrefix}\n\n委派任务：\n${params.task.trim()}`,
          timeoutMs: lane.timeoutMs,
          turnBudget: lane.turnBudget,
          outputSchema: lane.outputSchema,
        };
      });

      let result;
      if (workflow.workflow.mode === "single") {
        const lane = lanes[0];
        result = await requestRpc(pi, "spawn", {
          agent: lane.agent,
          task: lane.task,
          context: "fresh",
          cwd: projectRoot,
          skill: lane.skills,
          timeoutMs: lane.timeoutMs,
          turnBudget: lane.turnBudget,
          outputSchema: lane.outputSchema,
          async: true,
          mission: false,
          output: `${workflow.name}-${lane.key}.json`,
        });
      } else {
        const items = lanes.map((lane) => ({
          key: lane.key,
          agent: lane.agent,
          task: lane.task,
          context: "fresh",
          skill: lane.skills,
          timeoutMs: lane.timeoutMs,
          turnBudget: lane.turnBudget,
          outputSchema: lane.outputSchema,
          output: `${workflow.name}-${lane.key}.json`,
        }));
        const workflowScript = `const results = await runs.all(${JSON.stringify(items)}); return results;`;
        result = await requestRpc(pi, "spawn", {
          workflowScript,
          cwd: projectRoot,
          async: true,
          mission: false,
        });
      }

      const laneSummary = lanes.map((lane) => `${lane.key}:${lane.agent}[${lane.skills.join(",")}]`).join("; ");
      return {
        content: [{
          type: "text",
          text: `Dispatched '${workflow.name}' (${workflow.workflow.mode}) via ${laneSummary}.`,
        }],
        details: { workflow: workflow.name, mode: workflow.workflow.mode, lanes, rpc: result },
      };
    },
  });
}
