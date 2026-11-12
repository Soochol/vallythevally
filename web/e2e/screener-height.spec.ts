import { writeFile } from "node:fs/promises";
import type { Locator, Page } from "@playwright/test";
import type { ApiError } from "../src/api/generated/ApiError";
import type { Screen } from "../src/api/generated/Screen";
import { cell, expect, test } from "./harness";
import { openScreener, panel, results, rows, runButton, storeLine, updateBand, waitForUpdateToFinish } from "./screener-page";

test.use({ krxMarket: "20261106", clockStart: "20261106203000" });

const screen: Screen = {
  id: "height", name: "세 조건 결과 보존", markets: [], exclude: [],
  conditions: (["close", "high", "volume"] as const).map((field) => ({ kind: "new_high", period: "D", field, n: 1, barRange: { start: 0, end: 0 } })),
};
const failure = { apiId: "ka10095", status: 200, body: { return_code: 2, return_msg: "입력 값 오류입니다[1501:시험용 수집 실패]" } };
const metadata = (page: Page) => results(page).getByLabel("결과 자료");

async function openPanel(page: Page, width: number) {
  if (width < 768) await page.getByRole("navigation", { name: "휴대폰 탭" }).getByRole("button", { name: "스크리너" }).click();
  else await openScreener(page);
}

async function rowGeometry(row: Locator, scroll = true) {
  return row.evaluate((element, scroll) => {
    if (scroll) element.scrollIntoView({ block: "center" });
    const box = element.getBoundingClientRect();
    let top = 0;
    let bottom = window.innerHeight;
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (["auto", "scroll", "hidden", "clip"].includes(getComputedStyle(ancestor).overflowY)) {
        const clip = ancestor.getBoundingClientRect();
        top = Math.max(top, clip.top);
        bottom = Math.min(bottom, clip.bottom);
      }
    }
    const footer = element.closest('aside[aria-label="스크리너"]')?.querySelector("footer");
    if (footer) bottom = Math.min(bottom, footer.getBoundingClientRect().top);
    const target = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return { height: box.height, top: box.top, bottom: box.bottom, clipTop: top, clipBottom: bottom, visibleHeight: Math.max(0, Math.min(box.bottom, bottom) - Math.max(box.top, top)), pointerReachesRow: target !== null && element.contains(target) };
  }, scroll);
}

function expectWholeRow(geometry: Awaited<ReturnType<typeof rowGeometry>>) {
  expect(geometry.height).toBeGreaterThan(0);
  expect(geometry.visibleHeight).toBeCloseTo(geometry.height, 0);
  expect(geometry.pointerReachesRow).toBe(true);
}

