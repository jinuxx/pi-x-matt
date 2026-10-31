import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { AUTH_TTL_MS, AUTH_WAIT_MS, normalizeImplementationScope, parseInvokedSkill } from "./dispatch-authorization.mjs";
import { withDeadline } from "./dispatch-runtime.mjs";
import { stageResults } from "./repair-contract.mjs";

const exec = promisify(execFile);
const digest = value => createHash("sha256").update(value).digest("hex");
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const USER_INPUT_SOURCES = new Set(["interactive", "rpc"]);
const PLAN_FIELDS = new Set(["spec", "fixedPoint", "tickets"]);
const TICKET_FIELDS = new Set(["ticket", "scope", "allowedFiles", "diagnosticFiles", "diagnosticCommands"]);
const AXES = ["standards", "spec"];

export const BATCH_ENTRY = "pi-x-matt.batch-authorization";

async function git(cwd, args, env) {
  try {
    const { stdout } = await exec("git", [
      "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "status.relativePaths=true", ...args,
    ], {
      cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 30_000,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    return stdout;
  } catch (error) {
    const reason = error.stderr?.trim() || error.message;
    throw new Error(`Git ${args[0]} failed: ${reason}`);
  }
}

const gitText = async (cwd, ...args) => (await git(cwd, args)).trim();

async function assertAncestor(cwd, ancestor, descendant, label) {
  try {
    await git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
  } catch {
    throw new Error(`${label} is not an approved ancestor of the required baseline/HEAD`);
  }
}

async function assertFixedPoint(cwd, fixedPoint, head) {
  if (!FULL_SHA.test(fixedPoint ?? "")) {
    throw new Error("Batch fixedPoint must be the original full commit SHA; no workflow was queued");
  }
  try {
    await git(cwd, ["rev-parse", "--verify", `${fixedPoint}^{commit}`]);
  } catch {
    throw new Error("Batch fixedPoint does not exist as a commit; no workflow was queued");
  }
  await assertAncestor(cwd, fixedPoint, head, "Batch fixedPoint");
}

async function assertClean(cwd) {
  const status = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]);
  if (status) {
    throw new Error(
      "Batch implementation requires a clean worktree (ignored local tracker excluded); no workflow was queued. " +
      "Commit or preserve existing project changes first.",
    );
  }
}

async function activeArtifactPath(root, path, label) {
  if (typeof path !== "string" || !path || isAbsolute(path) ||
      path.replaceAll("\\", "/").split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error(`${label} must be an exact project-relative path under active .x-matt/work`);
  }
  const projectRoot = await realpath(root);
  let target;
  try {
    target = await realpath(resolve(projectRoot, path));
  } catch {
    throw new Error(`${label} could not be read at ${path}`);
  }
  const rel = relative(projectRoot, target).replaceAll("\\", "/");
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error(`${label} must stay inside the project root`);
  }
  if (!rel.startsWith(".x-matt/work/")) {
    throw new Error(`${label} must be an active Local Markdown artifact under .x-matt/work`);
  }
  if (rel.startsWith(".x-matt/work/shipped/")) {
    throw new Error(`${label} is archived under .x-matt/work/shipped and cannot authorize implementation`);
  }
  return { path: target, rel };
}

async function readActive(root, path, label) {
  const location = await activeArtifactPath(root, path, label);
  return { ...location, content: await readFile(location.path, "utf8") };
}

