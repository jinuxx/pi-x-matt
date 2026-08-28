import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const SAFE_REF = /^(?!-)[A-Za-z0-9._/@{}~^:+-]+$/;

function requireRef(value: string | undefined): string {
  const ref = value?.trim();
  if (!ref || !SAFE_REF.test(ref)) throw new Error("git_read requires a safe Git ref without option syntax");
  return ref;
}

function safePath(cwd: string, value: string | undefined): string | undefined {
  if (!value) return undefined;
  const absolute = resolve(cwd, value);
  const root = `${resolve(cwd)}/`;
  if (absolute !== resolve(cwd) && !absolute.startsWith(root)) throw new Error("git_read path must stay inside the project");
  return absolute === resolve(cwd) ? "." : absolute.slice(root.length);
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "git_read",
    label: "Git Read",
    description: "Run a fixed allowlist of read-only Git queries for review. Output is truncated to 50KB/2000 lines.",
    parameters: Type.Object({
      action: StringEnum(["status", "resolve", "commits", "diff-files", "diff", "worktree-files", "worktree-diff", "show"] as const),
      ref: Type.Optional(Type.String({ description: "Base ref or object name; required for resolve/commits/diff-files/diff/show" })),
      path: Type.Optional(Type.String({ description: "Optional project-relative path for diff/show/worktree queries" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      let args: string[];
      const path = safePath(ctx.cwd, params.path);
      switch (params.action) {
        case "status":
          args = ["status", "--short", "--branch"];
          break;
        case "resolve":
          args = ["rev-parse", "--verify", requireRef(params.ref)];
          break;
        case "commits":
          args = ["log", "--oneline", `${requireRef(params.ref)}..HEAD`, "--"];
          break;
        case "diff-files":
          args = ["diff", "--name-status", `${requireRef(params.ref)}...HEAD`, "--"];
          break;
        case "diff":
          args = ["diff", "--no-ext-diff", "--unified=80", `${requireRef(params.ref)}...HEAD`, "--", ...(path ? [path] : [])];
          break;
        case "worktree-files":
          args = ["status", "--short", "--untracked-files=all", "--", ...(path ? [path] : [])];
          break;
        case "worktree-diff":
          args = ["diff", "--no-ext-diff", "--unified=80", "HEAD", "--", ...(path ? [path] : [])];
          break;
        case "show":
          args = ["show", "--no-ext-diff", "--format=fuller", requireRef(params.ref), "--", ...(path ? [path] : [])];
          break;
      }

      const result = await pi.exec("git", args, { cwd: ctx.cwd, signal });
      const combined = [result.stdout, result.stderr].filter(Boolean).join("\n");
      const truncated = truncateHead(combined, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
      if (result.code !== 0) throw new Error(truncated.content || `git exited with ${result.code}`);
      const suffix = truncated.truncated ? "\n\n[Output truncated; narrow the query with path.]" : "";
      return {
        content: [{ type: "text", text: `${truncated.content}${suffix}` }],
        details: { action: params.action, args, exitCode: result.code, truncated: truncated.truncated },
      };
    },
  });
}
