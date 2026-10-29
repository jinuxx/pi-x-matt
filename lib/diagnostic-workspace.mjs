import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { isDiagnosticTestPath } from "./dispatch-authorization.mjs";
import { collectReviewEvidence } from "./review-evidence.mjs";

const exec = promisify(execFile);
const digest = value => createHash("sha256").update(value).digest("hex");
const slash = path => path.replaceAll("\\", "/");

function isProjectRelative(path) {
  return typeof path === "string" && path.length > 0 && !isAbsolute(path) &&
    path.split(/[\\/]/).every(part => part && part !== "." && part !== "..");
}

function segments(path) {
  return path.split(/[\\/]/);
}

/** Inline reproduction files may only add or replace exact host-approved diagnostic paths. */
export function normalizeDiagnosticTestFiles(scope, testFiles) {
  if (testFiles === undefined) return undefined;
  if (!Array.isArray(testFiles) || testFiles.length === 0) {
    throw new Error("repair.diagnosis.testFiles must contain inline reproduction files");
  }
  const approved = scope?.diagnosticFiles ?? [];
  const productionApproved = approved.find(path => !isDiagnosticTestPath(path));
  if (productionApproved) {
    throw new Error(
      `implementation.diagnosticFiles may only list test or fixture paths: ${productionApproved}`,
    );
  }
  const seen = new Set();
  const normalized = testFiles.map(file => {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string" ||
        !isProjectRelative(file.path)) {
      throw new Error("repair.diagnosis.testFiles entries require exact project-relative paths and inline content");
    }
    if (!isDiagnosticTestPath(file.path)) {
      throw new Error(`Diagnostic test file must be a test or fixture path: ${file.path}`);
    }
    if (seen.has(file.path)) throw new Error(`Duplicate diagnostic test file: ${file.path}`);
    seen.add(file.path);
    if (!approved.includes(file.path)) {
      throw new Error(`Diagnostic test file is outside implementation.diagnosticFiles: ${file.path}`);
    }
    return { path: file.path, content: file.content };
  });
  return normalized.sort((left, right) => left.path.localeCompare(right.path));
}

/** Host-owned evidence must still describe the current worktree before anything is reconstructed. */
export async function verifyReviewedSnapshot(projectRoot, reviewedSnapshotId) {
  const current = await collectReviewEvidence(projectRoot);
  if (!current.complete) throw new Error("Reviewed snapshot is incomplete; diagnosis cannot reconstruct it");
  if (current.snapshotId !== reviewedSnapshotId) {
    throw new Error(
      "Original worktree no longer matches the reviewed snapshot; recreate the review baseline before diagnosis",
    );
  }
  return current;
}

function assertReviewedManifest(manifest) {
  for (const entry of manifest) {
    if (!entry || !isProjectRelative(entry.path)) {
      throw new Error("Reviewed evidence contains an unsafe path; recreate the review baseline");
    }
    if (entry.kind === "deleted") {
      if (entry.sha256 !== null) {
        throw new Error(`Reviewed deletion changed for ${entry.path}; recreate the review baseline`);
      }
      continue;
    }
    if (entry.kind === "symlink") {
      if (typeof entry.content !== "string" || digest(entry.content) !== entry.sha256) {
        throw new Error(`Reviewed symlink changed for ${entry.path}; recreate the review baseline`);
      }
      continue;
    }
    if (entry.kind !== "file" || typeof entry.content !== "string") {
      throw new Error(`Reviewed evidence cannot rebuild ${entry.path}; recreate the review baseline`);
    }
    const bytes = entry.encoding === "base64" ? Buffer.from(entry.content, "base64")
      : Buffer.from(entry.content, "utf8");
    if (digest(bytes) !== entry.sha256) {
      throw new Error(`Reviewed content changed for ${entry.path}; recreate the review baseline`);
    }
  }
}

function assertReviewedPackBinding(pack, reviewedSnapshotId) {
  if (pack.diffSha256 !== digest(pack.diff)) {
    throw new Error("Reviewed evidence pack diff does not match its host digest; recreate the review baseline");
  }
  const actual = digest(JSON.stringify({
    head: pack.head, cwd: pack.cwd, manifest: pack.manifest, diff: pack.diff,
  }));
  if (actual !== reviewedSnapshotId) {
    throw new Error("Reviewed evidence pack does not match the host snapshot; recreate the review baseline");
  }
  assertReviewedManifest(pack.manifest);
}

