import { writeFile } from "node:fs/promises";
import type { Locator, Page } from "@playwright/test";
import type { ApiError } from "../src/api/generated/ApiError";
import type { Screen } from "../src/api/generated/Screen";
import { cell, chartOf, expect, test } from "./harness";
import { closeEditorWindow, expandEditor } from "./sentence-editor";
import { openResultDetails, openScreener, panel, results, rows, runButton, storeLine, updateBand, waitForUpdateToFinish } from "./screener-page";

test.use({ krxMarket: "20261106", clockStart: "20261106203000" });

const screen: Screen = {
  id: "height", name: "세 조건 결과 보존", markets: [], exclude: [],
  conditions: (["close", "high", "volume"] as const).map((field) => ({ kind: "new_high", period: "D", field, n: 1, recentBars: 1 })),
};
const failure = { apiId: "ka10095", status: 200, body: { return_code: 2, return_msg: "입력 값 오류입니다[1501:시험용 수집 실패]" } };
const metadata = (page: Page) => results(page).getByLabel("결과 자료");

async function openPanel(page: Page, width: number) {
  if (width < 768) await page.getByRole("navigation", { name: "휴대폰 탭" }).getByRole("button", { name: "스크리너" }).click();
  else await openScreener(page);
}

async function expectChart(page: Page, name: string) {
  await expect(cell(page)).toHaveAttribute("aria-label", `칸 1: ${name} 통합 일`);
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(chartOf(cell(page))).not.toHaveAttribute("data-bar-count", "0");
}

async function rowGeometry(row: Locator, scroll = true) {
  return row.evaluate((element, scroll) => {
    if (scroll) element.scrollIntoView({ block: "center" });
    const box = element.getBoundingClientRect();
    let top = 0;
    let bottom = window.innerHeight;
    let left = 0;
    let right = window.innerWidth;
    const ancestors = [];
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      const clip = ancestor.getBoundingClientRect();
      ancestors.push({ tag: ancestor.tagName, id: ancestor.id, role: ancestor.getAttribute("role"), top: clip.top, height: clip.height, scrollTop: ancestor.scrollTop, scrollHeight: ancestor.scrollHeight, clientHeight: ancestor.clientHeight, overflowY: style.overflowY });
      if (["auto", "scroll", "hidden", "clip"].includes(style.overflowY)) {
        top = Math.max(top, clip.top + ancestor.clientTop);
        bottom = Math.min(bottom, clip.top + ancestor.clientTop + ancestor.clientHeight);
      }
      if (["auto", "scroll", "hidden", "clip"].includes(style.overflowX)) {
        left = Math.max(left, clip.left + ancestor.clientLeft);
        right = Math.min(right, clip.left + ancestor.clientLeft + ancestor.clientWidth);
      }
    }
    const footer = element.closest('aside[aria-label="스크리너"]')?.querySelector("footer");
    if (footer) bottom = Math.min(bottom, footer.getBoundingClientRect().top);
    const pointerChecks = [0.25, 0.5, 0.75].map((ratio) => {
      const target = document.elementFromPoint(box.left + box.width * ratio, box.top + box.height * ratio);
      return target !== null && element.contains(target);
    });
    return { ancestors, width: box.width, visibleWidth: Math.max(0, Math.min(box.right, right) - Math.max(box.left, left)), height: box.height, top: box.top, bottom: box.bottom, clipTop: top, clipBottom: bottom, visibleHeight: Math.max(0, Math.min(box.bottom, bottom) - Math.max(box.top, top)), pointerReachesRow: pointerChecks.every(Boolean) };
  }, scroll);
}

function expectWholeRow(geometry: Awaited<ReturnType<typeof rowGeometry>>) {
  expect(geometry.height).toBeGreaterThan(0);
  expect(geometry.visibleWidth).toBeCloseTo(geometry.width, 0);
  expect(geometry.visibleHeight).toBeCloseTo(geometry.height, 0);
  expect(geometry.pointerReachesRow).toBe(true);
}

const surfaces = [
  { width: 320, height: 568, wide: false },
  { width: 320, height: 844, wide: false },
  { width: 360, height: 844, wide: false },
  { width: 390, height: 844, wide: false },
  { width: 1024, height: 768, wide: false },
  { width: 1280, height: 600, wide: false },
  { width: 1440, height: 900, wide: false },
  { width: 1280, height: 600, wide: true },
  { width: 1440, height: 900, wide: true },
];

