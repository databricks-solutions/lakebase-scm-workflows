import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
  endpointPath,
  getEndpoint,
  getCredential,
} from "../../scripts/lakebase/branch-endpoint.js";

const cliAvailable = (() => {
  try {
    execFileSync("databricks", ["--version"], { stdio: "ignore", timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
})();

const TEST_INSTANCE = process.env.LAKEBASE_TEST_INSTANCE;
const TEST_BRANCH = process.env.LAKEBASE_TEST_BRANCH;
const live = cliAvailable && !!TEST_INSTANCE && !!TEST_BRANCH;

describe("endpointPath", () => {
  it("builds the canonical primary endpoint path", () => {
    expect(endpointPath("my-app", "feature-x")).toBe(
      "projects/my-app/branches/feature-x/endpoints/primary"
    );
  });

  it("honors a non-primary endpoint name", () => {
    expect(endpointPath("my-app", "feature-x", "readonly")).toBe(
      "projects/my-app/branches/feature-x/endpoints/readonly"
    );
  });
});

describe.skipIf(!live)("getEndpoint – live read", () => {
  it("returns { host, state } for a real branch endpoint", async () => {
    const ep = await getEndpoint({ instance: TEST_INSTANCE!, branch: TEST_BRANCH! });
    if (ep) {
      expect(typeof ep.host).toBe("string");
      expect(typeof ep.state).toBe("string");
    } else {
      // Branch may not have an endpoint yet (still provisioning).
      // The contract is "returns undefined when no host yet" – also acceptable.
      expect(ep).toBeUndefined();
    }
  });

  it("returns undefined for a definitely-missing branch", async () => {
    const ep = await getEndpoint({
      instance: TEST_INSTANCE!,
      branch: "definitely-does-not-exist-xyz999",
    });
    expect(ep).toBeUndefined();
  });
});

describe.skipIf(!live)("getCredential – live destructive read (mints a token)", () => {
  it("returns { token, email } against a real branch", async () => {
    const cred = await getCredential({ instance: TEST_INSTANCE!, branch: TEST_BRANCH! });
    expect(cred.token).toBeTruthy();
    expect(cred.email).toContain("@");
  }, 30_000);
});

describe("branch-endpoint – skip-when-env-missing", () => {
  it("documents the skip reason when CLI or env is missing", () => {
    if (live) return;
    // eslint-disable-next-line no-console
    console.log(
      !cliAvailable
        ? "`databricks` CLI not available – live branch-endpoint suite skipped."
        : "LAKEBASE_TEST_INSTANCE/LAKEBASE_TEST_BRANCH not set – live branch-endpoint suite skipped."
    );
    expect(live).toBe(false);
  });
});
