import { withDeadline } from "./dispatch-runtime.mjs";

export const AUTH_ENTRY = "pi-x-matt.authorization";
export const AUTH_WAIT_MS = 5 * 60 * 1000;
const VERIFY_COMMAND_LIMIT = 8;
const VERIFY_COMMAND_BYTES = 500;

export function normalizeVerifyCommands(commands) {
  if (commands === undefined) return [];
  if (!Array.isArray(commands) || commands.length > VERIFY_COMMAND_LIMIT ||
      commands.some((command) => typeof command !== "string" || !command.trim() ||
        /[\0\r\n]/.test(command) || Buffer.byteLength(command) > VERIFY_COMMAND_BYTES)) {
    throw new Error(
      `verifyCommands must be at most ${VERIFY_COMMAND_LIMIT} single-line commands of at most ${VERIFY_COMMAND_BYTES} bytes each`,
    );
  }
  return [...new Set(commands.map((command) => command.trim()))];
}

/**
 * Lightweight session-scoped authorization for writer workflows and host verifyCommands.
 * Never auto-revoked by invoking another skill; revoked only on /matt-revoke, session switch, or tree change.
 */
export function createDispatchAuthorization({ persist = () => {}, now = Date.now } = {}) {
  let sessionId;
  let grants = new Map(); // canonical projectRoot -> Set<string> approved verifyCommands
  let generation = 0;

  return {
    start(id, entries = [], restore = true) {
      generation++;
      sessionId = id;
      grants = new Map();
      if (!restore) return;
      for (const entry of entries) {
        const record = entry.type === "custom" && entry.customType === AUTH_ENTRY ? entry.data : null;
        if (!record || record.sessionId !== id || record.version !== 3) continue;
        if (record.kind === "revoked") {
          grants.clear();
        } else if (record.kind === "grant" && typeof record.projectRoot === "string") {
          const existing = grants.get(record.projectRoot) ?? new Set();
          for (const command of record.verifyCommands ?? []) existing.add(command);
          grants.set(record.projectRoot, existing);
        }
      }
    },
    token() { return generation; },
    revoke(reason = "user-cancelled", token = generation) {
      if (token !== generation) return;
      generation++;
      grants.clear();
      persist({ version: 3, sessionId, kind: "revoked", reason, at: now() });
    },
    matches(projectRoot, verifyCommands = []) {
      const approved = grants.get(projectRoot);
      if (!approved) return false;
      return verifyCommands.every((command) => approved.has(command));
    },
    grant(projectRoot, verifyCommands = [], token = generation) {
      if (token !== generation) throw new Error("Authorization lifecycle changed; no workflow was queued");
      const existing = grants.get(projectRoot) ?? new Set();
      for (const command of verifyCommands) existing.add(command);
      grants.set(projectRoot, existing);
      persist({
        version: 3,
        sessionId,
        kind: "grant",
        projectRoot,
        verifyCommands: [...existing],
        at: now(),
      });
    },
  };
}

export async function authorizeWriterDispatch({
  workflowName,
  projectRoot,
  branch,
  verifyCommands = [],
  ctx,
  signal,
  authorization,
  onWait = () => {},
}) {
  signal?.throwIfAborted();
  if (authorization.matches(projectRoot, verifyCommands)) return "reused-session-grant";
  if (!ctx?.hasUI) {
    throw new Error(`Workflow '${workflowName}' requires user confirmation in an interactive session`);
  }
  const token = authorization.token();
  const lines = [
    `Workflow: ${workflowName}`,
    `Project: ${projectRoot}`,
    ...(branch ? [`Branch: ${branch}`] : []),
    ...(verifyCommands.length ? [`Verify commands: ${verifyCommands.join(" ; ")}`] : []),
    "",
    "Approve writer subagents for this project in the current session? (Use /matt-revoke anytime to revoke.)",
  ];
  onWait();
  const confirmed = await withDeadline(
    (dialogSignal) => ctx.ui.confirm("Authorize writer workflow?", lines.join("\n"), {
      signal: dialogSignal,
      timeout: AUTH_WAIT_MS,
    }),
    { timeoutMs: AUTH_WAIT_MS, signal },
  );
  signal?.throwIfAborted();
  if (!confirmed) throw new Error(`Workflow '${workflowName}' was not authorized by the user`);
  authorization.grant(projectRoot, verifyCommands, token);
  return "user-confirmed";
}
