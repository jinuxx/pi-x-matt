import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import {
  createBashTool, createEditTool, createLocalBashOperations, createWriteTool, type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { assertScopedWriterChecks, runScopedWriterCheck } from "../lib/review-evidence.mjs";
import { SCOPED_CHECK, SCOPED_EDIT, SCOPED_WRITE, SCOPED_WRITER_TOOLS,
  scopedWriteTarget, WRITER_SCOPE_BINDING, writerSupervisorWait } from "../lib/writer-scope.mjs";

const environmentKey = "PI_SUBAGENT_EXTENSION_BINDINGS";
const allowedTools = new Set<string>(SCOPED_WRITER_TOOLS);
const guarded = [SCOPED_WRITE, SCOPED_EDIT, SCOPED_CHECK];

export default function (pi: ExtensionAPI) {
  const binding = JSON.parse(process.env[environmentKey] ?? "{}")[WRITER_SCOPE_BINDING];
  if (binding === undefined) return; // Without the grant, required mutation tools never register.
  const grant = async (cwd: string) => {
    const data = JSON.parse(await readFile(binding, "utf8"));
    if (data.version !== 1 || await realpath(cwd) !== data.root) {
      throw new Error("Scoped writer has no host grant for this worktree");
    }
    await assertScopedWriterChecks(dirname(data.waitPath));
    return data;
  };
  const source = fileURLToPath(import.meta.url);
  let ready = false;
  let waitPath: string;
  let wait = writerSupervisorWait();
  pi.on("session_start", async (_event, ctx) => {
    ({ waitPath } = await grant(ctx.cwd));
    const tools = pi.getAllTools();
    for (const name of guarded) {
      const tool = tools.find(item => item.name === name);
      if (!tool || tool.sourceInfo.path !== source && await realpath(tool.sourceInfo.path) !== await realpath(source)) {
        throw new Error(`Scoped writer requires the guarded ${name} tool, without a competing override`);
      }
    }
    // A retained child opens a new attempt. Never carry waits over to another run.
    wait = writerSupervisorWait();
    await writeFile(waitPath, "0", { mode: 0o600 });
    pi.setActiveTools(pi.getActiveTools().filter(name => allowedTools.has(name)));
    ready = true;
  });
  pi.on("tool_execution_start", event => { if (ready) wait.start(event); });
  pi.on("tool_execution_end", event => {
    const elapsed = wait.end(event.toolCallId);
    if (elapsed !== undefined) writeFileSync(waitPath, String(elapsed));
  });
  pi.on("tool_call", event => {
    if (!ready) return { block: true, reason: "Scoped writer tool initialization failed" };
    if (!allowedTools.has(event.toolName)) {
      return { block: true, reason: "Scoped writer: use only its guarded write, edit and check tools." };
    }
  });

  pi.registerTool({
    ...createWriteTool(process.cwd()),
    name: SCOPED_WRITE,
    async execute(id, params, signal, onUpdate, ctx) {
      const path = await scopedWriteTarget(ctx.cwd, await grant(ctx.cwd), params.path);
      return createWriteTool(ctx.cwd, { operations: {
        mkdir: () => mkdir(dirname(path), { recursive: true }).then(() => {}),
        writeFile: (_path, content) => writeFile(path, content, "utf8"),
      } }).execute(id, { ...params, path }, signal, onUpdate);
    },
  });
  pi.registerTool({
    ...createEditTool(process.cwd()),
    name: SCOPED_EDIT,
    async execute(id, params, signal, onUpdate, ctx) {
      const path = await scopedWriteTarget(ctx.cwd, await grant(ctx.cwd), params.path);
      return createEditTool(ctx.cwd, { operations: {
        access: () => access(path), readFile: () => readFile(path),
        writeFile: (_path, content) => writeFile(path, content, "utf8"),
      } }).execute(id, { ...params, path }, signal, onUpdate);
    },
  });
  const bash = createBashTool(process.cwd());
  const local = createLocalBashOperations();
  pi.registerTool({
    ...bash,
    name: SCOPED_CHECK,
    description: "Run a verbatim host-approved check in the project. Do not modify the Git candidate or index.",
    promptSnippet: "Run a host-approved RED/GREEN or validation command in the project",
    promptGuidelines: ["Use read/find/grep/ls for discovery; arbitrary shell or filesystem commands are not permitted."],
    executionMode: "sequential",
    async execute(id, params, signal, onUpdate, ctx) {
      const current = await grant(ctx.cwd);
      if (!current.commands.includes(params.command)) throw new Error("Scoped writer only runs exact approved check commands");
      const env = { ...process.env };
      delete env[environmentKey];
      const tool = createBashTool(ctx.cwd, { operations: {
        exec: (command, directory, options) => local.exec(command, directory, { ...options, env }),
      } });
      return runScopedWriterCheck(ctx.cwd, dirname(current.waitPath), () => tool.execute(id, params, signal, onUpdate));
    },
  });
}
