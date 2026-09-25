#!/usr/bin/env node
// Generates YOUR OWN extension signing key pair so your build has a stable extension ID.
//   .keys/extension.pem      PRIVATE key (PKCS#8). Keep it secret; store it in your secret manager.
//   .keys/extension.pub.b64  PUBLIC key (base64 SPKI) = the manifest `key`, injected by vite at build.
// Prints the resulting extension ID. `.keys/` is gitignored. Refuses to overwrite an existing key.
import { generateKeyPairSync, createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const dir = ".keys";
if (existsSync(`${dir}/extension.pem`)) {
  console.error(`${dir}/extension.pem already exists — refusing to overwrite (your extension ID depends on it).`);
  process.exit(1);
}
mkdirSync(dir, { recursive: true, mode: 0o700 });
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const der = publicKey.export({ type: "spki", format: "der" });
writeFileSync(`${dir}/extension.pem`, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
writeFileSync(`${dir}/extension.pub.b64`, der.toString("base64") + "\n", { mode: 0o644 });
const id = [...createHash("sha256").update(der).digest("hex").slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
console.log(`Wrote ${dir}/extension.pem (private, 0600) and ${dir}/extension.pub.b64 (public).`);
console.log(`Extension ID: ${id}`);
console.log(`Rebuild (npm run build) and install the host manifest with BUE_EXTENSION_ID=${id}.`);
