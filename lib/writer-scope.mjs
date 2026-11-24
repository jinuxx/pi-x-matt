import { execFile } from "node:child_process";
import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";

export const WRITER_SCOPE_BINDING = "pi-x-matt.writer-scope/1";
export const WRITER_WAIT_FILE = "writer-supervisor-wait-ms";
export const SCOPED_WRITER_AGENT = "matt-scoped-writer";
export const SCOPED_EDIT = "matt_scoped_edit";
export const SCOPED_WRITE = "matt_scoped_write";
export const SCOPED_CHECK = "matt_scoped_check";
export const SCOPED_WRITER_TOOLS = Object.freeze([
  "read", "grep", "find", "ls", SCOPED_EDIT, SCOPED_WRITE, SCOPED_CHECK, "structured_output", "contact_supervisor",
]);

// Match the native timer's blocking contact_supervisor reasons; progress updates do not pause it.
export function writerSupervisorWait(now = () => performance.now()) {
  const waiting = new Set();
  let startedAt, elapsed = 0;
  return {
    start({ toolName, toolCallId, args }) {
      if (toolName !== "contact_supervisor" || !["need_decision", "interview_request"].includes(args?.reason)) return;
      if (!waiting.size) startedAt = now();
      waiting.add(toolCallId);
    },
    end(toolCallId) {
      if (!waiting.delete(toolCallId) || waiting.size) return;
      elapsed += now() - startedAt;
      return Math.floor(elapsed);
    },
  };
}
const exec = promisify(execFile);
const PRIVATE = new Set([".git", ".pi", ".x-matt"]);

export function isScopedPath(path) {
  return typeof path === "string" && !/[\u0000-\u001f\u007f\\*?[\]:]/u.test(path) &&
    path.split("/").every(part => part && part !== "." && part !== ".." && !PRIVATE.has(part.toLowerCase()));
}

export function permitsWritePath({ allowedFiles, allowedDirectories }, path) {
  return allowedDirectories === undefined ? allowedFiles.includes(path)
    : isScopedPath(path) && (allowedFiles.includes(path) || allowedDirectories.some(dir => path.startsWith(`${dir}/`)));
}

async function statOrAbsent(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

// Walk path components without following links, including a parent of an as-yet absent file.
async function checkPath(root, path, directory) {
  if (!isScopedPath(path)) throw new Error(`Invalid or private writer path: ${JSON.stringify(path)}`);
  let absolute = root;
  const parts = path.split("/");
  for (const [index, part] of parts.entries()) {
    const parent = absolute;
    absolute = join(parent, part);
    const stat = await statOrAbsent(absolute);
    if (!stat) break;
    const needsDirectory = index < parts.length - 1 || directory;
    if ((needsDirectory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
        !(await readdir(parent)).includes(part)) {
      throw new Error(`Writer path is a link, non-canonical or not a regular ${needsDirectory ? "directory" : "file"}: ${path}`);
    }
    if (needsDirectory && await statOrAbsent(join(absolute, ".git"))) {
      throw new Error(`Writer path enters a nested Git worktree: ${path}`);
    }
  }
  return join(root, path);
}

async function assertNotIgnored(root, paths) {
  if (!paths.length) return;
  let ignored;
  try {
    ({ stdout: ignored } = await exec("git", ["check-ignore", "--", ...paths], { cwd: root, timeout: 10_000 }));
  } catch (error) {
    if (error.code === 1) return;
    throw error;
  }
  throw new Error(`Writer scope cannot include Git-ignored paths: ${ignored.trim()}`);
}

export async function assertScopedPaths(root, { allowedFiles, allowedDirectories }) {
  for (const path of allowedFiles) await checkPath(root, path, false);
  for (const dir of allowedDirectories) {
    const target = await checkPath(root, dir, true);
    const parent = dirname(target);
    if (!(await statOrAbsent(parent))?.isDirectory() || (parent === root && !await statOrAbsent(target))) {
      throw new Error(`Writer directory must be an existing module directory or a new child of one: ${dir}`);
    }
  }
  await assertNotIgnored(root, [...allowedFiles, ...allowedDirectories.map(dir => `${dir}/`)]);
}

export async function scopedWriteTarget(cwd, grant, input) {
  if (grant.readOnly) throw new Error("Batch timeout continuation only verifies the sealed candidate; writes are blocked");
  const root = await realpath(cwd);
  if (grant.root !== root || typeof input !== "string") throw new Error("Writer scope is not bound to this worktree");
  const path = isAbsolute(input) && input.startsWith(`${root}${sep}`)
    ? input.slice(root.length + 1).split(sep).join("/") : input;
  if (!isScopedPath(path)) throw new Error(`Invalid or private writer path: ${JSON.stringify(path)}`);
  if (!permitsWritePath(grant, path)) {
    throw new Error(`Write blocked before mutation: ${path} is outside the approved scope. Report all needed paths in scopeBlocker.`);
  }
  if (grant.protectedPaths.includes(path)) throw new Error(`Write blocked: preserve pre-existing user changes in ${path}`);
  const target = await checkPath(root, path, false);
  await assertNotIgnored(root, [path]);
  return target;
}
