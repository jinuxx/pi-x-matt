import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const digest = value => createHash("sha256").update(value).digest("hex");
const FULL_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const GIT_OPTIONS = { maxBuffer: 64 * 1024 * 1024, timeout: 30000 };
const GIT_GLOBAL = ["--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false"];
const GIT_ENV = { ...process.env, GIT_GRAFT_FILE: devNull };

async function run(cwd, args, encoding = "utf8") {
  const { stdout } = await exec("git", [...GIT_GLOBAL, ...args], {
    cwd, env: GIT_ENV, encoding, ...GIT_OPTIONS,
  });
  return stdout;
}

async function read(cwd, args) {
  return (await run(cwd, args)).trim();
}

async function canonicalRoot(cwd) {
  const project = await realpath(cwd);
  const gitRoot = await realpath(await read(project, ["rev-parse", "--show-toplevel"]));
  const prefix = relative(gitRoot, project).replaceAll(sep, "/");
  if (prefix === ".." || prefix.startsWith("../")) {
    throw new Error("Committed review project is outside its Git worktree");
  }
  await assertLocalObjects(project);
  return { project, gitRoot, prefix };
}

// Git 2.39.5 cannot disable lazy fetch per invocation. Reject promisor clones
// before any object query so a missing blob can never be fetched into this repo.
const PROMISOR_UNSUPPORTED = "Committed review does not support partial/promisor clones: this Git cannot guarantee that object reads avoid lazy fetch; use a full local clone.";

async function assertLocalObjects(cwd) {
  let names;
  try {
    names = await run(cwd, ["config", "--null", "--name-only", "--get-regexp",
      "^remote\\..*\\.[Pp]romisor$"], "buffer");
  } catch (error) {
    if (error.code === 1) names = Buffer.alloc(0);
    else throw error;
  }
  for (const field of nulFields(names)) {
    if (!field.length) continue;
    const key = lossless(field, "promisor config name");
    let values;
    try {
      values = (await read(cwd, ["config", "--type=bool", "--get-all", key]))
        .split("\n").map(value => value.trim()).filter(Boolean);
    } catch (error) {
      if (error.code === 128 && /bad boolean config value/i.test(String(error.stderr ?? ""))) {
        throw new Error("Committed review cannot interpret promisor boolean config; use a valid boolean or remove the promisor remote.");
      }
      throw error;
    }
    if (values.length === 0 || values.some(value => value !== "true" && value !== "false")) {
      throw new Error("Committed review cannot interpret promisor boolean config; use a valid boolean or remove the promisor remote.");
    }
    if (values.includes("true")) throw new Error(PROMISOR_UNSUPPORTED);
  }
  let partial;
  try {
    partial = await run(cwd, ["config", "--null", "--name-only", "--get-regexp",
      "^(remote\\..*\\.[Pp]artial[Cc]lone[Ff]ilter|extensions\\.[Pp]artial[Cc]lone)$"], "buffer");
  } catch (error) {
    if (error.code === 1) partial = Buffer.alloc(0);
    else throw error;
  }
  if (partial.length) throw new Error(PROMISOR_UNSUPPORTED);
}

async function currentHead(cwd) {
  const head = await read(cwd, ["rev-parse", "--verify", "HEAD"]);
  if (!FULL_SHA.test(head)) throw new Error("Committed review requires a valid HEAD commit");
  return head;
}

// A minimal bare metadata view keeps live worktree/index/info/global attributes
// and repository diff drivers out of the pinned object diff. The original
// object store is reached read-only through alternates.
function stripRecordTerminator(bytes) {
  let end = bytes.length;
  if (end > 0 && bytes[end - 1] === 0x0a) end--;
  return bytes.subarray(0, end);
}

