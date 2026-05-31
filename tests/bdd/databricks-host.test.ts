import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
  parseHostFromAuthDescribe,
  resolveDatabricksHost,
} from "../../scripts/lakebase/databricks-host";

function hasCli(): boolean {
  try {
    execFileSync("databricks", ["--version"], { stdio: "ignore", timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

const CLI_AVAILABLE = hasCli();
const PROFILE = process.env.LAKEBASE_TEST_PROFILE;
const RUN_LIVE = CLI_AVAILABLE && !!PROFILE;

describe("parseHostFromAuthDescribe: pure parser", () => {
  it("extracts host from a clean JSON payload", () => {
    const input = JSON.stringify({
      details: { host: "https://example.cloud.databricks.com" },
    });
    expect(parseHostFromAuthDescribe(input)).toBe("https://example.cloud.databricks.com");
  });

  it("strips a trailing slash", () => {
    const input = JSON.stringify({
      details: { host: "https://example.cloud.databricks.com/" },
    });
    expect(parseHostFromAuthDescribe(input)).toBe("https://example.cloud.databricks.com");
  });

  it("strips multiple trailing slashes", () => {
    const input = JSON.stringify({
      details: { host: "https://example.cloud.databricks.com///" },
    });
    expect(parseHostFromAuthDescribe(input)).toBe("https://example.cloud.databricks.com");
  });

  it("tolerates non-JSON preamble before the payload", () => {
    // CLI builds may prefix a warning or auth-error line when the
    // token cache is invalidated by a CLI upgrade; we trim to the
    // first `{` and parse from there.
    const input =
      "Warning: 'databricks auth env' is deprecated and will be removed.\n" +
      "Error: ignored\n" +
      JSON.stringify({ details: { host: "https://example.cloud.databricks.com" } });
    expect(parseHostFromAuthDescribe(input)).toBe("https://example.cloud.databricks.com");
  });

  it("returns undefined when no JSON is present", () => {
    expect(parseHostFromAuthDescribe("error: no profile found")).toBeUndefined();
    expect(parseHostFromAuthDescribe("")).toBeUndefined();
  });

  it("returns undefined when details.host is missing", () => {
    expect(parseHostFromAuthDescribe(JSON.stringify({}))).toBeUndefined();
    expect(parseHostFromAuthDescribe(JSON.stringify({ details: {} }))).toBeUndefined();
    expect(
      parseHostFromAuthDescribe(JSON.stringify({ details: { host: 42 } }))
    ).toBeUndefined();
  });

  it("returns undefined when JSON is malformed", () => {
    expect(parseHostFromAuthDescribe("{ not really json")).toBeUndefined();
  });
});

describe("resolveDatabricksHost: error contract", () => {
  it("rejects when CLI is missing entirely", async () => {
    const origPath = process.env.PATH;
    process.env.PATH = "/nonexistent-bin";
    try {
      await expect(
        resolveDatabricksHost({
          profile: "any",
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow(/ENOENT|spawn|not found|failed/i);
    } finally {
      process.env.PATH = origPath;
    }
  }, 10_000);
});

describe("resolveDatabricksHost: live", () => {
  it.skipIf(!RUN_LIVE)("returns the host for a valid profile", async () => {
    const host = await resolveDatabricksHost({ profile: PROFILE! });
    expect(host).toBeTruthy();
    expect(host!.startsWith("https://")).toBe(true);
    expect(host!.endsWith("/")).toBe(false);
  }, 30_000);

  it("documents the skip reason when CLI or profile is missing", () => {
    if (!CLI_AVAILABLE) {
      console.log("databricks CLI not on PATH; live resolveDatabricksHost skipped.");
    } else if (!PROFILE) {
      console.log("LAKEBASE_TEST_PROFILE not set; live resolveDatabricksHost skipped.");
    }
    expect(true).toBe(true);
  });
});
