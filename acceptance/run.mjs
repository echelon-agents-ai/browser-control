#!/usr/bin/env node
// Acceptance runner for the Browser Control scenarios.
//
//   node acceptance/run.mjs                 # list scenarios
//   BUE_RUN_REAL=1 \
//   BUE_MCP_URL=http://127.0.0.1:8730/mcp BUE_BEARER=... \
//     node acceptance/run.mjs concurrent-tabs
//
// HARD GATE: nothing touches a live browser unless BUE_RUN_REAL=1. Without it the runner prints the
// plan and exits 0, so it is safe in CI.

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCENARIO_DIR = join(HERE, "scenarios");

const scenarios = readdirSync(SCENARIO_DIR)
  .filter((f) => f.endsWith(".mjs"))
  .map((f) => f.replace(/\.mjs$/, ""))
  .sort();

// --local: run ONLY fixture/local-daemon scenarios against the stack from .local/up.sh, without
// BUE_RUN_REAL (which stays reserved for real third-party sites). Env comes from .local/state/env
// when BUE_MCP_URL is not already set.
const LOCAL_SAFE = ["concurrent-tabs", "silent-drop", "slack-icon-upload"];
const argv = process.argv.slice(2);
const local = argv.includes("--local");
const wanted = argv.filter((a) => a !== "--local");
if (local) {
  if (process.env.BUE_RUN_REAL === "1") { console.error("--local refuses to run with BUE_RUN_REAL=1"); process.exit(2); }
  if (!process.env.BUE_MCP_URL) {
    const { readFileSync, existsSync } = await import("node:fs");
    const envFile = join(HERE, ".local", "state", "env");
    if (!existsSync(envFile)) { console.error(`no ${envFile} — run acceptance/.local/up.sh first`); process.exit(2); }
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const m = /^export ([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) process.env[m[1]] = m[2].replace(/^'(.*)'$/, "$1");
    }
  }
}

if (wanted.length === 0) {
  console.log("BUE acceptance scenarios:");
  for (const s of scenarios) console.log(`  - ${s}`);
  console.log("\nRun one:  BUE_RUN_REAL=1 BUE_MCP_URL=... BUE_BEARER=... node acceptance/run.mjs concurrent-tabs  (or: node acceptance/run.mjs --local all)");
  process.exit(0);
}

const toRun = wanted.includes("all") ? (local ? LOCAL_SAFE : scenarios) : wanted;
for (const name of toRun) {
  if (!scenarios.includes(name)) {
    console.error(`unknown scenario '${name}'. known: ${scenarios.join(", ")}`);
    process.exit(2);
  }
}

if (local) {
  const bad = toRun.filter((n) => !LOCAL_SAFE.includes(n));
  if (bad.length) { console.error(`--local only runs ${LOCAL_SAFE.join(", ")}; refused: ${bad.join(", ")}`); process.exit(2); }
} else if (process.env.BUE_RUN_REAL !== "1") {
  console.log("BUE_RUN_REAL is not 1 — dry run. Would run:");
  for (const n of toRun) console.log(`  - ${n}`);
  console.log("Set BUE_RUN_REAL=1 (and BUE_MCP_URL/BUE_BEARER) to run for real.");
  process.exit(0);
}

let failures = 0;
for (const name of toRun) {
  console.log(`\n=== ${name} ===`);
  try {
    const mod = await import(pathToFileURL(join(SCENARIO_DIR, `${name}.mjs`)).href);
    const data = await mod.run();
    console.log(`  status: ${data?.status}`);
    if (data?.status === "fail" || data?.status === "error") failures += 1;
  } catch (err) {
    failures += 1;
    console.error(`  ${name} threw: ${err?.message ?? err}`);
  }
}
process.exit(failures > 0 ? 1 : 0);
