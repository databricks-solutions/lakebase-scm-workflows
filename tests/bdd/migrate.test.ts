// Unit BDD tests for the migrate primitives (FEIP-7091).
//
// These tests cover the dispatch logic and the file-scan implementation
// of listMigrations() for all three languages, using temp project
// directories. The applyMigrations / rollbackMigration / migrationStatus
// primitives are exercised end-to-end against a real Lakebase branch in
// migrate-live.test.ts (gated on LAKEBASE_TEST_E2E=1).
//
// No DB connection here; this suite must run cleanly in any environment.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  detectLanguage,
  listMigrations,
  toolForLanguage,
  MigrationError,
} from "../../scripts/lakebase/migrate.js";

function mkTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "migrate-bdd-"));
}

function rm(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("toolForLanguage", () => {
  it("maps java and kotlin to flyway", () => {
    expect(toolForLanguage("java")).toBe("flyway");
    expect(toolForLanguage("kotlin")).toBe("flyway");
  });

  it("maps python to alembic", () => {
    expect(toolForLanguage("python")).toBe("alembic");
  });

  it("maps nodejs to knex", () => {
    expect(toolForLanguage("nodejs")).toBe("knex");
  });
});

describe("detectLanguage", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkTempDir();
  });
  afterEach(() => {
    rm(dir);
  });

  it("detects java from pom.xml", () => {
    fs.writeFileSync(path.join(dir, "pom.xml"), "<project/>");
    expect(detectLanguage(dir)).toBe("java");
  });

  it("detects python from pyproject.toml", () => {
    fs.writeFileSync(path.join(dir, "pyproject.toml"), "");
    expect(detectLanguage(dir)).toBe("python");
  });

  it("detects python from requirements.txt", () => {
    fs.writeFileSync(path.join(dir, "requirements.txt"), "");
    expect(detectLanguage(dir)).toBe("python");
  });

  it("detects python from alembic.ini", () => {
    fs.writeFileSync(path.join(dir, "alembic.ini"), "");
    expect(detectLanguage(dir)).toBe("python");
  });

  it("detects nodejs from package.json", () => {
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    expect(detectLanguage(dir)).toBe("nodejs");
  });

  it("prefers pom.xml over package.json when both present (java pairing)", () => {
    fs.writeFileSync(path.join(dir, "pom.xml"), "<project/>");
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    expect(detectLanguage(dir)).toBe("java");
  });

  it("throws when no marker found", () => {
    expect(() => detectLanguage(dir)).toThrow(MigrationError);
    expect(() => detectLanguage(dir)).toThrow(/Could not detect project language/);
  });
});

describe("listMigrations: flyway (java)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkTempDir();
    fs.writeFileSync(path.join(dir, "pom.xml"), "<project/>");
    const migrations = path.join(dir, "src", "main", "resources", "db", "migration");
    fs.mkdirSync(migrations, { recursive: true });
    fs.writeFileSync(path.join(migrations, "V1__init.sql"), "CREATE TABLE x();");
    fs.writeFileSync(path.join(migrations, "V2__add_y.sql"), "ALTER TABLE x ADD y INT;");
    fs.writeFileSync(path.join(migrations, "V10__add_z.sql"), "ALTER TABLE x ADD z INT;");
    // Garbage file ignored by the regex:
    fs.writeFileSync(path.join(migrations, "notes.txt"), "ignored");
  });
  afterEach(() => {
    rm(dir);
  });

  it("enumerates V*.sql files and sorts numerically (V10 after V2)", () => {
    const files = listMigrations({ projectDir: dir });
    expect(files.map((f) => f.version)).toEqual(["1", "2", "10"]);
    expect(files.every((f) => f.tool === "flyway")).toBe(true);
    expect(files.every((f) => f.type === "SQL")).toBe(true);
  });

  it("description is the slug with underscores replaced by spaces", () => {
    const files = listMigrations({ projectDir: dir });
    expect(files[0].description).toBe("init");
    expect(files[1].description).toBe("add y");
    expect(files[2].description).toBe("add z");
  });

  it("returns empty when the migration dir is missing", () => {
    rm(path.join(dir, "src", "main", "resources", "db", "migration"));
    expect(listMigrations({ projectDir: dir })).toEqual([]);
  });
});

