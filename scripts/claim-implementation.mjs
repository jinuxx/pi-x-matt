#!/usr/bin/env node
import { writeFile } from "node:fs/promises";

// Exact command/path granted by the dispatcher, never free-form model input.
// A replay (including upstream autoResume) must stop before launching a writer.
const [path] = process.argv.slice(2);
if (!path) throw new Error("Usage: claim-implementation.mjs <dispatch.claim>");
await writeFile(path, JSON.stringify({ version: 1, claimedAt: Date.now() }), { mode: 0o400, flag: "wx" });
console.log(JSON.stringify({ claimed: true }));
