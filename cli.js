#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { buildTopology } from "./src/topology.js";

function usage() {
  console.error("用法: node cli.js <spans.jsonl> --start <ms> --end <ms>");
  process.exit(2);
}

const args = process.argv.slice(2);
const file = args[0];
const startIdx = args.indexOf("--start");
const endIdx = args.indexOf("--end");
if (!file || startIdx === -1 || endIdx === -1) usage();

const windowStart = Number(args[startIdx + 1]);
const windowEnd = Number(args[endIdx + 1]);
const jsonl = readFileSync(file, "utf8");
const result = buildTopology(jsonl, { windowStart, windowEnd });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
