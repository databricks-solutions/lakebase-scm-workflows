import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import AdmZip from "adm-zip";
import { extractZipToDir } from "../../scripts/util/zip-extract.js";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    if (dir) try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  }
});

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lbscm-zip-"));
  tmpDirs.push(dir);
  return dir;
}

describe("extractZipToDir", () => {
  it("extracts a flat zip into targetDir", () => {
    const zip = new AdmZip();
    zip.addFile("README.md", Buffer.from("# Hello\n"));
    zip.addFile("src/index.ts", Buffer.from('export const a = 1;\n'));
    const buf = zip.toBuffer();

    const dir = mkTmp();
    extractZipToDir(buf, dir);
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf-8")).toMatch(/Hello/);
    expect(fs.readFileSync(path.join(dir, "src", "index.ts"), "utf-8")).toMatch(/export const a/);
  });

  it("hoists a single top-level dir into targetDir (Initializr convention)", () => {
    const zip = new AdmZip();
    zip.addFile("demo/pom.xml", Buffer.from("<project/>"));
    zip.addFile("demo/src/main/java/App.java", Buffer.from("class App {}"));
    const buf = zip.toBuffer();

    const dir = mkTmp();
    extractZipToDir(buf, dir);
    // No "demo/" prefix – contents were hoisted.
    expect(fs.existsSync(path.join(dir, "pom.xml"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "src", "main", "java", "App.java"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "demo"))).toBe(false);
  });

  it("ignores __MACOSX metadata when deciding whether to hoist", () => {
    const zip = new AdmZip();
    zip.addFile("demo/pom.xml", Buffer.from("<project/>"));
    zip.addFile("__MACOSX/demo/._pom.xml", Buffer.from("ignore me"));
    const buf = zip.toBuffer();

    const dir = mkTmp();
    extractZipToDir(buf, dir);
    expect(fs.existsSync(path.join(dir, "pom.xml"))).toBe(true);
  });

  it("cleans up its temp extraction dir", () => {
    const zip = new AdmZip();
    zip.addFile("file.txt", Buffer.from("x"));
    const buf = zip.toBuffer();
    const dir = mkTmp();
    extractZipToDir(buf, dir);
    const leftover = fs.readdirSync(dir).filter((e) => e.startsWith(".initializr-extract-"));
    expect(leftover).toEqual([]);
  });
});