// Git's alternates file is line-oriented; quote one path so LF/control bytes
// and quotes/backslashes cannot create extra records. UTF-8 bytes stay intact.
function alternateRecord(pathBytes) {
  if (pathBytes.includes(0)) throw new Error("Committed review object path contains NUL");
  const chunks = [Buffer.from("\"")];
  for (const byte of pathBytes) {
    if (byte === 0x22) chunks.push(Buffer.from("\\\""));
    else if (byte === 0x5c) chunks.push(Buffer.from("\\\\"));
    else if (byte === 0x07) chunks.push(Buffer.from("\\a"));
    else if (byte === 0x08) chunks.push(Buffer.from("\\b"));
    else if (byte === 0x09) chunks.push(Buffer.from("\\t"));
    else if (byte === 0x0a) chunks.push(Buffer.from("\\n"));
    else if (byte === 0x0b) chunks.push(Buffer.from("\\v"));
    else if (byte === 0x0c) chunks.push(Buffer.from("\\f"));
    else if (byte === 0x0d) chunks.push(Buffer.from("\\r"));
    else if (byte < 0x20 || byte === 0x7f) chunks.push(Buffer.from(`\\${byte.toString(8).padStart(3, "0")}`));
    else chunks.push(Buffer.from([byte]));
  }
  chunks.push(Buffer.from("\"\n"));
  return Buffer.concat(chunks);
}