function metadata(content, label) {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  if (!/^# \S/.test(lines[0] ?? "")) throw new Error(`${label} must start with a level-1 title`);
  let index = 1;
  while (index < lines.length && lines[index].trim() === "") index++;
  const start = index;
  const fields = new Map();
  for (; index < lines.length && lines[index].trim() !== ""; index++) {
    const match = lines[index].match(/^([^:]+):\s*(.*?)\s*$/);
    if (!match) throw new Error(`${label} has an invalid metadata line`);
    if (match[1] !== match[1].trim()) throw new Error(`${label} has an invalid metadata key '${match[1]}'`);
    if (fields.has(match[1])) throw new Error(`${label} has a duplicate metadata key '${match[1]}'`);
    fields.set(match[1], match[2]);
  }
  return { lines, start, end: index, fields };
}

/** Status and the append-only Comments writeback are not requirement drift. */
function requirementDigest(content, label) {
  const { lines, start, end } = metadata(content, label);
  const comments = lines.findIndex((line, index) => index >= end && /^##\s+Comments\s*$/.test(line));
  const stop = comments < 0 ? lines.length : comments;
  const kept = lines.slice(0, stop).filter((line, index) =>
    !(index >= start && index < end && /^Status:\s*/.test(line)));
  return digest(kept.join("\n").trimEnd());
}

function implementationCommit(content, label) {
  const { lines, end } = metadata(content, label);
  const comments = lines.findIndex((line, index) => index >= end && /^##\s+Comments\s*$/.test(line));
  if (comments < 0) return null;
  let commit = null;
  for (const line of lines.slice(comments + 1)) {
    const match = line.match(/^Implementation commit:\s*(\S+)\s*$/);
    if (match) commit = match[1];
  }
  return commit;
}

function blockersOf(content, label) {
  const value = metadata(content, label).fields.get("Blocked by");
  if (value === undefined) throw new Error(`${label} must declare Blocked by`);
  if (value === "None") return [];
  return value.split(",").map(part => part.trim()).filter(Boolean);
}

async function readSpec(root, path) {
  const { rel, content } = await readActive(root, path, "Parent spec");
  const fields = metadata(content, `Spec ${rel}`).fields;
  if (fields.get("Type") !== "spec") throw new Error(`Parent ${rel} must have Type: spec`);
  if (fields.get("Status") !== "spec-ready") throw new Error(`Parent ${rel} Status must be spec-ready`);
  return { path: rel, content, digest: digest(content) };
}

async function readTicket(root, path, specPath) {
  const { rel, content } = await readActive(root, path, "Ticket");
  const fields = metadata(content, `Ticket ${rel}`).fields;
  if (fields.get("Type") !== "ticket") throw new Error(`Ticket ${rel} must have Type: ticket`);
  const parent = fields.get("Parent");
  if (!parent) throw new Error(`Ticket ${rel} must declare Parent`);
  if (parent !== "None") {
    const parentArtifact = await readActive(root, parent, `Parent of ${rel}`);
    if (parentArtifact.rel === rel) throw new Error(`Ticket ${rel} cannot be its own Parent`);
    const parentFields = metadata(parentArtifact.content, `Parent ${parentArtifact.rel}`).fields;
    if (parentFields.get("Type") !== "spec") {
      throw new Error(`Parent ${parentArtifact.rel} of ticket ${rel} must have Type: spec`);
    }
    if (parentFields.get("Status") !== "spec-ready") {
      throw new Error(`Parent ${parentArtifact.rel} of ticket ${rel} Status must be spec-ready`);
    }
  }
  const status = fields.get("Status");
  if (!["ready-for-agent", "resolved"].includes(status)) {
    throw new Error(`Ticket ${rel} Status must be ready-for-agent or resolved`);
  }
  return {
    path: rel, content, parent, status,
    blockedBy: blockersOf(content, `Ticket ${rel}`),
    requirementDigest: requirementDigest(content, `Ticket ${rel}`),
    commit: status === "resolved" ? implementationCommit(content, `Ticket ${rel}`) : null,
  };
}

async function requireCommit(root, ticket, label) {
  if (!FULL_SHA.test(ticket.commit ?? "")) {
    throw new Error(`${label} ${ticket.path} must record one full Implementation commit SHA in Comments`);
  }
  try {
    await git(root, ["rev-parse", "--verify", `${ticket.commit}^{commit}`]);
  } catch {
    throw new Error(`${label} ${ticket.path} Implementation commit does not exist`);
  }
  return ticket.commit;
}

const envelopeOf = item => ({
  ticket: item.ticket,
  scope: item.scope,
  allowedFiles: item.allowedFiles,
  diagnosticFiles: item.diagnosticFiles ?? [],
  diagnosticCommands: item.diagnosticCommands ?? [],
});

export function normalizeBatchPlan(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("top-level batch must be a sealed batch plan object");
  }
  for (const key of Object.keys(input)) {
    if (!PLAN_FIELDS.has(key)) {
      throw new Error(`Batch input has unsupported field '${key}'; spec/ticket digests and authorization are host-read`);
    }
  }
  if (typeof input.spec !== "string" || !input.spec.trim()) {
    throw new Error("batch.spec must be the exact active Local Markdown spec path");
  }
  if (typeof input.fixedPoint !== "string" || !FULL_SHA.test(input.fixedPoint)) {
    throw new Error("batch.fixedPoint must be the original full commit SHA");
  }
  if (!Array.isArray(input.tickets) || input.tickets.length === 0) {
    throw new Error("batch.tickets must be a non-empty declared ticket list");
  }
  const seen = new Set();
  const tickets = input.tickets.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Each batch ticket must be an implementation envelope object");
    }
    for (const key of Object.keys(item)) {
      if (!TICKET_FIELDS.has(key)) {
        throw new Error(`Batch ticket has unsupported field '${key}'; ticket digests and authorization are host-read`);
      }
    }
    const scope = normalizeImplementationScope(item);
    if (seen.has(scope.ticket)) throw new Error(`Batch declares ticket '${scope.ticket}' more than once`);
    seen.add(scope.ticket);
    return scope;
  });
  return { spec: input.spec.trim(), fixedPoint: input.fixedPoint, tickets };
}

