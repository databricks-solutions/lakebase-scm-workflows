import { describe, it, expect } from "vitest";
import { exec } from "../../scripts/util/exec.js";

describe("exec", () => {
  it("returns trimmed stdout for a successful command", async () => {
    const out = await exec("echo hello");
    expect(out).toBe("hello");
  });

  it("rejects with a descriptive error when the command exits non-zero", async () => {
    await expect(exec("false")).rejects.toThrow(/false/);
  });

  it("respects cwd", async () => {
    const out = await exec("pwd", { cwd: "/" });
    expect(out).toBe("/");
  });

  it("respects env", async () => {
    const out = await exec("echo $LAKEBASE_EXEC_TEST_VAR", {
      env: { LAKEBASE_EXEC_TEST_VAR: "xyzzy" },
    });
    expect(out).toBe("xyzzy");
  });
});
