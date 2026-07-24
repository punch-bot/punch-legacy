#!/usr/bin/env node
// Emit a trimmed opencode auth.json containing ONLY the free `opencode` provider
// (used by big-pickle). This is what gets mounted into the sandbox container, so
// even a friend with root shell there can only read the free key — not your
// Anthropic/other keys.
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const KEEP = (process.env.KEEP_PROVIDERS || "opencode").split(",").map((s) => s.trim());
const src = process.env.SRC_AUTH || join(homedir(), ".local/share/opencode/auth.json");
const out = process.env.OUT_AUTH || join(process.cwd(), "secrets/auth.min.json");

let auth;
try {
  auth = JSON.parse(readFileSync(src, "utf8"));
} catch (e) {
  console.error(`Cannot read ${src}: ${e.message}`);
  process.exit(1);
}

const trimmed = {};
for (const k of KEEP) {
  if (auth[k]) trimmed[k] = auth[k];
  else console.warn(`warning: provider "${k}" not found in ${src}`);
}
if (!Object.keys(trimmed).length) {
  console.error("Refusing to write empty auth. Check KEEP_PROVIDERS.");
  process.exit(1);
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(trimmed, null, 2));
chmodSync(out, 0o600);
console.log(`Wrote ${out} with providers: ${Object.keys(trimmed).join(", ")}`);