describe("listMigrations: alembic (python)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkTempDir();
    fs.writeFileSync(path.join(dir, "alembic.ini"), "");
    const versions = path.join(dir, "migrations", "versions");
    fs.mkdirSync(versions, { recursive: true });
    fs.writeFileSync(path.join(versions, "ae103abc_init.py"), "");
    fs.writeFileSync(path.join(versions, "bf204def_add_users.py"), "");
    fs.writeFileSync(path.join(versions, "__init__.py"), "");
  });
  afterEach(() => {
    rm(dir);
  });

  it("enumerates *.py files in migrations/versions/, skips __init__", () => {
    const files = listMigrations({ projectDir: dir });
    expect(files.map((f) => f.filename).sort()).toEqual([
      "ae103abc_init.py",
      "bf204def_add_users.py",
    ]);
    expect(files.every((f) => f.tool === "alembic")).toBe(true);
    expect(files.every((f) => f.type === "Python")).toBe(true);
  });

  it("parses version (revid before underscore) and description", () => {
    const files = listMigrations({ projectDir: dir }).sort((a, b) =>
      a.filename.localeCompare(b.filename)
    );
    expect(files[0].version).toBe("ae103abc");
    expect(files[0].description).toBe("init");
    expect(files[1].version).toBe("bf204def");
    expect(files[1].description).toBe("add users");
  });

  it("also finds alembic/versions/ as alternative layout", () => {
    rm(path.join(dir, "migrations"));
    const versions = path.join(dir, "alembic", "versions");
    fs.mkdirSync(versions, { recursive: true });
    fs.writeFileSync(path.join(versions, "cc305ghi_alt.py"), "");
    const files = listMigrations({ projectDir: dir });
    expect(files).toHaveLength(1);
    expect(files[0].filename).toBe("cc305ghi_alt.py");
  });
});

describe("listMigrations: knex (nodejs)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkTempDir();
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    const migrations = path.join(dir, "migrations");
    fs.mkdirSync(migrations, { recursive: true });
    fs.writeFileSync(path.join(migrations, "20260101120000_init.js"), "");
    fs.writeFileSync(path.join(migrations, "20260102140000_add_users.ts"), "");
    fs.writeFileSync(path.join(migrations, ".gitkeep"), "");
  });
  afterEach(() => {
    rm(dir);
  });

  it("enumerates timestamped *.js and *.ts files, sorts by timestamp", () => {
    const files = listMigrations({ projectDir: dir });
    expect(files.map((f) => f.filename)).toEqual([
      "20260101120000_init.js",
      "20260102140000_add_users.ts",
    ]);
    expect(files[0].version).toBe("20260101120000");
    expect(files[0].type).toBe("JavaScript");
    expect(files[1].version).toBe("20260102140000");
    expect(files[1].type).toBe("TypeScript");
    expect(files.every((f) => f.tool === "knex")).toBe(true);
  });

  it("parses description from name slug", () => {
    const files = listMigrations({ projectDir: dir });
    expect(files[0].description).toBe("init");
    expect(files[1].description).toBe("add users");
  });
});

describe("listMigrations: language override", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkTempDir();
    // No detection markers — language must be passed explicitly.
    const migrations = path.join(dir, "migrations", "versions");
    fs.mkdirSync(migrations, { recursive: true });
    fs.writeFileSync(path.join(migrations, "aa111_init.py"), "");
  });
  afterEach(() => {
    rm(dir);
  });

  it("honors explicit language argument when detection would fail", () => {
    expect(() => listMigrations({ projectDir: dir })).toThrow(MigrationError);
    const files = listMigrations({ projectDir: dir, language: "python" });
    expect(files).toHaveLength(1);
    expect(files[0].tool).toBe("alembic");
  });
});

describe("flyway rollback + knex apply/rollback/status: error paths", () => {
  // Flyway: apply + status are implemented (live test covers them).
  // Rollback intentionally throws because Flyway Community Edition has
  // no `undo`. Knex primitives are stubs pending FEIP-7099.

  it("flyway rollback throws with the Flyway Community caveat", async () => {
    const dir = mkTempDir();
    try {
      const { rollbackFlyway } = await import("../../scripts/lakebase/migrate-runners/flyway.js");
      await expect(
        rollbackFlyway({ projectDir: dir, dsn: "x", target: "-1" })
      ).rejects.toThrow(/Flyway Community Edition does not support/);
    } finally {
      rm(dir);
    }
  });

  it("knex apply throws MigrationError with FEIP-7099 pointer", async () => {
    const dir = mkTempDir();
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    try {
      const { applyKnex } = await import("../../scripts/lakebase/migrate-runners/knex.js");
      await expect(applyKnex({ projectDir: dir, dsn: "x" })).rejects.toThrow(/FEIP-7099/);
    } finally {
      rm(dir);
    }
  });
});
