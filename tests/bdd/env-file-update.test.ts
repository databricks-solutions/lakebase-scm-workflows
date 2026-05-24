import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { updateEnvConnection } from "../../scripts/lakebase/env-file.js";

function tmpEnvPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lbscm-envtest-"));
  return path.join(dir, ".env");
}

describe("updateEnvConnection", () => {
  let envPath: string;

  beforeEach(() => {
    envPath = tmpEnvPath();
  });

  it("creates a new .env with just the connection block when none exists", () => {
    updateEnvConnection({
      envPath,
      branchId: "feature-x",
      databaseUrl: "postgresql://u:p@h:5432/db?sslmode=require",
      username: "user@example.com",
      password: "tok",
    });
    const content = fs.readFileSync(envPath, "utf-8");
    expect(content).toMatch(/^LAKEBASE_BRANCH_ID=feature-x$/m);
    expect(content).toMatch(/^DATABASE_URL=postgresql:/m);
    expect(content).toMatch(/^DB_USERNAME=user@example\.com$/m);
    expect(content).toMatch(/^DB_PASSWORD=tok$/m);
  });

  it("preserves non-connection lines and overwrites stale connection block", () => {
    fs.writeFileSync(
      envPath,
      [
        "# header",
        "DATABRICKS_HOST=https://example.databricks.com",
        "LAKEBASE_PROJECT_ID=proj-abc",
        "LAKEBASE_BRANCH_ID=old-branch",
        "DATABASE_URL=postgresql://old",
        "DB_USERNAME=old@example.com",
        "DB_PASSWORD=oldtok",
        "OTHER_VAR=keep-me",
        "",
      ].join("\n")
    );
    updateEnvConnection({
      envPath,
      branchId: "new-branch",
      databaseUrl: "postgresql://new",
      username: "new@example.com",
      password: "newtok",
    });
    const content = fs.readFileSync(envPath, "utf-8");
    expect(content).toContain("DATABRICKS_HOST=https://example.databricks.com");
    expect(content).toContain("LAKEBASE_PROJECT_ID=proj-abc");
    expect(content).toContain("OTHER_VAR=keep-me");
    expect(content).toContain("LAKEBASE_BRANCH_ID=new-branch");
    expect(content).toContain("DATABASE_URL=postgresql://new");
    expect(content).not.toContain("old-branch");
    expect(content).not.toContain("oldtok");
  });

  it("appends the connection block exactly once (idempotent on repeated calls)", () => {
    fs.writeFileSync(envPath, "DATABRICKS_HOST=h\n");
    updateEnvConnection({ envPath, branchId: "b", databaseUrl: "u1", username: "a", password: "p" });
    updateEnvConnection({ envPath, branchId: "b", databaseUrl: "u2", username: "a", password: "p" });
    const content = fs.readFileSync(envPath, "utf-8");
    const occurrences = (content.match(/^LAKEBASE_BRANCH_ID=/gm) || []).length;
    expect(occurrences).toBe(1);
    expect(content).toContain("DATABASE_URL=u2");
    expect(content).not.toContain("DATABASE_URL=u1");
  });

  it("honors an empty DATABASE_URL for pending-connection placeholder", () => {
    updateEnvConnection({
      envPath,
      branchId: "feature-y",
      databaseUrl: "",
      username: "",
      password: "",
      comment: "# Connection pending, branch still provisioning",
    });
    const content = fs.readFileSync(envPath, "utf-8");
    expect(content).toContain("# Connection pending");
    expect(content).toMatch(/^DATABASE_URL=$/m);
  });
});
