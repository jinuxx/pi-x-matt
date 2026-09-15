import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createDispatchAuthorization, authorizeWorkflowDispatch } from "../../../lib/dispatch-authorization.mjs";
import {
  buildDispatchRequest,
  findProjectRoot,
  loadCurrentRegistry,
} from "../../../lib/dispatcher-core.mjs";

const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
const RPC_VERSION = 1;
const RPC_TIMEOUT_MS = 10_000;
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

type RpcReply =
  | { version: number; requestId: string; success: true; data: unknown }
  | { version: number; requestId: string; success: false; error?: { code?: string; message?: string } };

type PendingDispatch = {
  workflow: string;
  mode: string;
  lanes: Array<{ key: string; agent: string; skills: string[] }>;
  rpcParams: Record<string, unknown>;
};

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
  const pendingDispatches: PendingDispatch[] = [];
  const authorization = createDispatchAuthorization();

  // A matt-tdd dispatch only skips the runtime confirmation while the user
  // themself opened this session with `/skill:matt-implement`.
  pi.on("session_start", () => {
    authorization.reset();
  });

  pi.on("input", (event) => {
    authorization.observeInput(event.text, event.source);
  });

  pi.on("turn_end", async () => {
    const pending = pendingDispatches.splice(0);
    for (const dispatch of pending) {
      try {
        await requestRpc(pi, "spawn", dispatch.rpcParams);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        pi.sendUserMessage(
          `[pi_matt_dispatch] Failed to launch '${dispatch.workflow}' after validation: ${message}`,
          { deliverAs: "followUp" },
        );
      }
    }
  });

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
      const registry = await loadCurrentRegistry(PACKAGE_ROOT);
      const workflow = registry.skills[params.workflow];
      if (!workflow) throw new Error(`Unknown Pi-native workflow '${params.workflow}'`);

      const plan = buildDispatchRequest(registry, workflow, params.task, projectRoot);
      const authorizationReason = await authorizeWorkflowDispatch(workflow.name, signal, ctx, authorization);
      pendingDispatches.push({
        workflow: workflow.name,
        mode: workflow.workflow.mode,
        lanes: plan.lanes.map(({ key, agent, skills }) => ({ key, agent, skills })),
        rpcParams: plan.rpcParams,
      });
      const laneSummary = plan.lanes
        .map((lane) => `${lane.key}:${lane.agent}[${lane.skills.join(",")}]`)
        .join("; ");

      return {
        content: [{
          type: "text",
          text: `Validated and queued '${workflow.name}' (${workflow.workflow.mode}) via ${laneSummary}; it will launch after the current turn.`,
        }],
        details: {
          workflow: workflow.name,
          mode: workflow.workflow.mode,
          lanes: plan.lanes,
          queued: true,
          authorization: authorizationReason,
        },
      };
    },
  });
}
