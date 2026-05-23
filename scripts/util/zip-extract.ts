// Extract a zip buffer into targetDir. If the archive has a single top-level
// directory (Spring Initializr convention), hoist its contents into
// targetDir. Ported from src/utils/zipExtract.ts.

import * as fs from "node:fs";
import * as path from "node:path";
import AdmZip from "adm-zip";

export function extractZipToDir(zipBuffer: Buffer, targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true });

  const zip = new AdmZip(zipBuffer);
  const tempDir = path.join(targetDir, `.initializr-extract-${Date.now()}`);
  zip.extractAllTo(tempDir, true);

  const entries = fs.readdirSync(tempDir).filter((e) => e !== "__MACOSX");
  const sourceDir =
    entries.length === 1 && fs.statSync(path.join(tempDir, entries[0])).isDirectory()
      ? path.join(tempDir, entries[0])
      : tempDir;

  copyDirRecursive(sourceDir, targetDir);
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    const srcPath = path.join(src, entry);
    const destPath = path.join(dest, entry);
    if (fs.statSync(srcPath).isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
