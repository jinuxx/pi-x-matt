import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { withDeadline } from "./dispatch-runtime.mjs";

export const AUTH_ENTRY = "pi-x-matt.authorization";
export const AUTH_TTL_MS = 24 * 60 * 60 * 1000;
export const AUTH_WAIT_MS = 5 * 60 * 1000;
const USER_INPUT_SOURCES = new Set(["interactive", "rpc"]);
const digest = value => createHash("sha256").update(value).digest("hex");
const DIAGNOSTIC_DIRECTORIES = new Set(["test", "tests", "__tests__", "fixture", "fixtures"]);
const DIAGNOSTIC_FILE_NAME = /\.(?:test|spec)\.[^./\\]+$/;

/** Conservative path-kind gate: only conventional test/fixture paths can receive inline diagnostics. */
export function isDiagnosticTestPath(path) {
  if (typeof path !== "string" || !path) return false;
  const parts = path.replaceAll("\\", "/").split("/");
  return parts.slice(0, -1).some(part => DIAGNOSTIC_DIRECTORIES.has(part)) ||
    DIAGNOSTIC_FILE_NAME.test(parts.at(-1) ?? "");
}

export function parseInvokedSkill(text) {
  return typeof text === "string" ? text.match(/^\/skill:([^\s]+)(?:\s|$)/)?.[1] ?? null : null;
}

export function normalizeImplementationScope(input) {
  if (!input || typeof input.ticket !== "string" || !input.ticket.trim() ||
      typeof input.scope !== "string" || !input.scope.trim() ||
      !Array.isArray(input.allowedFiles) || input.allowedFiles.length === 0 ||
      input.allowedFiles.some(path => typeof path !== "string" || !path || isAbsolute(path) ||
        path.split(/[\\/]/).some(part => part === ".." || part === "." || !part))) {
    throw new Error("matt-tdd requires implementation.ticket, scope and exact project-relative allowedFiles");
  }
  if (input.diagnosticFiles !== undefined && (!Array.isArray(input.diagnosticFiles) ||
      input.diagnosticFiles.some(path => typeof path !== "string" || !path || isAbsolute(path) ||
        path.split(/[\\/]/).some(part => part === ".." || part === "." || !part)))) {
    throw new Error("implementation.diagnosticFiles must be exact project-relative file paths");
  }
  const productionDiagnostic = input.diagnosticFiles?.find(path => !isDiagnosticTestPath(path));
  if (productionDiagnostic) {
    throw new Error(
      `implementation.diagnosticFiles may only list test or fixture paths: ${productionDiagnostic}`,
    );
  }
  if (input.diagnosticFiles?.some(path => !input.allowedFiles.includes(path))) {
    throw new Error("implementation.diagnosticFiles must be a subset of allowedFiles");
  }
  if (input.diagnosticCommands !== undefined && (!Array.isArray(input.diagnosticCommands) ||
      input.diagnosticCommands.some(command => typeof command !== "string" || !command.trim()))) {
    throw new Error("implementation.diagnosticCommands must contain exact approved commands");
  }
  return {
    ticket: input.ticket.trim(), scope: input.scope.trim(),
    allowedFiles: [...new Set(input.allowedFiles)].sort(),
    ...(input.diagnosticFiles !== undefined ? { diagnosticFiles: [...new Set(input.diagnosticFiles)].sort() } : {}),
    diagnosticCommands: [...new Set(input.diagnosticCommands ?? [])].sort(),
  };
}

/** Artifact digests come from the host, never from a model's assertion of approval. */
export async function resolveImplementationScope(projectRoot, input) {
  const scope = normalizeImplementationScope(input);
  if (scope.ticket.startsWith("slice:")) return { ...scope, ticketDigest: digest(scope.scope) };
  if (scope.ticket.replaceAll("\\", "/").startsWith(".x-matt/work/shipped/")) {
    throw new Error("Implementation ticket cannot reference shipped history");
  }
  const root = await realpath(projectRoot);
  const path = await realpath(resolve(root, scope.ticket));
  const rel = relative(root, path);
  if (isAbsolute(scope.ticket) || rel.startsWith("..") || isAbsolute(rel) ||
      rel.replaceAll("\\", "/").startsWith(".x-matt/work/shipped/")) {
    throw new Error("Implementation ticket must be an active project-relative artifact, not shipped history");
  }
  return { ...scope, ticket: rel, ticketDigest: digest(await readFile(path)) };
}

