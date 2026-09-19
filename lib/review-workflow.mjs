import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectReviewEvidence } from "./review-evidence.mjs";

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export async function prepareTddEvidence(cwd, packageRoot) {
  const baseline = await collectReviewEvidence(cwd);
  const directory = await mkdtemp(join(tmpdir(), "pi-matt-review-"));
  const baselinePath = join(directory, "baseline.json");
  await writeFile(baselinePath, JSON.stringify(baseline), { mode: 0o400, flag: "wx" });
  const path = join(directory, "review.md");
  return {
    path,
    command: [process.execPath, join(packageRoot, "scripts/collect-review-evidence.mjs"), baselinePath, path].map(quote).join(" "),
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
  return { script: plan.rpcParams.workflowScript, hostCommands: plan.hostCommands };
}