/** Host-read the active spec/tickets, freeze requirement content and seal exact envelopes. */
export async function prepareBatchPlan(projectRoot, input, identity) {
  const plan = normalizeBatchPlan(input);
  if (!identity?.sessionId || !identity.projectRoot || !identity.branch || !identity.head) {
    throw new Error("No reliable host authorization identity; no batch workflow was queued");
  }
  const root = await realpath(projectRoot);
  if (root !== await realpath(identity.projectRoot)) {
    throw new Error("Batch project root changed before confirmation; no workflow was queued");
  }
  await assertFixedPoint(root, plan.fixedPoint, identity.head);
  await assertClean(root);
  const spec = await readSpec(root, plan.spec);
  const declared = new Map();
  for (const approved of plan.tickets) {
    const ticket = await readTicket(root, approved.ticket, spec.path);
    if (ticket.parent === "None" || ticket.parent !== spec.path) {
      throw new Error(`Ticket ${ticket.path} Parent must be the approved spec ${spec.path}`);
    }
    const entry = {
      ...approved, ticket: ticket.path, ticketDigest: digest(ticket.content),
      requirementDigest: ticket.requirementDigest, status: ticket.status, blockedBy: ticket.blockedBy,
    };
    if (ticket.status === "resolved") {
      const commit = await requireCommit(root, ticket, "Resolved ticket");
      await assertAncestor(root, plan.fixedPoint, commit, `Resolved ticket ${ticket.path} commit`);
      await assertAncestor(root, commit, identity.head, `Resolved ticket ${ticket.path} commit`);
      entry.preresolved = { commit };
    }
    declared.set(entry.ticket, { ...entry, content: ticket.content });
  }
  const external = new Map();
  const visiting = new Set(), visited = new Set();
  const visit = async (rel, chain) => {
    if (visiting.has(rel)) {
      throw new Error(`Blocked by graph contains a cycle at ${rel}; no workflow was queued`);
    }
    if (visited.has(rel)) return;
    let node = declared.get(rel);
    if (!node) {
      node = await readTicket(root, rel, spec.path);
      if (node.parent === "None" || node.parent !== spec.path) {
        throw new Error(`Blocker ${rel} must belong to the declared parent spec ${spec.path}`);
      }
    }
    visiting.add(rel);
    for (const blocker of node.blockedBy) {
      if (blocker === rel) throw new Error(`Ticket ${rel} cannot block itself; no workflow was queued`);
      await visit(blocker, [...chain, rel]);
    }
    visiting.delete(rel);
    visited.add(rel);
    if (!declared.has(rel)) {
      if (node.status !== "resolved") {
        throw new Error(`Blocker ${rel} must be resolved before the batch can pass the frontier; no workflow was queued`);
      }
      const commit = await requireCommit(root, node, "Resolved blocker");
      await assertAncestor(root, commit, identity.head, `Resolved blocker ${rel} commit`);
      external.set(rel, { ticket: rel, requirementDigest: node.requirementDigest, commit });
    }
  };
  for (const entry of declared.values()) await visit(entry.ticket, []);
  return {
    version: 1, kind: "batch", sessionId: identity.sessionId,
    identity: { sessionId: identity.sessionId, projectRoot: root, branch: identity.branch, head: identity.head },
    fixedPoint: plan.fixedPoint,
    spec: { path: spec.path, digest: spec.digest },
    tickets: [...declared.values()].map(({ content: _content, ...entry }) => entry),
    externalBlockers: [...external.values()],
    at: Date.now(), expiresAt: Date.now() + AUTH_TTL_MS,
  };
}

