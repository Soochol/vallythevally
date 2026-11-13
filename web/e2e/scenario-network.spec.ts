import { test, expect } from "@playwright/test";
import { Scenario } from "./fixtures/scenario";

test("외부 주소의 API 경로도 시험 네트워크 경계를 통과하지 못한다", async ({ context, page }) => {
  const scenario = new Scenario();
  await scenario.install(context);
  await page.goto("/");
  const blocked = await page.evaluate(async () => {
    try { await fetch("https://example.invalid/api/layouts"); return false; }
    catch { return true; }
  });
  expect(blocked).toBe(true);
  await expect(scenario.close()).rejects.toThrow("Unexpected network request: https://example.invalid/api/layouts");
});