async function createDiffView(project, head) {
  const root = await mkdtemp(join(tmpdir(), "pi-matt-diff-view-"));
  try {
    const view = join(root, "repo");
    const home = join(root, "home");
    await mkdir(join(view, "objects", "info"), { recursive: true });
    await mkdir(join(view, "refs"), { recursive: true });
    await mkdir(join(home, "config"), { recursive: true });
    const primary = stripRecordTerminator(await run(project, ["rev-parse", "--path-format=absolute",
      "--git-path", "objects"], "buffer"));
    if (primary.length === 0) throw new Error("Committed review could not resolve the primary object directory");
    let format;
    try {
      format = (await read(project, ["rev-parse", "--show-object-format"])).trim();
    } catch (error) {
      throw new Error(`Committed review cannot determine Git object format: ${String(error.stderr ?? error.message).trim()}`,
        { cause: error });
    }
    if (format !== "sha1" && format !== "sha256") {
      throw new Error(`Committed review does not support Git object format '${format}'`);
    }
    await writeFile(join(view, "config"), [
      "[core]",
      `\trepositoryformatversion = ${format === "sha256" ? 1 : 0}`,
      "\tbare = true",
      ...(format === "sha256" ? ["[extensions]", "\tobjectFormat = sha256"] : []),
      "",
    ].join("\n"));
    await writeFile(join(view, "HEAD"), `${head}\n`);
    await writeFile(join(view, "objects", "info", "alternates"), alternateRecord(primary));
    return {
      root, view, project,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        XDG_CONFIG_HOME: join(home, "config"),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: devNull,
        GIT_CONFIG_SYSTEM: devNull,
        GIT_ATTR_NOSYSTEM: "1",
        GIT_GRAFT_FILE: devNull,
        GIT_DIR: view,
        GIT_NO_REPLACE_OBJECTS: "1",
        ...(GIT_ENV.GIT_ALTERNATE_OBJECT_DIRECTORIES !== undefined
          ? { GIT_ALTERNATE_OBJECT_DIRECTORIES: GIT_ENV.GIT_ALTERNATE_OBJECT_DIRECTORIES } : {}),
        ...(process.platform === "win32" ? {
          SystemRoot: process.env.SystemRoot ?? "",
          COMSPEC: process.env.COMSPEC ?? "",
          PATHEXT: process.env.PATHEXT ?? "",
        } : {}),
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function runView(context, args, encoding = "utf8") {
  const { stdout } = await exec("git", ["--no-optional-locks", "--no-replace-objects",
    "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", `core.attributesFile=${devNull}`, ...args], {
    cwd: context.project, env: context.env, encoding, ...GIT_OPTIONS,
  });
  return stdout;
}

function assertRef(ref) {
  if (typeof ref !== "string" || !ref || ref.length > 1024 || ref.startsWith("-") ||
      /[\s\u0000-\u001f\u007f]/.test(ref)) {
    throw new Error("Committed review fixedPoint must be a non-empty Git ref");
  }
  return ref;
}

async function resolveCommit(cwd, ref) {
  let stdout;
  try {
    stdout = (await run(cwd, ["rev-parse", "--verify", `${assertRef(ref)}^{commit}`])).trim();
  } catch {
    throw new Error(`Committed review fixedPoint is not a commit: ${ref}`);
  }
  if (!FULL_SHA.test(stdout)) {
    throw new Error(`Committed review fixedPoint did not resolve to a full commit SHA: ${ref}`);
  }
  return stdout;
}

async function assertAncestor(cwd, ancestor, descendant) {
  try {
    await run(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
  } catch (error) {
    if (error.code === 1) {
      throw new Error(`Committed review fixed point ${ancestor} is not an ancestor of HEAD ${descendant}`);
    }
    throw error;
  }
}

/** Validate the only structured scope the tool accepts; never trust caller hashes, HEAD or commands. */
export function normalizeCommittedReviewScope(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("reviewScope must be an object");
  }
  const keys = Object.keys(input);
  if (keys.length !== 2 || !Object.hasOwn(input, "kind") || !Object.hasOwn(input, "fixedPoint")) {
    throw new Error("reviewScope accepts only kind and fixedPoint");
  }
  if (input.kind !== "committed") throw new Error("reviewScope.kind must be 'committed'");
  return { kind: "committed", fixedPoint: assertRef(input.fixedPoint) };
}

/** Resolve the fixed point and pin the current HEAD as the host-owned admission point. */
export async function admitCommittedReview(cwd, fixedPoint) {
  const { project, gitRoot } = await canonicalRoot(cwd);
  const head = await currentHead(project);
  const from = await resolveCommit(project, fixedPoint);
  await assertAncestor(project, from, head);
  if (await currentHead(project) !== head) {
    throw new Error("Committed review: HEAD changed during admission");
  }
  return { fixedPoint: from, head, cwd: project, gitRoot };
}

function lossless(bytes, label) {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) {
    throw new Error(`Committed review ${label} is not losslessly representable as UTF-8; reviewers were not launched.`);
  }
  return text;
}

function nulFields(buffer) {
  const fields = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index++) {
    if (buffer[index] !== 0) continue;
    fields.push(buffer.subarray(start, index));
    start = index + 1;
  }
  if (start < buffer.length) fields.push(buffer.subarray(start));
  return fields;
}

function parseRawEntries(raw) {
  const tokens = nulFields(raw);
  const entries = [];
  for (let index = 0; index < tokens.length && tokens[index]; index++) {
    const header = lossless(tokens[index], "raw diff header");
    if (!header.startsWith(":")) throw new Error("Committed review diff returned an unexpected record");
    const [oldMode, newMode, oldSha, newSha, status] = header.slice(1).split(" ");
    if (!/^[A-Z][0-9]*$/.test(status)) throw new Error("Committed review diff returned an unexpected status");
    const entry = { oldMode, newMode, oldSha, newSha, status };
    if (/^[RC]/.test(status)) {
      entry.oldPath = lossless(tokens[++index] ?? Buffer.alloc(0), "raw diff old path");
      entry.path = lossless(tokens[++index] ?? Buffer.alloc(0), "raw diff path");
    } else {
      entry.path = lossless(tokens[++index] ?? Buffer.alloc(0), "raw diff path");
    }
    if (!entry.path || entry.oldPath === "") throw new Error("Committed review diff returned an empty path");
    entries.push(entry);
  }
  return entries;
}

async function blobSupport(readObject, sha, mode) {
  const bytes = await readObject(["cat-file", "blob", sha], "buffer");
  const sha256 = digest(bytes);
  if (mode === "120000") {
    if (bytes.includes(0)) return { kind: "unsupported", sha256: null };
    return { kind: "symlink", sha256, content: lossless(bytes, "symlink") };
  }
  const content = bytes.toString("utf8");
  const binary = bytes.includes(0) || !Buffer.from(content).equals(bytes);
  return { kind: "file", sha256, binary, ...(binary ? {} : { encoding: "utf8", content }) };
}

async function blobEvidence(readObject, entry) {
  const base = { status: entry.status, path: entry.path, ...(entry.oldPath ? { oldPath: entry.oldPath } : {}) };
  // A gitlink on either side is not a readable project file here.
  if (entry.oldMode === "160000" || entry.newMode === "160000") {
    return { ...base, kind: "unsupported", sha256: null };
  }
  if (entry.oldMode !== "000000" && !entry.status.startsWith("A")) {
    const previous = await blobSupport(readObject, entry.oldSha, entry.oldMode);
    if (previous.binary || previous.kind === "unsupported") return { ...base, kind: "unsupported", sha256: null };
  }
  if (entry.status.startsWith("D")) return { ...base, kind: "deleted", sha256: null };
  const next = await blobSupport(readObject, entry.newSha, entry.newMode);
  if (next.kind === "unsupported") return { ...base, kind: "unsupported", sha256: null };
  if (next.kind === "symlink") {
    return { ...base, kind: "symlink", mode: "120000", sha256: next.sha256, content: next.content };
  }
  return {
    ...base, kind: "file", mode: entry.newMode, sha256: next.sha256,
    ...(next.binary ? { binary: true } : { encoding: "utf8", content: next.content }),
  };
}

/** Re-verify the live repository after artifacts have been published. */
export async function assertCommittedReviewFresh(cwd, control) {
  const { project, gitRoot } = await canonicalRoot(cwd);
  if (control.cwd !== project || control.gitRoot !== gitRoot) {
    throw new Error("Committed review evidence: project or Git root changed since admission");
  }
  if (await currentHead(project) !== control.head) {
    throw new Error("Committed review evidence: HEAD changed since admission");
  }
  return { project, gitRoot };
}

/** Collect object-store evidence for exactly F..H; never lstat or read the live worktree. */
export async function collectCommittedReviewEvidence(cwd, control) {
  if (!control || typeof control !== "object" || Array.isArray(control)) {
    throw new Error("Committed review evidence requires a host-pinned range");
  }
  if (!FULL_SHA.test(control.fixedPoint ?? "") || !FULL_SHA.test(control.head ?? "")) {
    throw new Error("Committed review evidence requires full commit SHAs pinned at admission");
  }
  const { project, gitRoot, prefix } = await canonicalRoot(cwd);
  if (control.cwd !== project || control.gitRoot !== gitRoot) {
    throw new Error("Committed review evidence: project or Git root changed since admission");
  }
  if (await currentHead(project) !== control.head) {
    throw new Error("Committed review evidence: HEAD changed since admission");
  }
  if (await resolveCommit(project, control.fixedPoint) !== control.fixedPoint) {
    throw new Error("Committed review evidence: fixed point no longer resolves to the admitted commit");
  }
  await assertAncestor(project, control.fixedPoint, control.head);
  const range = [control.fixedPoint, control.head];
  const view = await createDiffView(project, control.head);
  let manifest, diff;
  try {
    const relativeArg = prefix ? `--relative=${prefix}` : "--relative";
    const pathspec = prefix || ".";
    const readObject = (args, encoding) => runView(view, args, encoding);
    const raw = await runView(view, ["diff", "--raw", "-z", "--no-abbrev", "-M", "--ignore-submodules=none",
      relativeArg, ...range, "--", pathspec], "buffer");
    manifest = await Promise.all(parseRawEntries(raw).map(entry => blobEvidence(readObject, entry)));
    diff = lossless(await runView(view, ["diff", "--no-ext-diff", "--no-textconv", "--text",
      "--ignore-submodules=none", "--find-renames", relativeArg, "--unified=3", ...range, "--", pathspec], "buffer"),
    "combined diff");
  } finally {
    await rm(view.root, { recursive: true, force: true });
  }
  await assertCommittedReviewFresh(project, control);
  return {
    version: 1, source: "workflow-git-committed-collector", reviewKind: "committed",
    snapshotId: digest(JSON.stringify({ reviewKind: "committed", fixedPoint: control.fixedPoint,
      head: control.head, cwd: project, manifest, diff })),
    fixedPoint: control.fixedPoint, head: control.head, gitRoot, cwd: project,
    manifest, diff, diffSha256: digest(diff),
    complete: !/^GIT binary patch$/m.test(diff) &&
      manifest.every(entry => entry.kind !== "unsupported" && !entry.binary),
  };
}
