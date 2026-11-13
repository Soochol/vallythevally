import { defineConfig, devices } from "@playwright/test";

const origin = process.env.VALLY_E2E_BASE_URL ?? `http://127.0.0.1:${process.env.VALLY_E2E_PORT ?? "4173"}`;

export default defineConfig({
  testDir: "e2e",
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  webServer: process.env.VALLY_E2E_BASE_URL ? undefined : { command: "node e2e/serve.mjs", url: origin, reuseExistingServer: false },
  use: {
    baseURL: origin,
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    launchOptions: { chromiumSandbox: true },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
});
