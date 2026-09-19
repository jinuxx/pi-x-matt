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

function isShippedPath(pathFromRoot) {
  return (
    pathFromRoot === ".x-matt/work/shipped" ||
    pathFromRoot.startsWith(`.x-matt/work/shipped${sep}`)
  );
}

try {
  if (typeof ticket !== "string" || isAbsolute(ticket)) {
    result.errors.push("Ticket path must be repository-relative");
  } else {
    const root = process.cwd();
    const target = resolve(root, ticket);
    const pathFromRoot = relative(root, target);
    const outsideRoot = pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`);
    const outsideWork = !pathFromRoot.startsWith(`.x-matt/work${sep}`);

    if (outsideRoot || outsideWork) {
      result.errors.push("Ticket path must be under .x-matt/work");
    } else if (isShippedPath(pathFromRoot)) {
      result.errors.push(
        "Ticket path under .x-matt/work/shipped is archived and cannot be an implementation entry",
      );
    } else {
      const realRoot = await realpath(root);
      const realTarget = await realpath(target);
      const realPathFromRoot = relative(realRoot, realTarget);
      const outsideRealRoot =
        realPathFromRoot === ".." || realPathFromRoot.startsWith(`..${sep}`);
      const outsideRealWork = !realPathFromRoot.startsWith(`.x-matt/work${sep}`);

      if (outsideRealRoot || outsideRealWork) {
        result.errors.push("Ticket path must be under .x-matt/work");
      } else {
        const content = await readFile(realTarget, "utf8");
        const type = metadata(content, "Type");
        const parent = metadata(content, "Parent");
        const status = metadata(content, "Status");
        const blockedBy = metadata(content, "Blocked by");

        if (type !== "ticket") result.errors.push("Type must be ticket");
        if (!parent) result.errors.push("Parent is required");
        if (parent && parent !== "None") {
          if (isAbsolute(parent)) {
            result.errors.push(
              "Parent must be None or a repository-relative path under active .x-matt/work",
            );
          } else {
            const parentTarget = resolve(root, parent);
            const parentPathFromRoot = relative(root, parentTarget);
            if (isShippedPath(parentPathFromRoot)) {
              result.errors.push(
                "Parent under .x-matt/work/shipped is archived and cannot authorize implementation",
              );
            }
          }
        }
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
            const outsideBlockerWork = !blockerPathFromRoot.startsWith(`.x-matt/work${sep}`);

            if (
              blockerReference === "" ||
              isAbsolute(blockerReference) ||
              outsideBlockerRoot ||
              outsideBlockerWork
            ) {
              result.errors.push(
                `Blocker ${JSON.stringify(blockerReference)} must be a repository-relative path under .x-matt/work`,
              );
              continue;
            }
            if (isShippedPath(blockerPathFromRoot)) {
              result.errors.push(
                `Blocker ${JSON.stringify(blockerReference)} is archived under .x-matt/work/shipped and cannot unlock an active ticket`,
              );
              continue;
            }

            try {
              const realBlockerTarget = await realpath(blockerTarget);
              const realBlockerPathFromRoot = relative(realRoot, realBlockerTarget);
              const outsideRealBlockerRoot =
                realBlockerPathFromRoot === ".." ||
                realBlockerPathFromRoot.startsWith(`..${sep}`);
              const outsideRealBlockerWork = !realBlockerPathFromRoot.startsWith(
                `.x-matt/work${sep}`,
              );

              if (outsideRealBlockerRoot || outsideRealBlockerWork) {
                result.errors.push(
                  `Blocker ${JSON.stringify(blockerReference)} must be a repository-relative path under .x-matt/work`,
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