async function readReviewedPack(packPath, projectRoot, reviewedSnapshotId) {
  if (typeof packPath !== "string" || !packPath) {
    throw new Error("Inline diagnostic tests require the host-reviewed evidence pack; no isolated diagnosis was run");
  }
  let pack;
  try {
    pack = JSON.parse(await readFile(packPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("Host-reviewed evidence pack is missing; recreate the review baseline before diagnosis");
    }
    throw error;
  }
  if (pack?.version !== 1 || pack.source !== "workflow-git-collector" || pack.reviewKind !== "worktree" ||
      !Array.isArray(pack.manifest) || typeof pack.snapshotId !== "string" || typeof pack.head !== "string" ||
      !pack.head || typeof pack.cwd !== "string" || !pack.cwd ||
      typeof pack.gitRoot !== "string" || !pack.gitRoot ||
      typeof pack.diff !== "string" || typeof pack.diffSha256 !== "string" ||
      pack.snapshotId !== reviewedSnapshotId || pack.complete !== true) {
    throw new Error(
      "Reviewed evidence pack is stale, incomplete or not host-collected; recreate the review baseline",
    );
  }
  const root = await realpath(projectRoot);
  if (pack.cwd !== root) {
    throw new Error("Reviewed evidence pack belongs to a different project; recreate the review baseline");
  }
  assertReviewedPackBinding(pack, reviewedSnapshotId);
  let actualGitRoot, actualHead;
  try {
    actualGitRoot = await realpath((await exec("git", ["rev-parse", "--show-toplevel"], {
      cwd: root, timeout: 30_000, maxBuffer: 1024 * 1024,
    })).stdout.trim());
    actualHead = (await exec("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: root, timeout: 30_000, maxBuffer: 1024 * 1024,
    })).stdout.trim();
  } catch {
    throw new Error("Reviewed evidence pack project identity is unavailable; recreate the review baseline");
  }
  if (pack.head !== actualHead) {
    throw new Error("Reviewed evidence pack HEAD does not match the current worktree; recreate the review baseline");
  }
  const gitRoot = await realpath(pack.gitRoot).catch(() => {
    throw new Error("Reviewed evidence pack Git root is unavailable; recreate the review baseline");
  });
  if (gitRoot !== actualGitRoot) {
    throw new Error("Reviewed evidence pack belongs to a different Git worktree; recreate the review baseline");
  }
  const prefix = relative(actualGitRoot, root);
  if (prefix === ".." || prefix.startsWith(`..${sep}`) || isAbsolute(prefix)) {
    throw new Error("Reviewed evidence pack is outside its Git worktree; recreate the review baseline");
  }
  return { pack, prefix: slash(prefix) };
}

function projectReplica(tree, prefix) {
  return prefix ? join(tree, ...segments(prefix)) : tree;
}

function treePath(prefix, path) {
  return prefix ? `${prefix}/${slash(path)}` : slash(path);
}

async function extractHead(projectRoot, tree, temp) {
  const env = { ...process.env, GIT_INDEX_FILE: join(temp, "head.index") };
  await exec("git", ["read-tree", "HEAD"], { cwd: projectRoot, env, timeout: 30_000, maxBuffer: 1024 * 1024 });
  await exec("git", ["checkout-index", "-a", `--prefix=${tree}${sep}`], {
    cwd: projectRoot, env, timeout: 60_000, maxBuffer: 1024 * 1024,
  });
}

function assertLinkInside(root, path, target) {
  const resolved = resolve(root, dirname(path), target);
  const rel = relative(root, resolved);
  if (isAbsolute(target) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`Reviewed symlink escapes the diagnostic workspace: ${path}`);
  }
}

