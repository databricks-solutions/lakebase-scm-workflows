/**
 * Reference Playwright config for full-stack Lakebase projects.
 *
 * Copy to `client/playwright.config.ts` and adapt. The important bit is
 * the `webServer: []` array — both the frontend dev server AND the
 * backend must be booted so the frontend's `/api/*` proxy has a target.
 *
 * Without the backend entry, CI hits:
 *     [vite] http proxy error: /api/...
 *     AggregateError [ECONNREFUSED]
 * because Playwright only started Vite, not the API server.
 *
 * Adapt the backend `command`/`url` to your stack:
 *   - Python/FastAPI: `uv run uvicorn server.app:app --port 8000`, poll `/health`
 *   - Java/Spring:    `./mvnw -q spring-boot:run`, poll `/actuator/health`
 *   - Node.js:        `npm --prefix .. run start`, poll whatever `/health` you expose
 *
 * `cwd: '..'` is set because this config lives under `client/` and the
 * backend is started from the project root.
 *
 * `reuseExistingServer: !process.env.CI` keeps local dev fast (Playwright
 * reuses your already-running servers) while CI hard-fails if the port is
 * bound (a self-hosted runner with a stale local dev server is the usual
 * culprit — kill it and rerun).
 */
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  // Serialize specs if they share real-DB state via global-setup.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  globalSetup: './tests/global-setup.ts',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    // Backend — start FIRST so Vite's proxy target is up before the
    // frontend tries to render. Playwright boots entries in parallel,
    // but the order is preserved for ready-check polling.
    {
      command: 'uv run uvicorn server.app:app --port 8000',
      url: 'http://localhost:8000/health',
      cwd: '..',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        // If your backend gates test-only endpoints (e.g. /api/dev/seed-user)
        // behind a dev flag, set it here so the Playwright-booted backend
        // exposes them. Common names: DEV_MODE, APP_ENV=development, etc.
        // Without this, seed-helper calls 404 and every test fails at setup.
        DEV_MODE: 'true',
        // Pipe Databricks SDK creds from the GH Actions job's env (which
        // pr.yml populates from repo secrets). Anything the backend needs
        // for SDK calls (AI endpoints, Unity Catalog volumes, etc.) should
        // come from env here — don't rely on the runner's local CLI auth,
        // which silently expires and produces `refresh token is invalid`
        // warnings 30+ minutes into a run.
        DATABRICKS_HOST: process.env.DATABRICKS_HOST ?? '',
        DATABRICKS_TOKEN: process.env.DATABRICKS_TOKEN ?? '',
      },
    },
    // Frontend — proxies `/api/*` to the backend.
    {
      command: 'npm run dev',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
})
