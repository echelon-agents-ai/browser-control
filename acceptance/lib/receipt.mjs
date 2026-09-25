// Receipt writer shared by every acceptance scenario.
//
// Convention: acceptance/out/<ts>/ holds one run's artifacts —
//   <ts>/<scenario>.json         the structured receipt (steps, asserts, MEASURED vs INFERRED)
//   <ts>/<scenario>-NN-*.png     screenshots in capture order
// <ts> is an ISO-ish sortable stamp (UTC), unique per run.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const OUT_ROOT = join(HERE, "..", "out");

export function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export class Receipt {
  constructor(scenario) {
    this.scenario = scenario;
    this.ts = stamp();
    this.dir = join(OUT_ROOT, this.ts);
    mkdirSync(this.dir, { recursive: true });
    this.shotIdx = 0;
    this.data = {
      scenario,
      ts: this.ts,
      startedAt: new Date().toISOString(),
      env: {
        BUE_MCP_URL: process.env.BUE_MCP_URL ? "(set)" : "(unset)",
        BUE_BEARER: process.env.BUE_BEARER ? "(set)" : "(unset)",
        BUE_RUN_REAL: process.env.BUE_RUN_REAL ?? "(unset)",
      },
      steps: [],       // ordered log of what happened
      asserts: [],     // { name, pass, measured }
      screenshots: [], // filenames in order
      status: "incomplete",
    };
  }

  step(msg, extra) {
    this.data.steps.push({ at: new Date().toISOString(), msg, ...(extra ? { extra } : {}) });
    console.log(`  · ${msg}`);
  }

  /** Persists a base64 image block returned by `computer screenshot`. */
  saveShot(image, tag) {
    this.shotIdx += 1;
    const ext = image.mimeType === "image/png" ? "png" : "jpg";
    const name = `${this.scenario}-${String(this.shotIdx).padStart(2, "0")}-${tag}.${ext}`;
    writeFileSync(join(this.dir, name), Buffer.from(image.data, "base64"));
    this.data.screenshots.push(name);
    this.step(`screenshot -> ${name}`);
    return name;
  }

  /** Records an assertion. `measured` is the raw value we observed (kept for MEASURED vs INFERRED). */
  assert(name, pass, measured) {
    this.data.asserts.push({ name, pass: !!pass, measured });
    this.step(`assert ${name}: ${pass ? "PASS" : "FAIL"}`, measured);
    return pass;
  }

  finish(status, error) {
    this.data.status = status;
    this.data.finishedAt = new Date().toISOString();
    if (error) this.data.error = String(error?.stack || error);
    const file = join(this.dir, `${this.scenario}.json`);
    writeFileSync(file, JSON.stringify(this.data, null, 2));
    console.log(`  receipt -> ${file}`);
    return file;
  }
}
