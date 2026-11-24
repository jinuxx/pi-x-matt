import { createHash } from "node:crypto";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

/** Prepare host-owned atomic claim and optional verify command for matt-tdd. */
export async function prepareTddHostControls(packageRoot, verifyCommands = []) {
  const directory = await mkdtemp(join(tmpdir(), "pi-matt-tdd-"));
  const claimPath = join(directory, "dispatch.claim");
  const claimCommand = [process.execPath, join(packageRoot, "scripts/claim-implementation.mjs"), claimPath]
    .map(quote).join(" ");

  let verifyCommand;
  if (verifyCommands.length > 0) {
    const controlPath = join(directory, "verify.json");
    const serialized = JSON.stringify({ commands: verifyCommands });
    const controlDigest = createHash("sha256").update(serialized).digest("hex");
    await writeFile(controlPath, serialized, { mode: 0o400, flag: "wx" });
    verifyCommand = [process.execPath, join(packageRoot, "scripts/run-verify-commands.mjs"), controlPath, controlDigest]
      .map(quote).join(" ");
  }

  return { directory, claimPath, claimCommand, ...(verifyCommand ? { verifyCommand } : {}) };
}

/** Prepare a one-shot read-only worktree Evidence Pack collector for matt-code-review. */
export async function prepareWorktreeReviewEvidence(packageRoot) {
  const directory = await mkdtemp(join(tmpdir(), "pi-matt-worktree-review-"));
  const path = join(directory, "review.md");
  return {
    kind: "worktree",
    path,
    snapshotPath: join(directory, "review.json"),
    command: [process.execPath, join(packageRoot, "scripts/collect-review-evidence.mjs"), path].map(quote).join(" "),
  };
}

/** Prepare a one-shot committed F..H Evidence Pack collector for matt-code-review. */
export async function prepareCommittedReviewEvidence(cwd, packageRoot, control) {
  if (!control || typeof control.fixedPoint !== "string" || typeof control.head !== "string" ||
      typeof control.cwd !== "string" || typeof control.gitRoot !== "string") {
    throw new Error("Committed review evidence requires a host-pinned range");
  }
  if (await realpath(cwd) !== control.cwd) {
    throw new Error("Committed review evidence: project root differs from the admitted capture");
  }
  const directory = await mkdtemp(join(tmpdir(), "pi-matt-committed-review-"));
  const controlPath = join(directory, "control.json");
  await writeFile(controlPath, JSON.stringify({
    fixedPoint: control.fixedPoint,
    head: control.head,
    cwd: control.cwd,
    gitRoot: control.gitRoot,
  }), { mode: 0o400, flag: "wx" });
  const path = join(directory, "review.md");
  return {
    kind: "committed",
    committed: true,
    path,
    controlPath,
    snapshotPath: join(directory, "review.json"),
    fixedPoint: control.fixedPoint,
    head: control.head,
    command: [process.execPath, join(packageRoot, "scripts/collect-committed-review-evidence.mjs"), controlPath, path]
      .map(quote).join(" "),
  };
}

/** Resolve only plans already validated by the dispatcher, never caller-supplied shell. */
export function resolveReviewWorkflow(plans, args) {
  if (!args || Object.keys(args).length !== 1 || typeof args.dispatchId !== "string") {
    return { error: "Expected only a dispatcher-owned dispatchId" };
  }
  const plan = plans.get(args.dispatchId);
  if (!plan) return { error: "Unknown or expired validated dispatch" };
  plans.delete(args.dispatchId);
  return { script: plan.rpcParams.script, hostCommands: plan.hostCommands };
}
