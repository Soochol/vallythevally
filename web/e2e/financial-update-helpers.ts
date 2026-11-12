import type { Page } from "@playwright/test";
import type { FinancialUpdatePage } from "../src/api/generated/FinancialUpdatePage";
import { type App, expect } from "./harness";

export const financialListings = { apiId: "ka10099", status: 200, body: { return_code: 0, return_msg: "synthetic", list: [
  { code: "005930", name: "삼성전자", marketCode: "0" },
  { code: "000660", name: "같은 발행인", marketCode: "0" },
  { code: "005935", name: "삼성전자우", marketCode: "0" },
  { code: "000020", name: "동화약품", marketCode: "0" },
  { code: "0000D0", name: "합성 ETF", marketCode: "8" },
] } };

export async function startUpdate(app: App, settle = false) {
  const response = await fetch(`${app.url}/api/financial-update`, { method: "POST" });
  expect(response.ok).toBe(true);
  if (settle) await settleUpdate(app);
}

export async function settleUpdate(app: App) {
  await expect.poll(async () => {
    const job: FinancialUpdatePage = await (await fetch(`${app.url}/api/financial-update`)).json();
    return job.status === "planning" || job.status === "collecting";
  }, { timeout: 45000 }).toBe(false);
}

export async function updateFromChart(page: Page) {
  await page.getByRole("button", { name: "전체 재무자료 업데이트", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "재무자료", exact: true });
  await dialog.getByRole("button", { name: "전체 업데이트", exact: true }).click();
  await dialog.getByRole("button", { name: "닫기", exact: true }).first().click();
}