export function createBatchAuthorization({ persist = () => {}, now = Date.now, uuid = randomUUID } = {}) {
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
        const record = entry.type === "custom" && entry.customType === BATCH_ENTRY ? entry.data : null;
        if (record?.version === 1 && record.sessionId === id &&
            (record.kind === "revoked" ||
              (record.kind === "batch" && typeof record.invocationId === "string" &&
                Number.isFinite(record.expiresAt)))) state = record;
      }
    },
    reset() { generation++; state = null; },
    token() { return generation; },
    revoke(reason = "user-cancelled", token = generation) {
      if (token !== generation) return;
      generation++;
      if (state) save({ kind: "revoked", reason, at: now() });
    },
    observeInput(text, source) {
      if (!USER_INPUT_SOURCES.has(source)) return;
      const skill = parseInvokedSkill(text);
      if (!skill || skill === "matt-implement-spec") return;
      this.revoke("another-skill");
    },
    establish(record, token = generation) {
      if (token !== generation) throw new Error("Authorization lifecycle changed; no batch workflow was queued");
      if (!record || record.version !== 1 || record.kind !== "batch" || typeof record.invocationId !== "string") {
        throw new Error("Invalid host-read batch capability");
      }
      save({ ...record, sessionId, at: now(), expiresAt: now() + AUTH_TTL_MS });
    },
    current() { return state ? structuredClone(state) : null; },
    active(invocationId) {
      return state?.kind === "batch" && state.sessionId === sessionId &&
        state.invocationId === invocationId && Number.isFinite(state.expiresAt) && state.expiresAt > now();
    },
  };
}

export async function confirmBatchPlan(ctx, candidate, signal, authorization, { onWait = () => {}, now = Date.now } = {}) {
  signal?.throwIfAborted();
  if (!ctx?.hasUI) {
    throw new Error(
      "Batch implementation requires one explicit TUI/RPC confirmation of the sealed plan; no workflow was queued. " +
      "Re-run with an interactive session or pause.",
    );
  }
  const lines = [
    `Spec: ${candidate.spec.path}`,
    `Original fixed point: ${candidate.fixedPoint}`,
    `Approved starting HEAD: ${candidate.identity.head}`,
    ...candidate.tickets.map((ticket, index) => [
      `Ticket ${index + 1}: ${ticket.ticket}`,
      `Scope: ${ticket.scope}`,
      `Allowed files: ${ticket.allowedFiles.join(", ")}`,
      `Diagnostic files (host-isolated only): ${(ticket.diagnosticFiles ?? []).join(", ") || "none"}`,
      `Diagnostic commands: ${ticket.diagnosticCommands.join("; ") || "none"}`,
    ].join("\n")),
    "One approval authorizes exactly these declared serial tickets with their exact envelopes (24h maximum). " +
      "The host verifies each dual-PASS reviewed candidate commit and tracker writeback before the next ticket. " +
      "New tickets, files, commands, semantics or architecture changes require a new explicit batch confirmation. Cancel to pause.",
  ];
  const token = authorization.token();
  try {
    onWait();
    const confirmed = await withDeadline(dialogSignal => ctx.ui.confirm(
      "Authorize this matt-tdd batch?",
      lines.join("\n\n"),
      { signal: dialogSignal, timeout: AUTH_WAIT_MS },
    ), { timeoutMs: AUTH_WAIT_MS, signal });
    signal?.throwIfAborted();
    if (!confirmed) throw new Error("Batch implementation was not authorized by the user; no workflow was queued");
    authorization.establish({ ...candidate, kind: "batch", invocationId: randomUUID() }, token);
    return authorization.current();
  } catch (error) {
    authorization.revoke("batch-authorization-cancelled-or-expired", token);
    throw error;
  }
}

function recordsOf(records) {
  return records instanceof Map ? [...records.values()] : [...(records ?? [])];
}

async function commitInfo(root, commit) {
  await git(root, ["rev-parse", "--verify", `${commit}^{commit}`]);
  const body = await git(root, ["cat-file", "commit", commit]);
  const tree = body.match(/^tree ([0-9a-f]+)$/m)?.[1];
  const parents = [...body.matchAll(/^parent ([0-9a-f]+)$/gm)].map(match => match[1]);
  if (!tree) throw new Error(`Commit ${commit} has no readable tree`);
  return { tree, parents };
}

