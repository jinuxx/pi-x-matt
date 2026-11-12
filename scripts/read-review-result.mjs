#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { reviewResultFrame } from "../lib/review-workflow.mjs";

// Both arguments are fixed by the extension's exact host-command grant.
const [path, index] = process.argv.slice(2);
const result = JSON.parse(await readFile(path, "utf8"));
console.log(JSON.stringify(reviewResultFrame(result, Number(index))));
