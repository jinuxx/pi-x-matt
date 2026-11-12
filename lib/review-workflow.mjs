import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectReviewEvidence } from "./review-evidence.mjs";

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export const REVIEW_RESULT_FORMAT = "pi-x-matt.review-result";
export const MAX_REVIEW_RESULT_PARTS = 24;

// Every frame fits the pinned runtime's 4 KiB preview. Small receipts retain
// their existing shape; large ones are read from a host-owned immutable file.
export function reviewResultFrame(result, index = 0) {
  const text = JSON.stringify(result);
  if (Buffer.byteLength(text) <= 3500) {
    if (index !== 0) throw new Error("Invalid review result part");
    return result;
  }
  const parts = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + 3000);
    while (Buffer.byteLength(JSON.stringify(text.slice(start, end))) > 3000) {
      end = start + Math.floor((end - start) * 0.8);
    }
    parts.push(text.slice(start, end));
    if (parts.length > MAX_REVIEW_RESULT_PARTS) {
      throw new Error(`Review result exceeds the ${MAX_REVIEW_RESULT_PARTS}-frame host transport limit; evidence was not trimmed`);
    }
    start = end;
  }
  if (!Number.isInteger(index) || index < 0 || index >= parts.length) throw new Error("Invalid review result part");
  return {
    format: REVIEW_RESULT_FORMAT, index, count: parts.length, length: text.length,
    sha256: createHash("sha256").update(text).digest("hex"), text: parts[index],
  };
}

export async function prepareTddEvidence(cwd, packageRoot, control = {}, reviewBaseline) {
  const baseline = await collectReviewEvidence(cwd);
  const directory = await mkdtemp(join(tmpdir(), "pi-matt-review-"));
  const baselinePath = join(directory, "baseline.json");
  // A repair batch is pinned to the latest candidate at admission, but review
  // increments accumulate from the last formal review, not the preceding patch.
  const { baseline: _prior, incremental: _increment, ...reviewed } = reviewBaseline ?? baseline;
  await writeFile(baselinePath, JSON.stringify({ baseline: reviewed, control }), { mode: 0o400, flag: "wx" });
  const path = join(directory, "review.md");
  const resultPath = join(directory, "review-result.json");
  return {
    path, baselinePath, snapshotPath: join(directory, "review.json"), snapshotId: baseline.snapshotId, head: baseline.head,
    resultPath,
    resultCommands: Array.from({ length: MAX_REVIEW_RESULT_PARTS - 1 }, (_, index) => ({
      key: `review-result-${index + 1}`,
      command: [process.execPath, join(packageRoot, "scripts/read-review-result.mjs"), resultPath, String(index + 1)]
        .map(quote).join(" "),
    })),
    indexId: createHash("sha256").update(baseline.index).digest("hex"), controlled: true,
    ...(control.batch ? { batch: true } : {}),
    claimCommand: [process.execPath, join(packageRoot, "scripts/claim-implementation.mjs"), join(directory, "dispatch.claim")].map(quote).join(" "),
    command: [process.execPath, join(packageRoot, "scripts/collect-review-evidence.mjs"), baselinePath, path].map(quote).join(" "),
    // The approved commands stay in the read-only control file; the host step is a fixed runner
    // bound to their digest, so the authorized command string also pins what it may execute.
    ...(control.preReviewCommands?.length ? {
      preReviewCommand: [
        process.execPath, join(packageRoot, "scripts/run-pre-review.mjs"), baselinePath,
        createHash("sha256").update(JSON.stringify(control.preReviewCommands)).digest("hex"),
      ].map(quote).join(" "),
    } : {}),
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