async function verifyCommittedTicket(root, batch, entry, ticket, records) {
  if (entry.preresolved) {
    const commit = await requireCommit(root, ticket, "Resolved ticket");
    if (commit !== entry.preresolved.commit) {
      throw new Error(`Resolved ticket ${entry.ticket} tracker no longer matches the approved completion; no workflow was queued`);
    }
    await assertAncestor(root, batch.fixedPoint, commit, `Resolved ticket ${entry.ticket} commit`);
    await assertAncestor(root, commit, batch.identity.head, `Resolved ticket ${entry.ticket} commit`);
    return { commit };
  }
  const record = recordsOf(records)
    .filter(item => item.state !== "cancelled" && item.batch?.id === batch.invocationId &&
      item.scope?.ticket === entry.ticket)
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
    .at(-1);
  if (!record) {
    throw new Error(`No host dispatch record exists for completed batch ticket ${entry.ticket}; no workflow was queued`);
  }
  if (!record.batchOutcome?.complete) {
    throw new Error(
      `Ticket ${entry.ticket} has no completed implementation with both valid reviewer PASS results; ` +
      "no workflow was queued. Finish review and commit exactly that candidate first.",
    );
  }
  const candidate = record.batchOutcome.candidate;
  if (!candidate || candidate.snapshotId !== record.snapshotId) {
    throw new Error(`Ticket ${entry.ticket} reviewed candidate proof does not match its snapshot; no workflow was queued`);
  }
  const commit = await requireCommit(root, ticket, "Resolved ticket");
  const info = await commitInfo(root, commit);
  if (info.parents.length !== 1 || info.parents[0] !== candidate.head) {
    throw new Error(
      `Ticket ${entry.ticket} commit ${commit} does not have the reviewed candidate's approved parent; no workflow was queued`,
    );
  }
  if (info.tree !== candidate.tree) {
    throw new Error(
      `Ticket ${entry.ticket} commit ${commit} tree does not match the reviewed candidate ` +
      "(content, file type or executable mode changed, or extra files were committed); no workflow was queued",
    );
  }
  await assertAncestor(root, batch.fixedPoint, commit, `Ticket ${entry.ticket} commit`);
  return { commit, candidate };
}

async function assertFrontier(root, batch, tickets, targetEntry, { records, identity }) {
  const index = batch.tickets.indexOf(targetEntry);
  let expectedHead = batch.identity.head;
  for (let position = 0; position < index; position++) {
    const entry = batch.tickets[position], ticket = tickets[position];
    if (ticket.status !== "resolved") {
      throw new Error(
        `Ticket ${entry.ticket} must be resolved before ${targetEntry.ticket}; no workflow was queued. ` +
        "Serialize declared tickets in order.",
      );
    }
    const { commit } = await verifyCommittedTicket(root, batch, entry, ticket, records);
    if (!entry.preresolved) expectedHead = commit;
  }
  for (const blocker of tickets[index].blockedBy) {
    const declared = batch.tickets.find(item => item.ticket === blocker);
    if (declared) {
      const blockerTicket = tickets[batch.tickets.indexOf(declared)];
      if (blockerTicket.status !== "resolved") {
        throw new Error(`Blocker ${blocker} is not resolved; no workflow was queued`);
      }
    } else {
      const external = batch.externalBlockers?.find(item => item.ticket === blocker);
      if (!external) {
        throw new Error(`Blocker ${blocker} is outside the approved dependency graph; no workflow was queued`);
      }
    }
  }
  const head = await gitText(root, "rev-parse", "HEAD");
  if (head !== expectedHead) {
    throw new Error(
      `HEAD ${head} is not the approved starting point ${expectedHead}; unrelated or excess commits, an amend, ` +
      "or an unverified candidate cannot unlock the next ticket. no workflow was queued.",
    );
  }
  await assertClean(root);
}

