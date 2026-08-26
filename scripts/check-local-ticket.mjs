#!/usr/bin/env node

import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const ticket = process.argv[2] ?? null;
const result = {
  ok: false,
  ticket,
  blockers: [],
  errors: [],
};

function metadata(content, field) {
  const lines = content.split("\n");
  if (!/^# /.test(lines[0])) return undefined;

  let index = 1;
  while (index < lines.length && lines[index].trim() === "") index += 1;

  for (; index < lines.length && lines[index].trim() !== ""; index += 1) {
    const match = lines[index].match(/^([^:]+):\s*(.*?)\s*$/);
    if (!match) break;
    if (match[1] === field) return match[2];
  }

  return undefined;
}

try {
  if (typeof ticket !== "string" || isAbsolute(ticket)) {
    result.errors.push("Ticket path must be repository-relative");
  } else {
    const root = process.cwd();
    const target = resolve(root, ticket);
    const pathFromRoot = relative(root, target);
    const outsideRoot = pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`);
    const outsideScratch = !pathFromRoot.startsWith(`.scratch${sep}`);

    if (outsideRoot || outsideScratch) {
      result.errors.push("Ticket path must be under .scratch");
    } else {
      const realRoot = await realpath(root);
      const realTarget = await realpath(target);
      const realPathFromRoot = relative(realRoot, realTarget);
      const outsideRealRoot =
        realPathFromRoot === ".." || realPathFromRoot.startsWith(`..${sep}`);
      const outsideRealScratch = !realPathFromRoot.startsWith(`.scratch${sep}`);

      if (outsideRealRoot || outsideRealScratch) {
        result.errors.push("Ticket path must be under .scratch");
      } else {
        const content = await readFile(realTarget, "utf8");
        const type = metadata(content, "Type");
        const parent = metadata(content, "Parent");
        const status = metadata(content, "Status");
        const blockedBy = metadata(content, "Blocked by");

        if (type !== "ticket") result.errors.push("Type must be ticket");
        if (!parent) result.errors.push("Parent is required");
        if (status !== "ready-for-agent") result.errors.push("Status must be ready-for-agent");
        if (blockedBy === undefined) {
          result.errors.push("Blocked by must be None");
        } else if (blockedBy !== "None") {
          const blockerReferences = blockedBy.split(",").map((reference) => reference.trim());

          for (const blockerReference of blockerReferences) {
            const blocker = {
              ticket: blockerReference,
              type: null,
              status: null,
              ok: false,
            };
            result.blockers.push(blocker);

            const blockerTarget = resolve(root, blockerReference);
            const blockerPathFromRoot = relative(root, blockerTarget);
            const outsideBlockerRoot =
              blockerPathFromRoot === ".." || blockerPathFromRoot.startsWith(`..${sep}`);
            const outsideBlockerScratch = !blockerPathFromRoot.startsWith(`.scratch${sep}`);

            if (
              blockerReference === "" ||
              isAbsolute(blockerReference) ||
              outsideBlockerRoot ||
              outsideBlockerScratch
            ) {
              result.errors.push(
                `Blocker ${JSON.stringify(blockerReference)} must be a repository-relative path under .scratch`,
              );
              continue;
            }

            try {
              const realBlockerTarget = await realpath(blockerTarget);
              const realBlockerPathFromRoot = relative(realRoot, realBlockerTarget);
              const outsideRealBlockerRoot =
                realBlockerPathFromRoot === ".." ||
                realBlockerPathFromRoot.startsWith(`..${sep}`);
              const outsideRealBlockerScratch = !realBlockerPathFromRoot.startsWith(
                `.scratch${sep}`,
              );

              if (outsideRealBlockerRoot || outsideRealBlockerScratch) {
                result.errors.push(
                  `Blocker ${JSON.stringify(blockerReference)} must be a repository-relative path under .scratch`,
                );
                continue;
              }

              const blockerContent = await readFile(realBlockerTarget, "utf8");
              blocker.type = metadata(blockerContent, "Type") ?? null;
              blocker.status = metadata(blockerContent, "Status") ?? null;

              if (blocker.type !== "ticket") {
                result.errors.push(`Blocker ${blockerReference} Type must be ticket`);
              }
              if (blocker.status !== "resolved") {
                result.errors.push(`Blocker ${blockerReference} Status must be resolved`);
              }
              blocker.ok = blocker.type === "ticket" && blocker.status === "resolved";
            } catch {
              result.errors.push(`Blocker ${blockerReference} could not be read`);
            }
          }
        }
      }
    }
  }
  result.ok = result.errors.length === 0;
} catch {
  result.errors.push("Ticket file could not be read");
}

process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.ok ? 0 : 1;
