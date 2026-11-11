import { defineConfig } from "./playwright-tools.ts";

export default defineConfig({
  testDir: "browser",
  outputDir: "../../target/leader-cases-142/test-results",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: { viewport: { width: 1440, height: 1000 }, locale: "ko-KR", timezoneId: "Asia/Seoul", trace: "retain-on-failure", screenshot: "only-on-failure" },
});
