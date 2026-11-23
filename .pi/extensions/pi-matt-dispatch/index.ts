import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerWorkflowResource } from "pi-subagents/workflow-resources";
import { createImplementationRuntime } from "../../../lib/implementation-runtime.mjs";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const text = () => Type.String({ minLength: 1 });
const strings = () => Type.Array(text(), { minItems: 1 });
const delivery = () => Type.Optional(Type.Union([Type.Literal("verified"), Type.Literal("reviewed")], {
  description: "User-approved delivery policy. verified: routine work with required host preReviewCommands and no reviewer. reviewed: high-risk work with independent review and at most one repair after review. Omission retains existing dual-review plans.",
}));

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
  pi.on("input", (event, ctx) => {
    if ((event.source === "interactive" && ctx.mode !== "tui") ||
        (event.source === "rpc" && ctx.mode !== "rpc")) return;
    runtime.input(event);
  });
  pi.on("turn_end", () => runtime.flush());

  pi.registerCommand("skill:matt-implement-spec", {
    description: "Start or resume a spec batch",
    handler: async (args, ctx) => {
      const location = resolve(PACKAGE_ROOT, ".pi", "skills", "matt-implement-spec", "SKILL.md");
      const body = (await readFile(location, "utf8")).replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();
      const batch = await runtime.beginBatchCommand(args, ctx);
      if (batch) {
        ctx.ui.notify(`Batch: ${batch.spec.path} · ${batch.tickets.length} tickets · ${batch.fixedPoint}\n` +
          "Use /matt-revoke to cancel unlaunched dispatches.", "info");
      }
      pi.sendUserMessage(
        `<skill name="matt-implement-spec" location="${location}">\nReferences are relative to ${dirname(location)}.\n\n${body}\n</skill>\n\n${args}`,
        { expandPromptTemplates: false },
      );
    },
  });
  pi.registerCommand("matt-revoke", {
    description: "Revoke implementation authorization and cancel queued dispatches",
    handler: (args, ctx) => {
      if (args.trim() || !["tui", "rpc"].includes(ctx.mode)) throw new Error("Usage: /matt-revoke (TUI/RPC)");
      runtime.revoke("user-cancelled");
      ctx.ui.notify("Implementation authorization revoked. Writers that already claimed their start require /subagents-stop.", "info");
    },
  });

  pi.registerTool({
    name: "pi_matt_dispatch",
    label: "Pi Matt Dispatch",
    description: "Validate and asynchronously dispatch registered least-privilege workflows. matt-tdd repair resumes only the writer; writerRecovery resumes a failed repair once; blockedRecovery resumes an initial batch writer after an external test-environment blocker; recollect recovers a persisted envelopeViolation without running any model; review dispatches both reviewers; reconsider runs only challenged axes. For matt-code-review an optional committed reviewScope pins the range and captures one object-only Pack before both reviewers. Follow-ups reference host-owned dispatch IDs.",
    promptSnippet: "Dispatch a registered Pi-native workflow through a least-privilege leaf subagent",
    promptGuidelines: [
      "Use pi_matt_dispatch for workflows defined by this project's parent skills; never bypass registry validation.",
      "For routine matt-tdd work use implementation.delivery='verified', approved preReviewCommands covering the changed behavior, and laneTasks.implement only. Use 'reviewed' for high-risk work or inadequate deterministic coverage; supply both reviewer tasks then. Do not change the approved delivery policy during a follow-up.",
      "For matt-tdd envelopeViolation with a persisted complete Pack and COMPLETE writer, add only the required allowedFiles and use recollect with the latest dispatchId after explicit reapproval. Omit laneTasks. Recollect runs the collector and any checks skipped due to the violation. Never recollect other failures or repeat initial implementation.",
      "For an initial batch environment BLOCKED with a host-sealed snapshot, use blockedRecovery with the latest dispatchId only after the environment is fixed. Omit batch and keep the exact envelope and its lane tasks. The host requires explicit user confirmation and resumes only the original writer.",
      "After a batch ticket has passed its implementation gate, use finalValidationRepair for an evidenced final regression. Omit batch; supply only laneTasks.implement, the exact command and literal failure text. Commands not pre-approved require confirmation. Finish via review: on verified delivery omit laneTasks (host checks only); on reviewed delivery supply both incremental reviewer tasks.",
      "For matt-code-review, pass reviewScope {kind:'committed', fixedPoint} only when the review target is already-committed history. The host resolves F, verifies ancestry of the current HEAD and pins H; it captures one read-only Git-object Pack before both reviewers. Never pass your own hash, HEAD, path or command. Omit reviewScope for the existing manual worktree/files evidence path.",
      "For matt-tdd reuse the approved implementation scope. A reviewed ticket permits one repair after review, including final validation repair; use review on the resulting candidate, then stop if blocked. repair runs only the retained writer. A failed execution may use writerRecovery once with only the implement task when eligible. Pending review is not delivery approval. Use recovery for failed reviewers or at most two report corrections per axis per candidate; disputed valid FAIL findings use reconsider. DIAGNOSIS_REQUIRED stops patch dispatch.",
      "Only matt-tdd accepts batch. A new batch requires one real confirmation of the host-sealed plan, then does not expire by time. The native command can load a local plan before confirming; never silently extend it. Changes pause. Each commit must match the host candidate proof, required validation and tracker writeback before the next ticket.",
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
        delivery: delivery(),
        preReviewCommands: Type.Optional(Type.Array(text(), { maxItems: 6, description: "Exact approved deterministic checks (e.g. typecheck, full tests) the host runs in order after every writer run and before any review, within one shared 10-minute budget. They must pass on the baseline and must not write to the worktree. A failure gives the same writer one bounded correction turn and blocks formal review of a repair." })),
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
      writerRecovery: Type.Optional(Type.Object({
        dispatchId: Type.String({ minLength: 1, description: "Latest failed pending repair dispatch; the host selects its resumable writer, never a caller-supplied runId." }),
      }, { additionalProperties: false, description: "matt-tdd only: one explicit execution recovery for a failed repair without a structured result. Preserve partial changes, original failure and repair counts; only the same retained writer runs, followed by evidence capture. Success remains pending formal review." })),
      blockedRecovery: Type.Optional(Type.Object({
        dispatchId: text(),
      }, { additionalProperties: false, description: "matt-tdd only: after explicit user confirmation, resume the original writer once for an initial batch environment BLOCKED. Keep the original batch, envelope and lane tasks. Run its originally approved delivery gates after COMPLETE." })),
      finalValidationRepair: Type.Optional(Type.Object({
        dispatchId: text(),
        command: Type.Optional(text()),
        expectedFailure: Type.Optional(text()),
      }, { additionalProperties: false, description: "matt-tdd batch only. After the approved implementation gate, reproduce a final regression with the exact local command and literal failure text. Commands not pre-approved need confirmation. Resume the retained writer only; review then reruns final checks (no reviewers for verified delivery). Retry a pending candidate with dispatchId only." })),
      recollect: Type.Optional(Type.Object({
        dispatchId: text(),
      }, { additionalProperties: false, description: "matt-tdd only: recover the latest failed envelopeViolation and its COMPLETE writer. Explicitly reapprove additive allowedFiles and keep the candidate and commands unchanged. Omit laneTasks; no writer or reviewer runs. The original delivery gates still apply." })),
      batch: Type.Optional(Type.Object({
        spec: Type.String({ minLength: 1, description: "Exact active Local Markdown parent spec path (Type: spec, Status: spec-ready)." }),
        fixedPoint: Type.String({ minLength: 1, description: "Original full commit SHA; the host verifies it exists and is an ancestor of the approved starting HEAD." }),
        tickets: Type.Array(Type.Object({
          ticket: Type.String({ minLength: 1, description: "Exact active declared ticket path; Parent must equal the approved spec." }),
          scope: Type.String({ minLength: 1, description: "Approved behavior/contract and architecture boundary for this ticket." }),
          allowedFiles: strings(),
          diagnosticFiles: Type.Optional(Type.Array(text(), { description: "Exact subset of allowedFiles for host-isolated diagnostics only." })),
          diagnosticCommands: Type.Optional(Type.Array(text(), { description: "Exact approved local repro commands." })),
          delivery: delivery(),
          preReviewCommands: Type.Optional(Type.Array(text(), { maxItems: 6, description: "Exact approved deterministic checks the host runs after every writer run and before any review." })),
        }), { minItems: 1, description: "Declared serial ticket list; the host freezes each ticket's requirement content, Parent and Blocked by graph." }),
      }, { description: "Batch for declared serial matt-tdd tickets. The host reads actual spec/ticket digests and requires a real confirmation of a new plan. Model-provided hashes or authorization are never accepted." })),
      review: Type.Optional(Type.Object({
        dispatchId: Type.String({ minLength: 1, description: "Latest completed repair, or a legacy COMPLETE dispatch recoverable from its intact Pack. No writer or collector rerun. For a pending verified final repair, settle host checks only; omit laneTasks." }),
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