/** Verify the trusted batch capability against host-read artifacts before deriving a ticket grant. */
export async function verifyBatchDispatch(projectRoot, batch, identity, scope, { previous, records = [], now = Date.now } = {}) {
  if (batch?.kind !== "batch") {
    throw new Error("Batch authorization is revoked or unavailable; no workflow was queued. Re-run the batch entry with one explicit confirmation.");
  }
  if (!Number.isFinite(batch.expiresAt) || batch.expiresAt <= now) {
    throw new Error("Batch authorization expired; no workflow was queued. Re-run the batch entry with one explicit confirmation.");
  }
  if (batch.sessionId !== identity.sessionId || batch.identity?.sessionId !== identity.sessionId ||
      batch.identity?.branch !== identity.branch) {
    throw new Error("Batch authorization is bound to another session or branch; no workflow was queued");
  }
  const root = await realpath(projectRoot);
  if (await realpath(batch.identity.projectRoot) !== root) {
    throw new Error("Batch authorization is bound to another canonical project; no workflow was queued");
  }
  await assertFixedPoint(root, batch.fixedPoint, identity.head);
  const spec = await readSpec(root, batch.spec.path);
  if (spec.digest !== batch.spec.digest) {
    throw new Error("Approved spec content drift detected; no workflow was queued. Submit one new explicit batch confirmation.");
  }
  const tickets = [];
  for (const entry of batch.tickets) {
    const ticket = await readTicket(root, entry.ticket, spec.path);
    if (ticket.parent === "None" || ticket.parent !== spec.path) {
      throw new Error(`Ticket ${ticket.path} Parent drift detected; no workflow was queued`);
    }
    if (ticket.requirementDigest !== entry.requirementDigest) {
      throw new Error(`Approved requirement drift detected for ${ticket.path}; no workflow was queued`);
    }
    if (entry.preresolved) {
      if (ticket.status !== "resolved" || ticket.commit !== entry.preresolved.commit) {
        throw new Error(`Resolved ticket ${ticket.path} drifted from its approved completion; no workflow was queued`);
      }
    }
    tickets.push(ticket);
  }
  for (const external of batch.externalBlockers ?? []) {
    const ticket = await readTicket(root, external.ticket, spec.path);
    if (ticket.status !== "resolved" || ticket.requirementDigest !== external.requirementDigest ||
        ticket.commit !== external.commit) {
      throw new Error(`Approved blocker drift detected for ${external.ticket}; no workflow was queued`);
    }
    await assertAncestor(root, ticket.commit, batch.identity.head, `Resolved blocker ${external.ticket} commit`);
  }
  const target = batch.tickets.find(item => item.ticket === scope.ticket);
  if (!target) {
    throw new Error(
      `Ticket ${scope.ticket} is not declared in the approved batch; no workflow was queued. ` +
      "Submit one new explicit batch confirmation for an expanded plan.",
    );
  }
  const envelopeMatches = JSON.stringify(envelopeOf(scope)) === JSON.stringify(envelopeOf(target));
  const current = tickets[batch.tickets.indexOf(target)];
  const initial = !previous;
  if (initial) {
    await assertFrontier(root, batch, tickets, target, { records, identity });
    if (current.status !== "ready-for-agent" || target.preresolved) {
      throw new Error(`Ticket ${target.ticket} is not a ready frontier ticket; no workflow was queued`);
    }
    if (!envelopeMatches) {
      throw new Error(
        `Implementation envelope for ${target.ticket} differs from the approved batch plan; no workflow was queued. ` +
        "Submit one new explicit batch confirmation for a changed plan.",
      );
    }
  } else if (current.status !== "ready-for-agent") {
    throw new Error(`Ticket ${target.ticket} is already ${current.status}; no workflow was queued`);
  }
  return { entry: target, envelopeMatches, initial, ticket: current };
}

/** The one trusted outcome recorded from terminal workflow results and collector emits. */
export function batchOutcome(status) {
  let results;
  try {
    results = stageResults(status);
  } catch {
    return { complete: false, resultsValid: false, candidate: null, verdicts: {}, implementComplete: false };
  }
  const implement = results.find(item => item.key === "implement");
  const axes = AXES.map(axis => results.find(item => item.key === axis));
  const verdicts = Object.fromEntries(AXES.map((axis, index) => [axis, axes[index]?.structuredOutput?.verdict ?? null]));
  const raw = (status.workflow?.emits ?? [])
    .filter(row => row?.type === "pi-x-matt.batch-candidate" && row.version === 1 && row.candidate)
    .map(row => row.candidate).at(-1) ?? null;
  const candidate = raw && FULL_SHA.test(raw.tree ?? "") && FULL_SHA.test(raw.head ?? "") &&
    FULL_SHA.test(raw.fixedPoint ?? "") && typeof raw.snapshotId === "string" && raw.snapshotId.length >= 32
    ? raw : null;
  const resultsValid = implement?.ok === true && implement.structuredOutput?.status === "COMPLETE" &&
    axes.every((item, index) => item?.ok === true && item.structuredOutput?.axis === AXES[index] &&
      item.structuredOutput?.verdict === "PASS");
  const complete = resultsValid && Boolean(candidate);
  return {
    complete, resultsValid, candidate, verdicts,
    implementComplete: implement?.ok === true && implement.structuredOutput?.status === "COMPLETE",
  };
}

