import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerWorkflowResource } from "pi-subagents/workflow-resources";
import { createDispatchService, DISPATCH_RESOURCE } from "../../../lib/dispatch-service.mjs";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const text = () => Type.String({ minLength: 1 });

export default function (pi: ExtensionAPI) {
  const service = createDispatchService(pi, PACKAGE_ROOT);
  let resource: { dispose(): void } | undefined;
  let unsubscribe: Array<() => void> = [];

  const observe = () => [
    pi.events.on("subagent:async-complete", (event) => {
      service.completion(event).catch((error) => {
        if (service.isActive()) {
          pi.sendUserMessage(`[pi_matt_dispatch] Completion check error: ${error.message}`, { deliverAs: "followUp" });
        }
      });
    }),
    pi.events.on("subagent:child-status", (event) => service.childStatus(event)),
  ];

  pi.on("session_start", (_event, ctx) => {
    for (const dispose of unsubscribe) dispose();
    unsubscribe = observe();
    service.start(ctx);
    resource?.dispose();
    resource = registerWorkflowResource({
      sessionId: ctx.sessionManager.getSessionId(),
      definition: { name: DISPATCH_RESOURCE, version: 1, resolve: (args) => service.resolve(args) },
    });
  });

  pi.on("session_shutdown", () => {
    resource?.dispose();
    resource = undefined;
    service.shutdown();
    for (const dispose of unsubscribe) dispose();
    unsubscribe = [];
  });

  pi.on("session_tree", () => service.reset("session-tree-changed"));
  pi.on("turn_end", () => service.flush());

  pi.registerCommand("matt-reset", {
    description: "Clear stuck active dispatch state and cancel queued dispatches",
    handler: (args, ctx) => {
      if (args.trim() || !["tui", "rpc"].includes(ctx.mode)) throw new Error("Usage: /matt-reset (TUI/RPC)");
      service.reset("user-reset");
      ctx.ui.notify("Cleared active dispatch tracking and queued dispatches.", "info");
    },
  });

  pi.registerTool({
    name: "pi_matt_dispatch",
    label: "Pi Matt Dispatch",
    description: "Validate and asynchronously dispatch registered Pi-native workflows (matt-tdd, matt-code-review, matt-research, matt-prototype, architecture-scan, architecture-design).",
    promptSnippet: "Dispatch a registered Pi-native workflow through a role-isolated leaf subagent",
    promptGuidelines: [
      "Use pi_matt_dispatch for registered execution workflows (matt-tdd, matt-code-review, matt-research, matt-prototype, architecture-scan, architecture-design).",
      "For matt-tdd, pass focused deterministic verifyCommands when available; pass resumeRunId to continue a previous writer or omit it to start a fresh writer anytime.",
      "For matt-code-review, pass reviewScope { kind: 'worktree' } for uncommitted changes or { kind: 'committed', fixedPoint } for committed ranges. Both axes return advisory reports without blocking the workflow.",
      "If one lane fails due to provider/network errors, rerun only that lane with lanes: ['<key>'].",
    ],
    parameters: Type.Object({
      workflow: text(),
      task: Type.String({ minLength: 1, description: "Shared task context for the workflow." }),
      laneTasks: Type.Optional(Type.Record(Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$" }), text())),
      lanes: Type.Optional(Type.Array(text(), {
        minItems: 1,
        description: "Optional subset of lane keys to execute (e.g. ['standards'] to rerun a failed review axis).",
      })),
      resumeRunId: Type.Optional(Type.String({
        minLength: 1,
        description: "matt-tdd only: resume a previous matt-worker runId. Omit to start a fresh writer.",
      })),
      verifyCommands: Type.Optional(Type.Array(text(), {
        maxItems: 8,
        description: "matt-tdd only: deterministic check commands run by the host after the writer returns COMPLETE.",
      })),
      reviewScope: Type.Optional(Type.Object({
        kind: Type.Union([Type.Literal("worktree"), Type.Literal("committed")]),
        fixedPoint: Type.Optional(Type.String({
          minLength: 1,
          description: "Required when kind is 'committed': Git ref that is an ancestor of HEAD.",
        })),
      }, {
        additionalProperties: false,
        description: "matt-code-review only: host captures one shared Git Evidence Pack before launching reviewers.",
      })),
    }),
    execute: (_id, params, signal, _update, ctx) => service.dispatch(params, signal, ctx),
  });
}
