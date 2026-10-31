import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectReviewEvidence } from "./review-evidence.mjs";

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export async function prepareTddEvidence(cwd, packageRoot, control = {}, reviewBaseline) {
  const baseline = await collectReviewEvidence(cwd);
  const directory = await mkdtemp(join(tmpdir(), "pi-matt-review-"));
  const baselinePath = join(directory, "baseline.json");
  // A repair batch is pinned to the latest candidate at admission, but review
  // increments accumulate from the last formal review, not the preceding patch.
  const { baseline: _prior, incremental: _increment, ...reviewed } = reviewBaseline ?? baseline;
  await writeFile(baselinePath, JSON.stringify({ baseline: reviewed, control }), { mode: 0o400, flag: "wx" });
  const path = join(directory, "review.md");
  return {
    path, baselinePath, snapshotPath: join(directory, "review.json"), snapshotId: baseline.snapshotId, controlled: true,
    ...(control.batch ? { batch: true } : {}),
    claimCommand: [process.execPath, join(packageRoot, "scripts/claim-implementation.mjs"), join(directory, "dispatch.claim")].map(quote).join(" "),
    command: [process.execPath, join(packageRoot, "scripts/collect-review-evidence.mjs"), baselinePath, path].map(quote).join(" "),
  };
}

/** Fixed host command for a committed range already resolved and pinned at admission. */
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
    fixedPoint: control.fixedPoint, head: control.head, cwd: control.cwd, gitRoot: control.gitRoot,
  }), { mode: 0o400, flag: "wx" });
  const path = join(directory, "review.md");
  return {
    kind: "committed", committed: true, path, controlPath, snapshotPath: join(directory, "review.json"),
    fixedPoint: control.fixedPoint, head: control.head,
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
