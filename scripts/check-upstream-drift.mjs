#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UPSTREAM_ROOT = join(ROOT, "vendor", "mattpocock-skills");
const registry = JSON.parse(await readFile(join(ROOT, "config", "skill-registry.json"), "utf8"));
const pinnedSha = (await readFile(join(ROOT, "vendor", "UPSTREAM_SHA"), "utf8")).trim();
const changed = [];

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

for (const skill of Object.values(registry.skills)) {
  const upstreamFile = resolve(UPSTREAM_ROOT, skill.upstreamPath);
  const upstreamRelative = relative(UPSTREAM_ROOT, upstreamFile);
  const escaped = !upstreamRelative || upstreamRelative === ".." || upstreamRelative.startsWith(`..${sep}`);
  const content = escaped ? null : await readFile(upstreamFile, "utf8").catch(() => null);
  if (escaped || content === null || sha256(content) !== skill.upstreamDigest || skill.upstreamSha !== pinnedSha) {
    changed.push({
      name: skill.name,
      path: skill.upstreamPath,
      reason: escaped
        ? "upstream path escaped vendor root"
        : content === null
          ? "upstream source missing"
          : skill.upstreamSha !== pinnedSha
            ? "vendor SHA changed"
            : "upstream source content changed",
    });
  }
}

if (changed.length > 0) {
  console.error("Pi-native ports requiring review:");
  for (const item of changed) console.error(`- ${item.name}: ${item.reason} (${item.path})`);
  process.exitCode = 1;
} else {
  console.log(`no upstream drift for ${Object.keys(registry.skills).length} ported skills at ${pinnedSha}`);
}