async function ensureDirectory(root, pathSegments) {
  let current = root;
  for (const part of pathSegments) {
    current = join(current, part);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await mkdir(current);
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Diagnostic workspace path is not a real directory: ${relative(root, current)}`);
    }
  }
}

async function removePath(root, path) {
  if (!isProjectRelative(path)) {
    throw new Error(`Reviewed evidence path is not project-relative: ${String(path)}`);
  }
  const target = join(root, ...segments(path));
  let stat;
  try {
    stat = await lstat(target);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return;
  }
  if (stat.isDirectory()) throw new Error(`Reviewed evidence cannot replace a directory: ${path}`);
  await rm(target, { force: true });
}

async function writeFileAt(root, path, bytes, sha256, fallbackMode) {
  const parts = segments(path);
  await ensureDirectory(root, parts.slice(0, -1));
  const target = join(root, ...parts);
  let stat;
  try {
    stat = await lstat(target);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    stat = null;
  }
  if (stat?.isDirectory()) throw new Error(`Diagnostic workspace path is a directory: ${path}`);
  const mode = stat?.isFile() ? stat.mode & 0o777 : fallbackMode ?? 0o600;
  if (stat) await rm(target, { force: true });
  await writeFile(target, bytes, { mode });
  if (sha256 && digest(bytes) !== sha256) {
    throw new Error(`Reviewed content changed for ${path}; recreate the review baseline`);
  }
}

async function overlayReviewedState(tree, prefix, manifest, projectRoot) {
  const root = projectReplica(tree, prefix);
  for (const entry of manifest) {
    if (!entry || !isProjectRelative(entry.path)) {
      throw new Error("Reviewed evidence contains an unsafe path; recreate the review baseline");
    }
    if (entry.oldPath && /R/.test(entry.status ?? "")) await removePath(root, entry.oldPath);
    if (String(entry.status ?? "").includes("D")) {
      await removePath(root, entry.path);
      continue;
    }
    const target = treePath(prefix, entry.path);
    if (entry.kind === "symlink") {
      if (typeof entry.content !== "string" || digest(entry.content) !== entry.sha256) {
        throw new Error(`Reviewed symlink changed for ${entry.path}; recreate the review baseline`);
      }
      assertLinkInside(tree, target, entry.content);
      await ensureDirectory(root, segments(entry.path).slice(0, -1));
      const link = join(root, ...segments(entry.path));
      const stat = await lstat(link).catch(error => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (stat?.isDirectory()) {
        throw new Error(`Reviewed evidence cannot replace a directory with a symlink: ${entry.path}`);
      }
      if (stat) await rm(link, { force: true });
      await symlink(entry.content, link);
      continue;
    }
    if (entry.kind !== "file" || typeof entry.content !== "string") {
      throw new Error(`Reviewed evidence cannot reconstruct ${entry.path}; recreate the review baseline`);
    }
    const bytes = entry.encoding === "base64" ? Buffer.from(entry.content, "base64")
      : Buffer.from(entry.content, "utf8");
    const mode = await lstat(join(projectRoot, ...segments(entry.path)))
      .then(stat => stat.isFile() ? stat.mode & 0o777 : undefined).catch(() => undefined);
    await writeFileAt(root, entry.path, bytes, entry.sha256, mode);
  }
}

async function writeDiagnosticFiles(tree, prefix, testFiles) {
  const root = projectReplica(tree, prefix);
  const written = [];
  for (const file of testFiles) {
    const bytes = Buffer.from(file.content, "utf8");
    await writeFileAt(root, file.path, bytes);
    written.push({ path: file.path, sha256: digest(bytes) });
  }
  return written;
}

/** Record file content and permissions to detect non-diagnostic state changes. */
async function fingerprintWorkspace(root) {
  const files = new Map();
  const walk = async (directory, prefix) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await readlink(absolute);
        const rel = relative(root, resolve(directory, target));
        if (isAbsolute(target) || rel === ".." || rel.startsWith(`..${sep}`)) {
          throw new Error(`Reviewed symlink escapes the diagnostic workspace: ${path}`);
        }
        files.set(path, `link:${target}`);
      } else if (entry.isDirectory()) {
        await walk(absolute, path);
      } else if (entry.isFile()) {
        const mode = (await lstat(absolute)).mode & 0o7777;
        files.set(path, `${mode}:${digest(await readFile(absolute))}`);
      } else {
        throw new Error(`Diagnostic workspace contains an unsupported entry: ${path}`);
      }
    }
  };
  await walk(root, "");
  return files;
}

/**
 * Rebuild the reviewed project from HEAD plus reviewed worktree changes in a host-owned OS temp area.
 * This is local fault isolation, not a security sandbox: the command still runs as the same user.
 */
export async function prepareDiagnosticWorkspace({
  projectRoot, packPath, reviewedSnapshotId, scope, testFiles, tmpRoot = tmpdir(),
}) {
  const files = normalizeDiagnosticTestFiles(scope, testFiles);
  if (!files) throw new Error("Isolated diagnosis requires inline reproduction files");
  const { pack, prefix } = await readReviewedPack(packPath, projectRoot, reviewedSnapshotId);
  await verifyReviewedSnapshot(projectRoot, reviewedSnapshotId);
  const temp = await mkdtemp(join(tmpRoot, "pi-matt-diagnosis-"));
  try {
    const tree = join(temp, "tree");
    await mkdir(tree);
    await extractHead(projectRoot, tree, temp);
    await fingerprintWorkspace(tree);
    await overlayReviewedState(tree, prefix, pack.manifest, projectRoot);
    const baseline = await fingerprintWorkspace(tree);
    const written = await writeDiagnosticFiles(tree, prefix, files);
    const approved = new Set(written.map(file => treePath(prefix, file.path)));
    return {
      cwd: projectReplica(tree, prefix),
      reviewedSnapshotId,
      testFiles: written,
      async assertUntouched() {
        const after = await fingerprintWorkspace(tree);
        const changed = new Set();
        for (const [path, hash] of baseline) {
          if (!approved.has(path) && after.get(path) !== hash) changed.add(path);
        }
        for (const path of after.keys()) {
          if (!approved.has(path) && !baseline.has(path)) changed.add(path);
        }
        return [...changed].sort();
      },
      async dispose() {
        await rm(temp, { recursive: true, force: true });
      },
    };
  } catch (error) {
    try {
      await rm(temp, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError],
        "Diagnostic workspace preparation failed; cleanup also failed", { cause: error });
    }
    throw error;
  }
}
