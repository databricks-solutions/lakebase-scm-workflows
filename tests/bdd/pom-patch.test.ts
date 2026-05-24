import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { patchPomForLakebase } from "../../scripts/util/pom-patch.js";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    if (dir) try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  }
});

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lbscm-pom-"));
  tmpDirs.push(dir);
  return dir;
}

const SAMPLE_POM_WITH_SPRING = `<?xml version="1.0"?>
<project>
    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
        </dependency>
    </dependencies>
    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
            </plugin>
        </plugins>
    </build>
</project>
`;

describe("patchPomForLakebase", () => {
  it("throws when pom.xml does not exist", () => {
    const dir = mkTmp();
    expect(() => patchPomForLakebase(path.join(dir, "missing.xml"))).toThrow(/pom\.xml not found/);
  });

  it("adds flyway-database-postgresql + flyway-maven-plugin + surefire when missing", () => {
    const dir = mkTmp();
    const pomPath = path.join(dir, "pom.xml");
    fs.writeFileSync(pomPath, SAMPLE_POM_WITH_SPRING);
    patchPomForLakebase(pomPath);
    const patched = fs.readFileSync(pomPath, "utf-8");
    expect(patched).toMatch(/flyway-database-postgresql/);
    expect(patched).toMatch(/flyway-maven-plugin/);
    expect(patched).toMatch(/maven-surefire-plugin/);
    expect(patched).toMatch(/EnableDynamicAgentLoading/);
  });

  it("is idempotent, running twice produces the same content", () => {
    const dir = mkTmp();
    const pomPath = path.join(dir, "pom.xml");
    fs.writeFileSync(pomPath, SAMPLE_POM_WITH_SPRING);
    patchPomForLakebase(pomPath);
    const once = fs.readFileSync(pomPath, "utf-8");
    patchPomForLakebase(pomPath);
    const twice = fs.readFileSync(pomPath, "utf-8");
    expect(twice).toBe(once);
  });
});