for (const { width, height, wide } of surfaces) {
  test(`${width}×${height} ${wide ? "넓은 패널" : "기본 패널"}에서 세 조건의 성공·실행 중·실패 뒤 결과 행 전체를 읽고 스크롤해 차트로 연다`, async ({ app, page }, info) => {
    await page.setViewportSize({ width: width!, height: height! });
    expect((await fetch(`${app.url}/api/screens`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ screens: [screen], revision: 1 }) })).status).toBe(200);
    await page.goto("/");
    await openPanel(page, width!);
    if (wide) {
      await page.getByRole("button", { name: "넓게 보기", exact: true }).click();
      await expect(page.getByRole("button", { name: "오른쪽 탭으로", exact: true })).toHaveAttribute("aria-pressed", "true");
    }
    await updateBand(page).getByRole("button", { name: "처음 받기" }).click();
    await waitForUpdateToFinish(page, "11-06(금)");
    await runButton(page).click();
    await expect(rows(page)).toHaveCount(10);
    await openResultDetails(page);
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
    await writeFile(info.outputPath("geometry.json"), JSON.stringify({ width, height, wide, success, running, failed }, null, 2));
    await page.screenshot({ path: info.outputPath("failed.png"), fullPage: true });
    await openRow(page, first, wide, 2_500);
    await expectChart(page, "가상전자");
    if (width! < 768) await openPanel(page, width!);
    expectWholeRow(success);
    expectWholeRow(running);
    expectWholeRow(failed);
    expectWholeRow(await rowGeometry(last));
    await openRow(page, last, wide);
    await expectChart(page, "가상정지");
    if (width! < 768) await openPanel(page, width!);
    await expect(metadata(page)).toHaveText(original!);
    await expect(panel(page).getByRole("alert")).toContainText("실행하지 못했습니다");
    await page.keyboard.press("ArrowUp");
    if (wide) await page.keyboard.press("Enter");
    await expectChart(page, "가상신규");
    if (wide) await page.getByRole("button", { name: "넓게 보기", exact: true }).click();
    if (width! < 768) await openPanel(page, width!);
    const selected = rows(page).filter({ hasText: "110090" });
    await expect(selected.getByRole("button")).toHaveAttribute("aria-current", "true");
    const keyboardGeometry = await rowGeometry(selected, false);
    expectWholeRow(keyboardGeometry);
    await writeFile(info.outputPath("keyboard-geometry.json"), JSON.stringify(keyboardGeometry, null, 2));
    if (width >= 768) expect((await page.getByRole("toolbar", { name: "차트 도구 막대" }).boundingBox())?.y).toBeCloseTo(0, 0);
    await page.screenshot({ path: info.outputPath("keyboard-selection.png"), fullPage: true });
    await openResultDetails(page);
    await metadata(page).scrollIntoViewIfNeeded();
    await expect(metadata(page)).toBeInViewport();
    await expect(metadata(page)).toHaveText(original!);
    await panel(page).getByRole("alert").scrollIntoViewIfNeeded();
    await expect(panel(page).getByRole("alert")).toBeInViewport();
    if (width >= 768) await expandEditor(page);
    await panel(page).getByRole("list", { name: "조건", exact: true }).scrollIntoViewIfNeeded();
    await expect(panel(page).getByRole("list", { name: "조건", exact: true }).getByRole("listitem")).toHaveCount(3);
    await closeEditorWindow(page);
    const menuToggle = panel(page).getByRole("button", { name: "스크리너 메뉴", exact: true });
    await menuToggle.click();
    await expect(page.getByRole("menu", { name: "스크리너 메뉴" }).getByRole("menuitem", { name: /^새 목록/ })).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(menuToggle).toBeFocused();
    await runButton(page).scrollIntoViewIfNeeded();
    await expect(runButton(page)).toBeInViewport();
    await expect(storeLine(page)).toBeInViewport();
    await expect(results(page).getByRole("button", { name: /^종가 순으로 정렬/ })).toBeEnabled();
    await storeLine(page).getByRole("button", { name: "업데이트", exact: true }).click({ trial: true });
    await results(page).getByRole("button", { name: /^종가 순으로 정렬/ }).click();
    await expect(results(page).getByRole("columnheader", { name: "종가 순으로 정렬", exact: true })).toHaveAttribute("aria-sort", "descending");
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
    await page.unroute("**/api/screener/run");
    await app.fake.reset();
    await runButton(page).click();
    await expect(results(page)).toHaveAttribute("aria-busy", "false");
    await expect(panel(page).getByRole("alert")).toHaveCount(0);
    expectWholeRow(await rowGeometry(first));
    await openRow(page, first, wide);
    await expectChart(page, "가상전자");
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
    await openResultDetails(page);
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
    await expectChart(page, "가상전자");
    if (width! < 768) await openPanel(page, width!);
    await expect(metadata(page)).toHaveText(original!);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
  });
}

async function openRow(page: Page, row: Locator, wide: boolean, timeout?: number) {
  await row.getByRole("button").click({ timeout });
  if (!wide) return;
  await expect(page.getByRole("complementary", { name: "결과 종목 미리보기" }).getByRole("img")).toBeVisible();
  await row.getByRole("button").press("Enter");
  await expect(page.getByRole("button", { name: "넓게 보기", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "넓게 보기", exact: true }).click();
  await row.getByRole("button").focus();
}