for (const [width, height] of [[320, 568], [320, 844], [360, 844], [390, 844], [1024, 768], [1280, 600], [1440, 900]]) {
  test(`${width}×${height}에서 세 조건의 성공·실행 중·실패 뒤 결과 행 전체를 읽고 스크롤해 차트로 연다`, async ({ app, page }, info) => {
    await page.setViewportSize({ width: width!, height: height! });
    expect((await fetch(`${app.url}/api/screens`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ screens: [screen], revision: 1 }) })).status).toBe(200);
    await page.goto("/");
    await openPanel(page, width!);
    await updateBand(page).getByRole("button", { name: "처음 받기" }).click();
    await waitForUpdateToFinish(page, "11-06(금)");
    await runButton(page).click();
    await expect(rows(page)).toHaveCount(10);
    const original = await metadata(page).textContent();
    const first = rows(page).filter({ hasText: "110010" });
    const last = rows(page).filter({ hasText: "110040" });
    const success = await rowGeometry(first);
    await page.screenshot({ path: info.outputPath("success.png"), fullPage: true });
    let release!: () => void;
    let received!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const requested = new Promise<void>((resolve) => { received = resolve; });
    await app.fake.respondWith(failure);
    await page.route("**/api/screener/run", async (route) => {
      const response = await route.fetch();
      received();
      await gate;
      await route.fulfill({ response });
    });
    await runButton(page).click();
    await requested;
    await expect(results(page)).toHaveAttribute("aria-busy", "true");
    await expect(metadata(page)).toHaveText(original!);
    const running = await rowGeometry(first);
    await page.screenshot({ path: info.outputPath("running.png"), fullPage: true });
    release();
    await expect(panel(page).getByRole("alert")).toContainText("이전 결과와 수집 시각을 유지합니다");
    await expect(metadata(page)).toHaveText(original!);
    const failed = await rowGeometry(first);
    await writeFile(info.outputPath("geometry.json"), JSON.stringify({ width, height, success, running, failed }, null, 2));
    await page.screenshot({ path: info.outputPath("failed.png"), fullPage: true });
    await first.getByRole("button").click({ timeout: 2_500 });
    await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 가상전자 통합 일");
    if (width! < 768) await openPanel(page, width!);
    expectWholeRow(success);
    expectWholeRow(running);
    expectWholeRow(failed);
    expectWholeRow(await rowGeometry(last));
    await last.getByRole("button").click();
    await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 가상정지 통합 일");
    if (width! < 768) await openPanel(page, width!);
    await expect(metadata(page)).toHaveText(original!);
    await expect(panel(page).getByRole("alert")).toContainText("실행하지 못했습니다");
    await page.keyboard.press("ArrowUp");
    await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 가상신규 통합 일");
    if (width! < 768) await openPanel(page, width!);
    const selected = rows(page).filter({ hasText: "110090" });
    await expect(selected.getByRole("button")).toHaveAttribute("aria-current", "true");
    expectWholeRow(await rowGeometry(selected, false));
    await page.screenshot({ path: info.outputPath("keyboard-selection.png"), fullPage: true });
    await metadata(page).scrollIntoViewIfNeeded();
    await expect(metadata(page)).toBeInViewport();
    await expect(metadata(page)).toHaveText(original!);
    await panel(page).getByRole("alert").scrollIntoViewIfNeeded();
    await expect(panel(page).getByRole("alert")).toBeInViewport();
    await panel(page).getByRole("list", { name: "조건", exact: true }).scrollIntoViewIfNeeded();
    await expect(panel(page).getByRole("list", { name: "조건", exact: true }).getByRole("listitem")).toHaveCount(3);
    await runButton(page).scrollIntoViewIfNeeded();
    await expect(runButton(page)).toBeInViewport();
    await expect(storeLine(page)).toBeInViewport();
    await expect(results(page).getByRole("button", { name: /^최신가 순으로 정렬/ })).toBeEnabled();
    await storeLine(page).getByRole("button", { name: "업데이트", exact: true }).click({ trial: true });
    await results(page).getByRole("button", { name: /^최신가 순으로 정렬/ }).click();
    await expect(results(page).getByRole("button", { name: /^최신가 순으로 정렬/ })).toHaveAttribute("aria-pressed", "true");
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
    await page.unroute("**/api/screener/run");
    await app.fake.reset();
    await runButton(page).click();
    await expect(results(page)).toHaveAttribute("aria-busy", "false");
    await expect(panel(page).getByRole("alert")).toHaveCount(0);
    expectWholeRow(await rowGeometry(first));
    await first.getByRole("button").click();
    await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 가상전자 통합 일");
  });
}

for (const [width, height] of [[320, 568], [1280, 600]]) {
  test(`${width}×${height}에서 긴 오류 설명도 끝까지 읽고 보존 결과를 차트로 연다`, async ({ app, page }, info) => {
    await page.setViewportSize({ width: width!, height: height! });
    expect((await fetch(`${app.url}/api/screens`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ screens: [screen], revision: 1 }) })).status).toBe(200);
    await page.goto("/");
    await openPanel(page, width!);
    await updateBand(page).getByRole("button", { name: "처음 받기" }).click();
    await waitForUpdateToFinish(page, "11-06(금)");
    await runButton(page).click();
    await expect(rows(page)).toHaveCount(10);
    const original = await metadata(page).textContent();
    await app.fake.respondWith(failure);
    await page.route("**/api/screener/run", async (route) => {
      const response = await route.fetch();
      expect(response.ok()).toBe(false);
      const body: ApiError = await response.json();
      const message = `${body.error.message} ${"자료를 수집하지 못했습니다. 원인을 확인한 뒤 다시 실행해 주세요. ".repeat(18)}오류 설명 끝`;
      await route.fulfill({ response, json: { ...body, error: { ...body.error, message } } });
    });
    await runButton(page).click();
    const alert = panel(page).getByRole("alert");
    await expect(alert).toContainText("오류 설명 끝");
    await expect(alert).toContainText("이전 결과와 수집 시각을 유지합니다");
    await expect(metadata(page)).toHaveText(original!);
    await alert.evaluate((e) => e.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: info.outputPath("long-error-start.png"), fullPage: true });
    await alert.evaluate((e) => e.scrollIntoView({ block: "end" }));
    await page.screenshot({ path: info.outputPath("long-error-end.png"), fullPage: true });
    const first = rows(page).filter({ hasText: "110010" });
    const geometry = await rowGeometry(first);
    expectWholeRow(geometry);
    await writeFile(info.outputPath("long-error-geometry.json"), JSON.stringify(geometry, null, 2));
    await page.screenshot({ path: info.outputPath("long-error-row.png"), fullPage: true });
    await first.getByRole("button").click();
    await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 가상전자 통합 일");
    if (width! < 768) await openPanel(page, width!);
    await expect(metadata(page)).toHaveText(original!);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
  });
}