export function createDispatchAuthorization({ persist = () => {}, now = Date.now, uuid = randomUUID } = {}) {
  let sessionId;
  let state = null;
  let generation = 0;
  const save = value => {
    const record = { version: 1, sessionId, ...value };
    persist(record);
    state = record;
  };
  return {
    start(id, entries = [], restore = true) {
      generation++;
      sessionId = id;
      state = null;
      if (!restore) return;
      for (const entry of entries) {
        const record = entry.type === "custom" && entry.customType === AUTH_ENTRY ? entry.data : null;
        if (record?.version === 1 && record.sessionId === id &&
            (record.kind === "revoked" || (Number.isFinite(record.expiresAt) && typeof record.invocationId === "string")) &&
            ["intent", "grant", "revoked"].includes(record.kind)) state = record;
      }
    },
    reset() { generation++; state = null; },
    token() { return generation; },
    revoke(reason = "user-cancelled", token = generation) {
      if (token === generation) save({ kind: "revoked", reason, at: now() });
    },
    observeInput(text, source) {
      if (!USER_INPUT_SOURCES.has(source)) return;
      const skill = parseInvokedSkill(text);
      if (!skill) return;
      if (skill === "matt-implement") {
        save({ kind: "intent", invocationId: uuid(), at: now(), expiresAt: now() + AUTH_TTL_MS });
      } else this.revoke("another-skill");
    },
    userInvokedImplement() { return state?.kind === "intent" && state.sessionId === sessionId && state.expiresAt > now(); },
    matches(identity, scope) {
      return state?.kind === "grant" && state.sessionId === identity.sessionId && state.expiresAt > now() &&
        JSON.stringify(state.identity) === JSON.stringify(identity) &&
        JSON.stringify(state.scope) === JSON.stringify(scope);
    },
    grant(identity, scope, source, token = generation) {
      if (token !== generation) throw new Error("Authorization lifecycle changed; no workflow was queued");
      save({
        kind: "grant", invocationId: state?.kind === "intent" ? state.invocationId : uuid(),
        identity, scope, source, at: now(), expiresAt: now() + AUTH_TTL_MS,
      });
    },
    current() { return state ? structuredClone(state) : null; },
  };
}

export async function authorizeWorkflowDispatch(workflowName, signal, ctx, authorization, scope, identity, onWait = () => {}) {
  if (workflowName !== "matt-tdd") return "not-required";
  signal?.throwIfAborted();
  if (!identity?.sessionId || !identity.projectRoot || !identity.branch || !identity.head) {
    throw new Error("No reliable host authorization identity; no workflow was queued");
  }
  scope = { ...normalizeImplementationScope(scope), ticketDigest: scope.ticketDigest };
  const token = authorization.token();
  if (!scope.ticketDigest) throw new Error("Missing host-verified ticket digest");
  if (authorization.matches(identity, scope)) return "reused-implement-grant";
  // An explicit invocation grants one bounded implementation, not all later tickets.
  if (authorization.userInvokedImplement() && authorization.current().sessionId === identity.sessionId) {
    authorization.grant(identity, scope, "user-invoked-implement", token);
    return "user-invoked-implement";
  }
  if (!ctx.hasUI) throw new Error(
    "Workflow 'matt-tdd' requires explicit user authorization; no workflow was queued",
  );
  try {
    onWait();
    const confirmed = await withDeadline(dialogSignal => ctx.ui.confirm(
      "Authorize matt-tdd?",
      `Approve this ticket and continuous repairs within the SAME scope (24h maximum).\n` +
      `Ticket: ${scope.ticket}\nScope: ${scope.scope}\nFiles: ${scope.allowedFiles.join(", ")}\n` +
      `Diagnostic files (host-isolated only): ${(scope.diagnosticFiles ?? []).join(", ") || "none"}\n` +
      `Diagnostic commands: ${scope.diagnosticCommands.join("; ") || "none"}\n` +
      "New tickets, scope/architecture changes and destructive operations require new approval. Cancel to pause.",
      { signal: dialogSignal, timeout: AUTH_WAIT_MS },
    ), { timeoutMs: AUTH_WAIT_MS, signal });
    signal?.throwIfAborted();
    if (!confirmed) throw new Error("Workflow 'matt-tdd' was not authorized by the user; no workflow was queued");
    authorization.grant(identity, scope, "user-confirmed", token);
    return "user-confirmed";
  } catch (error) {
    authorization.revoke("authorization-cancelled-or-expired", token);
    throw error;
  }
}
