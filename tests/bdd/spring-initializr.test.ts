import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  isPrereleaseBootVersion,
  isLtsJavaVersion,
  resolveLatestBootVersion,
  resolveLatestLtsJavaVersion,
  deploySpringStarter,
  SpringInitializrClient,
  InitializrNetworkError,
} from "../../scripts/lakebase/spring-initializr.js";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    if (dir) try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  }
});
function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lbscm-spring-"));
  tmpDirs.push(dir);
  return dir;
}

describe("isPrereleaseBootVersion", () => {
  it("rejects SNAPSHOT, RC, M, alpha, beta", () => {
    expect(isPrereleaseBootVersion("3.5.0-SNAPSHOT")).toBe(true);
    expect(isPrereleaseBootVersion("3.5.0-RC1")).toBe(true);
    expect(isPrereleaseBootVersion("3.5.0-M2")).toBe(true);
    expect(isPrereleaseBootVersion("3.5.0-alpha1")).toBe(true);
    expect(isPrereleaseBootVersion("3.5.0-beta3")).toBe(true);
  });
  it("accepts GA versions", () => {
    expect(isPrereleaseBootVersion("3.5.0")).toBe(false);
    expect(isPrereleaseBootVersion("3.4.1")).toBe(false);
  });
});

describe("isLtsJavaVersion", () => {
  it("accepts 8, 11, and 17/21/25 (every 4th from 17)", () => {
    for (const v of ["8", "11", "17", "21", "25", "29"]) expect(isLtsJavaVersion(v)).toBe(true);
  });
  it("rejects non-LTS", () => {
    for (const v of ["12", "16", "18", "22", "24"]) expect(isLtsJavaVersion(v)).toBe(false);
  });
  it("rejects garbage", () => {
    expect(isLtsJavaVersion("xyz")).toBe(false);
  });
});

describe("resolveLatestBootVersion", () => {
  it("picks the first non-prerelease id from values", () => {
    const section = {
      default: "3.5.0",
      values: [
        { id: "4.0.0-SNAPSHOT" },
        { id: "4.0.0-M2" },
        { id: "3.5.1" },
        { id: "3.4.0" },
      ],
    };
    expect(resolveLatestBootVersion(section)).toBe("3.5.1");
  });
  it("falls back to default if no GA in values", () => {
    const section = { default: "3.5.0", values: [{ id: "4.0.0-SNAPSHOT" }] };
    expect(resolveLatestBootVersion(section)).toBe("3.5.0");
  });
});

describe("resolveLatestLtsJavaVersion", () => {
  it("picks the newest LTS from values + default", () => {
    const section = { default: "17", values: [{ id: "17" }, { id: "21" }, { id: "22" }] };
    expect(resolveLatestLtsJavaVersion(section)).toBe("21");
  });
});

describe("SpringInitializrClient with injected fetch", () => {
  it("getMetadata throws InitializrNetworkError on fetch reject", async () => {
    const client = new SpringInitializrClient("https://nope.example", async () => {
      throw new TypeError("simulated network failure");
    });
    await expect(client.getMetadata()).rejects.toBeInstanceOf(InitializrNetworkError);
  });

  it("getMetadata parses a minimal v2.3+json response", async () => {
    const client = new SpringInitializrClient("https://stub.example", async () => {
      return new Response(
        JSON.stringify({
          bootVersion: { default: "3.5.0", values: [{ id: "3.5.0" }] },
          javaVersion: { default: "21", values: [{ id: "21" }, { id: "17" }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    const md = await client.getMetadata();
    expect(md).toEqual({ bootVersion: "3.5.0", javaVersion: "21" });
  });
});

describe("deploySpringStarter (LAKEBASE_SCAFFOLD_FALLBACK=1)", () => {
  // Save/restore env around each test so we don't leak.
  const originalFlag = process.env.LAKEBASE_SCAFFOLD_FALLBACK;
  beforeEach(() => { process.env.LAKEBASE_SCAFFOLD_FALLBACK = "1"; });
  afterEach(() => {
    if (originalFlag === undefined) delete process.env.LAKEBASE_SCAFFOLD_FALLBACK;
    else process.env.LAKEBASE_SCAFFOLD_FALLBACK = originalFlag;
  });

  it("uses bundled Java fallback (pom.xml + mvnw) when flag is set", async () => {
    const dir = mkTmp();
    await deploySpringStarter({ targetDir: dir, language: "java", projectName: "test-app" });
    expect(fs.existsSync(path.join(dir, "pom.xml"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "mvnw"))).toBe(true);
    // Spring overlay applied — application.properties from templates/spring/
    expect(fs.existsSync(path.join(dir, "src", "main", "resources", "application.properties"))).toBe(true);
    // mvnw executable
    const stat = fs.statSync(path.join(dir, "mvnw"));
    expect(stat.mode & 0o100).not.toBe(0);
  });

  it("uses bundled Kotlin fallback", async () => {
    const dir = mkTmp();
    await deploySpringStarter({ targetDir: dir, language: "kotlin", projectName: "test-app" });
    expect(fs.existsSync(path.join(dir, "pom.xml"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "mvnw"))).toBe(true);
  });
});

describe("deploySpringStarter — live (skip-when-network-disabled)", () => {
  // Set LAKEBASE_TEST_INITIALIZR=1 to exercise the live start.spring.io path.
  // We skip by default to keep CI hermetic; the bundled fallback covers the
  // same code paths post-extraction.
  const liveOk = process.env.LAKEBASE_TEST_INITIALIZR === "1";
  it.skipIf(!liveOk)("fetches a Java starter from start.spring.io", async () => {
    delete process.env.LAKEBASE_SCAFFOLD_FALLBACK;
    const dir = mkTmp();
    await deploySpringStarter({ targetDir: dir, language: "java", projectName: "test-app" });
    expect(fs.existsSync(path.join(dir, "pom.xml"))).toBe(true);
    const pom = fs.readFileSync(path.join(dir, "pom.xml"), "utf-8");
    // Post-patch should include flyway-database-postgresql
    expect(pom).toMatch(/flyway-database-postgresql/);
  });

  it("documents the skip reason when not enabled", () => {
    if (liveOk) return;
    // eslint-disable-next-line no-console
    console.log("LAKEBASE_TEST_INITIALIZR not set — live Initializr fetch skipped.");
    expect(liveOk).toBe(false);
  });
});
