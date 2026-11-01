import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerWorkflowResource } from "pi-subagents/workflow-resources";
import { createImplementationRuntime } from "../../../lib/implementation-runtime.mjs";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const text = () => Type.String({ minLength: 1 });
const strings = () => Type.Array(text(), { minItems: 1 });

export default function (pi: ExtensionAPI) {
  const runtime = createImplementationRuntime(pi, PACKAGE_ROOT);
  let resource: { dispose(): void } | undefined;
  let unsubscribe: Array<() => void> = [];
  const observeRuntime = () => [
    pi.events.on("subagent:async-complete", event => {
      runtime.completion(event).catch(error => {
        if (runtime.isActive()) pi.sendUserMessage(
          `[pi_matt_dispatch] Completion evidence unavailable: ${error.message}; do not repeat implementation.`,
          { deliverAs: "followUp" },
        );
      });
    }),
    pi.events.on("subagent:child-status", event => runtime.childStatus(event)),
    pi.events.on("subagent:jobs-changed", () => {
      runtime.progress().catch(() => {
        // Native completion remains authoritative; do not retry or wake the model on transient progress reads.
      });
    }),
  ];

  pi.on("session_start", (event, ctx) => {
    for (const dispose of unsubscribe) dispose();
    unsubscribe = observeRuntime();
    runtime.start(ctx, event.reason);
    resource?.dispose();
    resource = registerWorkflowResource({
      sessionId: ctx.sessionManager.getSessionId(),
      definition: { name: "pi-x-matt.tdd", version: 1, resolve: args => runtime.resolve(args) },
    });
  });
  pi.on("session_shutdown", () => {
    resource?.dispose();
    resource = undefined;
    runtime.shutdown();
    for (const dispose of unsubscribe) dispose?.();
    unsubscribe = [];
  });
  pi.on("session_tree", () => runtime.revoke("session-tree-changed"));
  pi.on("input", event => runtime.input(event));
  pi.on("turn_end", () => runtime.flush());

  pi.registerTool({
    name: "pi_matt_dispatch",
    label: "Pi Matt Dispatch",
    description: "Validate and asynchronously dispatch registered least-privilege workflows. matt-tdd repair resumes only the writer; review dispatches both reviewers; reconsider runs only challenged axes. For matt-code-review an optional committed reviewScope makes the host resolve and pin the range and capture one object-only Pack before both reviewers. Follow-ups reference host-owned dispatch IDs.",
    promptSnippet: "Dispatch a registered Pi-native workflow through a least-privilege leaf subagent",
    promptGuidelines: [
      "Use pi_matt_dispatch for workflows defined by this project's parent skills; never bypass registry validation.",
      "Initial matt-tdd and matt-code-review require complete laneTasks; follow-ups need only tasks for lanes actually run. Never cross writer/reviewer or Standards/Spec instructions.",
      "For matt-code-review, pass reviewScope {kind:'committed', fixedPoint} only when the review target is already-committed history. The host resolves F, verifies ancestry of the current HEAD and pins H; it captures one read-only Git-object Pack before both reviewers. Never pass your own hash, HEAD, path or command. Omit reviewScope for the existing manual worktree/files evidence path.",
      "For matt-tdd provide implementation. Reuse its exact approved scope; repair runs only the retained writer, then use review when ready or repair again on evidence. Pending review is not delivery approval. Use recovery for failed reviewers or at most two report corrections per axis per candidate; disputed valid FAIL findings use reconsider. DIAGNOSIS_REQUIRED stops patch dispatch.",
      "Only matt-tdd accepts batch. One honest TUI/RPC confirmation seals the declared spec/tickets and exact envelopes (24h maximum); declared serial tickets then dispatch without extra prompts, but undeclared tickets, files or commands fail closed and need a new explicit batch confirmation. A batch ticket's commit must match the host-captured dual-PASS (or separately user-confirmed risk-accepted) candidate tree and parent, and the local tracker writeback including any Risk acceptance receipt must match it, before the next ticket. Passing batch metadata never self-authorizes.",
      "acceptRisk is a separate terminal delivery decision, not PASS: only all remaining ordinary standards P2 findings may be accepted, with a fresh real user confirmation bound to the exact candidate. Never waive acceptance, safety, integrity, P0/P1, missing reports or candidate drift; implementation/batch approval and task prose do not authorize risk acceptance. Record the host receipt alongside the exact implementation commit. Committed code-review recovery reuses its original Pack and only reruns failed axes once; omit reviewScope.",
    ],
    parameters: Type.Object({
      workflow: text(),
      task: Type.String({ minLength: 1, description: "Shared facts safe for every lane; complete laneTasks replace this text." }),
      laneTasks: Type.Optional(Type.Record(Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$" }), text())),
      reviewScope: Type.Optional(Type.Object({
        kind: Type.Literal("committed"),
        fixedPoint: Type.String({ minLength: 1, description: "Git ref resolved by the host to a full commit SHA; it must be an ancestor of the current HEAD. Equal to HEAD yields an allowed empty range." }),
      }, { additionalProperties: false, description: "matt-code-review only: host captures only the committed F..H Git objects once before both reviewers. Worktree, staged, untracked and out-of-project content are excluded; omission keeps the existing manual evidence path." })),
      implementation: Type.Optional(Type.Object({
        ticket: Type.String({ minLength: 1, description: "Exact active project-relative ticket path, or slice:<stable-id> for an approved direct slice." }),
        scope: Type.String({ minLength: 1, description: "Stable approved behavior/contract and architecture boundaries; unchanged across repairs." }),
        allowedFiles: strings(),
        diagnosticFiles: Type.Optional(Type.Array(text(), {
          description: "Exact subset of allowedFiles the host may add or replace only inside its isolated diagnostic workspace.",
        })),
        diagnosticCommands: Type.Optional(Type.Array(text(), { description: "Exact approved local repro commands; runtime diagnosis is bounded to 30 seconds." })),
      })),
      repair: Type.Optional(Type.Object({
        previousDispatchId: text(),
        groups: Type.Array(Type.Object({
          id: text(), findingIds: strings(), contract: text(), preserve: strings(),
          validationOrder: text(), callPath: strings(), examples: strings(),
        }), { minItems: 1 }),
        diagnosis: Type.Optional(Type.Object({
          rootCauseIds: strings(), explanation: text(), prediction: text(),
          command: text(), expectedFailure: text(),
          testFiles: Type.Optional(Type.Array(Type.Object({
            path: text(),
            content: Type.String({ minLength: 1, description: "Inline reproduction test/fixture content; never a trusted path, cwd or snapshot claim." }),
          }), { minItems: 1, description: "Host writes these only to implementation.diagnosticFiles inside the reviewed-state isolation." })),
        })),
      })),
      batch: Type.Optional(Type.Object({
        spec: Type.String({ minLength: 1, description: "Exact active Local Markdown parent spec path (Type: spec, Status: spec-ready)." }),
        fixedPoint: Type.String({ minLength: 1, description: "Original full commit SHA; the host verifies it exists and is an ancestor of the approved starting HEAD." }),
        tickets: Type.Array(Type.Object({
          ticket: Type.String({ minLength: 1, description: "Exact active declared ticket path; Parent must equal the approved spec." }),
          scope: Type.String({ minLength: 1, description: "Approved behavior/contract and architecture boundary for this ticket." }),
          allowedFiles: strings(),
          diagnosticFiles: Type.Optional(Type.Array(text(), { description: "Exact subset of allowedFiles for host-isolated diagnostics only." })),
          diagnosticCommands: Type.Optional(Type.Array(text(), { description: "Exact approved local repro commands." })),
        }), { minItems: 1, description: "Declared serial ticket list; the host freezes each ticket's requirement content, Parent and Blocked by graph." }),
      }, { description: "One-confirmation batch capability for declared serial matt-tdd tickets. The host reads actual spec/ticket digests; model-provided hashes or authorization are never accepted. No implicit batch from matt-implement-spec or a plain intent." })),
      review: Type.Optional(Type.Object({
        dispatchId: Type.String({ minLength: 1, description: "Latest completed repair dispatch. Review its pinned cumulative increment with both axes, without running the writer." }),
      })),
      reconsider: Type.Optional(Type.Object({
        dispatchId: text(),
        findings: Type.Array(Type.Object({
          findingId: Type.String({ minLength: 1, description: "Current valid blocking finding with its axis prefix, e.g. spec:F1." }),
          reason: Type.String({ minLength: 1, description: "Why this specific finding is disputed; never erase a finding by prose." }),
          evidence: Type.String({ minLength: 1, description: "Concrete acceptance, standard or tracked evidence supporting the challenge." }),
        }), { minItems: 1 }),
      }, { description: "At most one reconsideration per axis per candidate snapshot. Fresh reviewers decide uphold/withdraw for exactly these findings; no writer, collector or unrelated axis runs." })),
      recovery: Type.Optional(Type.Object({
        dispatchId: text(),
        lanes: Type.Array(Type.Union([Type.Literal("standards"), Type.Literal("spec")]), { minItems: 1, maxItems: 2 }),
      }, { description: "Rerun failed reviewer lanes. Execution recovery is separate from at most two report corrections per axis per candidate; a valid FAIL cannot use recovery." })),
      acceptRisk: Type.Optional(Type.Object({
        dispatchId: text(),
        findingIds: strings(),
        reason: text(),
        evidence: text(),
      }, { additionalProperties: false, description: "matt-tdd or committed matt-code-review only. Accept ALL remaining ordinary standards P2 findings after a fresh real user confirmation for this exact candidate; retain original FAIL and an auditable accepted-risk terminal receipt. No laneTasks needed; never waive acceptance/safety/integrity/P0/P1." })),
    }),
    execute: (_id, params, signal, _update, ctx) => runtime.dispatch(params, signal, ctx),
  });
}