/**
 * Trusted collector extension for batch-bound runs. Stages exactly the reviewed project
 * paths into an OS-temp index and writes the candidate tree into OS-temp objects, with
 * the real object store mounted read-only as an alternate. The real index/HEAD are never
 * written; the returned tree binds content, existence and executable modes.
 */
async function verifiedCandidateManifest(root, manifest) {
  const entries = [];
  const removals = new Set();
  const safePath = (path, label) => {
    if (typeof path !== "string" || !path || isAbsolute(path) ||
        path.replaceAll("\\", "/").split("/").some(part => !part || part === "." || part === "..")) {
      throw new Error(`${label} is not an exact project-relative path: ${JSON.stringify(path)}`);
    }
    const absolute = resolve(root, path);
    const relativePath = relative(root, absolute);
    if (!relativePath || relativePath === ".." || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error(`${label} escapes the project root: ${path}`);
    }
    return { absolute, relativePath: relativePath.replaceAll("\\", "/") };
  };
  for (const entry of manifest) {
    if (!["file", "symlink", "deleted"].includes(entry.kind)) {
      throw new Error(`Batch candidate proof does not support ${entry.kind} evidence for ${entry.path}`);
    }
    const location = safePath(entry.path, "Batch candidate path");
    if (entry.oldPath !== undefined) {
      safePath(entry.oldPath, "Batch candidate old path");
      removals.add(entry.oldPath);
    }
    if (entry.kind === "deleted") {
      let stat = null;
      try { stat = await lstat(location.absolute); } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (stat) {
        throw new Error(`Batch candidate content drift for ${entry.path}: path reviewed as deleted exists`);
      }
      removals.add(entry.path);
      entries.push({ path: entry.path, kind: "deleted" });
      continue;
    }
    const stat = await lstat(location.absolute);
    if (entry.kind === "symlink") {
      if (!stat.isSymbolicLink()) {
        throw new Error(`Batch candidate type drift for ${entry.path}: expected a symlink`);
      }
      const target = await readlink(location.absolute);
      if (entry.mode !== "120000" || typeof entry.content !== "string" ||
          target !== entry.content || digest(target) !== entry.sha256) {
        throw new Error(`Batch candidate content drift for ${entry.path}: worktree no longer matches the reviewed Pack`);
      }
      entries.push({ path: entry.path, kind: "symlink", mode: "120000", content: entry.content, sha256: entry.sha256 });
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`Batch candidate type drift for ${entry.path}: expected a regular file`);
    }
    const bytes = await readFile(location.absolute);
    if (digest(bytes) !== entry.sha256) {
      throw new Error(`Batch candidate content drift for ${entry.path}: worktree no longer matches the reviewed Pack`);
    }
    const reviewed = Buffer.from(entry.content ?? "", entry.encoding === "base64" ? "base64" : "utf8");
    if (digest(reviewed) !== entry.sha256) {
      throw new Error(`Batch candidate proof lacks byte-identical reviewed content for ${entry.path}`);
    }
    if (entry.mode !== "100644" && entry.mode !== "100755") {
      throw new Error(`Batch candidate proof lacks a reviewed Git mode for ${entry.path}; refresh the review baseline`);
    }
    const liveMode = (stat.mode & 0o111) !== 0 ? "100755" : "100644";
    if (liveMode !== entry.mode) {
      throw new Error(`Batch candidate mode drift for ${entry.path}: worktree no longer matches the reviewed Pack`);
    }
    entries.push({
      path: entry.path, kind: "file",
      mode: entry.mode,
      bytes: reviewed, sha256: entry.sha256,
    });
  }
  for (const oldPath of removals) {
    if (manifest.some(entry => entry.path === oldPath && entry.kind !== "deleted")) {
      throw new Error(`Batch candidate rename/removal conflict at ${oldPath}`);
    }
    let stat = null;
    try { stat = await lstat(resolve(root, oldPath)); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (stat) throw new Error(`Batch candidate content drift for ${oldPath}: renamed/deleted path exists`);
  }
  return { entries, removals: [...removals].sort() };
}

const candidateSummary = entries => entries.filter(entry => entry.kind !== "deleted")
  .map(({ path, mode, sha256 }) => ({ path, mode, sha256 }))
  .sort((a, b) => a.path.localeCompare(b.path));

