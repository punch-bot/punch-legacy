import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const LEGACY_EXTENSIONS = [
  "routines", "collab", "browser", "webfetch", "report_progress", "compress_context", "mcp",
];

export function archiveLegacyExtensions(workDir = "/work") {
  const extensionDir = join(workDir, ".pi", "extensions");
  const archiveDir = join(extensionDir, ".legacy-pi");
  const archived = [];
  for (const name of LEGACY_EXTENSIONS) {
    const source = join(extensionDir, `${name}.ts`);
    if (!existsSync(source)) continue;
    mkdirSync(archiveDir, { recursive: true });
    let destination = join(archiveDir, `${name}.ts`);
    for (let suffix = 1; existsSync(destination); suffix += 1) {
      destination = join(archiveDir, `${name}.${suffix}.ts`);
    }
    renameSync(source, destination);
    archived.push(destination);
  }
  return archived;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const archived = archiveLegacyExtensions();
  if (archived.length) console.log(`[pi] Archived ${archived.length} legacy extensions in /work/.pi/extensions/.legacy-pi`);
}