export async function collectCandidateTreeProof(projectRoot, pack, control = {}, { remove = rm } = {}) {
  const fixedPoint = control.batch?.fixedPoint;
  if (!FULL_SHA.test(fixedPoint ?? "")) {
    throw new Error("Batch candidate proof requires the host-approved original fixed point");
  }
  if (!pack?.complete) throw new Error("Batch candidate proof requires a complete review evidence pack");
  const allowed = Array.isArray(control.allowedFiles) ? new Set(control.allowedFiles) : null;
  if (!allowed) throw new Error("Batch candidate proof requires the approved allowedFiles envelope");
  for (const entry of pack.manifest ?? []) {
    if (!["file", "symlink", "deleted"].includes(entry.kind)) {
      throw new Error(`Batch candidate proof does not support ${entry.kind} evidence for ${entry.path}`);
    }
    for (const path of [entry.path, entry.oldPath].filter(Boolean)) {
      if (!allowed.has(path)) {
        throw new Error(`Batch candidate changed ${path} outside the approved envelope; no workflow was queued`);
      }
    }
  }
  const root = await realpath(projectRoot);
  if (pack.head !== await gitText(root, "rev-parse", "HEAD")) {
    throw new Error("Batch candidate proof: HEAD changed during evidence capture");
  }
  const directory = await mkdtemp(join(tmpdir(), "pi-matt-batch-proof-"));
  let failure;
  let proof;
  try {
    const objects = join(directory, "objects");
    await mkdir(objects);
    const verified = await verifiedCandidateManifest(root, pack.manifest ?? []);
    const gitDir = await gitText(root, "rev-parse", "--absolute-git-dir");
    const env = {
      GIT_INDEX_FILE: join(directory, "index"),
      GIT_OBJECT_DIRECTORY: objects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(gitDir, "objects"),
      GIT_OPTIONAL_LOCKS: "0",
    };
    const run = (...args) => git(root, args, env);
    await run("read-tree", "HEAD");
    for (const oldPath of verified.removals) await run("update-index", "--force-remove", "--", oldPath);
    const contentRoot = join(directory, "content");
    await mkdir(contentRoot);
    let contentIndex = 0;
    for (const entry of verified.entries) {
      if (entry.kind === "deleted") continue;
      const contentFile = join(contentRoot, String(contentIndex++));
      await writeFile(contentFile, entry.kind === "symlink" ? Buffer.from(entry.content, "utf8") : entry.bytes);
      const blob = (await run("hash-object", "-w", "--no-filters", contentFile)).trim();
      await run("update-index", "--add", "--cacheinfo", entry.mode, blob, entry.path);
    }
    const tree = (await run("write-tree")).trim();
    if (!FULL_SHA.test(tree)) throw new Error("Batch candidate proof produced an invalid tree");
    const rechecked = await verifiedCandidateManifest(root, pack.manifest ?? []);
    if (JSON.stringify(candidateSummary(rechecked.entries)) !== JSON.stringify(candidateSummary(verified.entries)) ||
        JSON.stringify(rechecked.removals) !== JSON.stringify(verified.removals)) {
      throw new Error("Batch candidate proof: worktree content or mode changed during candidate capture");
    }
    if (await gitText(root, "rev-parse", "HEAD") !== pack.head) {
      throw new Error("Batch candidate proof: HEAD changed during candidate capture");
    }
    const status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]);
    if (status !== pack.status) throw new Error("Batch candidate proof: worktree changed during candidate capture");
    proof = {
      version: 1, tree, head: pack.head, snapshotId: pack.snapshotId, fixedPoint,
      files: candidateSummary(verified.entries),
      deletions: verified.removals.filter(path => !(pack.manifest ?? []).some(entry =>
        entry.oldPath === path && entry.kind !== "deleted")),
      renames: (pack.manifest ?? []).filter(entry => entry.oldPath)
        .map(entry => ({ from: entry.oldPath, to: entry.path }))
        .sort((a, b) => a.from.localeCompare(b.from)),
    };
  } catch (error) {
    failure = error;
  }
  try {
    await remove(directory, { recursive: true, force: true });
  } catch (error) {
    if (failure) {
      const aggregate = new AggregateError([failure, error],
        `${failure.message}; candidate proof cleanup failed: ${error.message}`);
      aggregate.cause = failure;
      failure = aggregate;
    } else {
      failure = error;
    }
  }
  if (failure) throw failure;
  return proof;
}
