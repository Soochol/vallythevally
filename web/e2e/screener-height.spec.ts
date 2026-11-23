import { writeFile } from "node:fs/promises";
import type { Locator, Page } from "@playwright/test";
import { allResult, currentResult, emptyStatus, readyStatus, runError } from "./fixtures/screener";
import type { Screen } from "../src/api/generated/Screen";
import { cell, chartOf, expect, test } from "./screener-harness";
import { closeEditorWindow, expandEditor, renameScreen, sentenceEditor } from "./sentence-editor";
import { openResultDetails, openScreener, panel, results, rowOf, rows, runButton, storeLine, updateBand, waitForUpdateToFinish } from "./screener-page";


const screen: Screen = {
  id: "height", name: "세 조건 결과 보존", markets: [], exclude: [],
  conditions: (["close", "high", "volume"] as const).map((field) => ({ kind: "new_high", period: "D", field, n: 1, recentBars: 1 })),
};
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
  { width: 320, height: 568 },
  { width: 320, height: 844 },
  { width: 360, height: 844 },
  { width: 390, height: 844 },
  { width: 1024, height: 768 },
  { width: 1280, height: 600 },
  { width: 1440, height: 900 },
];

for (const { width, height } of surfaces) {
  test(`${width}×${height}에서 세 조건의 성공·실행 중·실패 뒤 결과 행 전체를 읽고 스크롤해 차트로 연다`, async ({ scenario, screener, page }, info) => {
    await page.setViewportSize({ width: width!, height: height! });
    scenario.documents.saveScreens({ screens: [screen], revision: 1 });
    screener.showResult(currentResult());
    await page.goto("/");
    await openPanel(page, width!);
    await updateBand(page).getByRole("button", { name: "처음 받기" }).click();
    await waitForUpdateToFinish(page, "11-06(금)");
    await runButton(page).click();
    await expect(rows(page)).toHaveCount(10);
    await openResultDetails(page);
    const original = await metadata(page).textContent();
    const first = rowOf(page, "110010");
    const last = rowOf(page, "110040");
    const success = await rowGeometry(first);
    await page.screenshot({ path: info.outputPath("success.png"), fullPage: true });
    const held = scenario.hold("/api/screener/run");
    await runButton(page).click();
    await held.received;
    await expect(results(page)).toHaveAttribute("aria-busy", "true");
    await expect(metadata(page)).toHaveText(original!);
    const running = await rowGeometry(first);
    await page.screenshot({ path: info.outputPath("running.png"), fullPage: true });
    held.reply({ status: 503, body: runError() });
    await expect(panel(page).getByRole("alert")).toContainText("이전 결과를 그대로 보입니다");
    await expect(metadata(page)).toHaveText(original!);
    const failed = await rowGeometry(first);
    await writeFile(info.outputPath("geometry.json"), JSON.stringify({ width, height, success, running, failed }, null, 2));
    await page.screenshot({ path: info.outputPath("failed.png"), fullPage: true });
    await first.getByRole("button").click({ timeout: 2_500 });
    await expectChart(page, "가상전자");
    if (width! < 768) await openPanel(page, width!);
    expectWholeRow(success);
    expectWholeRow(running);
    expectWholeRow(failed);
    expectWholeRow(await rowGeometry(last));
    await last.getByRole("button").click();
    await expectChart(page, "가상정지");
    if (width! < 768) await openPanel(page, width!);
    await expect(metadata(page)).toHaveText(original!);
    await expect(panel(page).getByRole("alert")).toContainText("실행하지 못했습니다");
    await page.keyboard.press("ArrowUp");
    await expectChart(page, "가상신규");
    if (width! < 768) await openPanel(page, width!);
    const selected = rowOf(page, "110090");
    await expect(selected.getByRole("button")).toHaveAttribute("aria-current", "true");
    const keyboardGeometry = await rowGeometry(selected, false);
    expectWholeRow(keyboardGeometry);
    await writeFile(info.outputPath("keyboard-geometry.json"), JSON.stringify(keyboardGeometry, null, 2));
    if (width >= 768) expect((await page.getByRole("toolbar", { name: "차트 도구 막대" }).boundingBox())?.y).toBeCloseTo(12, 0);
    await page.screenshot({ path: info.outputPath("keyboard-selection.png"), fullPage: true });
    await openResultDetails(page);
    await metadata(page).scrollIntoViewIfNeeded();
    await expect(metadata(page)).toBeInViewport();
    await expect(metadata(page)).toHaveText(original!);
    await panel(page).getByRole("alert").scrollIntoViewIfNeeded();
    await expect(panel(page).getByRole("alert")).toBeInViewport();
    if (width >= 768) {
      await expandEditor(page);
      await panel(page).getByRole("list", { name: "조건", exact: true }).scrollIntoViewIfNeeded();
      await expect(panel(page).getByRole("list", { name: "조건", exact: true }).getByRole("listitem")).toHaveCount(3);
      await closeEditorWindow(page);
    } else {
      await panel(page).getByRole("button", { name: "편집", exact: true }).click();
      const phoneEditor = page.getByRole("dialog", { name: "조건식 편집", exact: true });
      await expect(phoneEditor.getByRole("list", { name: "조건", exact: true }).getByRole("listitem")).toHaveCount(3);
      await phoneEditor.getByRole("button", { name: "닫기", exact: true }).click();
      await expect(phoneEditor).toBeHidden();
    }
    const menuToggle = panel(page).getByRole("button", { name: "스크리너 메뉴", exact: true });
    await menuToggle.click();
    await expect(page.getByRole("menu", { name: "스크리너 메뉴" }).getByRole("menuitem", { name: /^새 목록/ })).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(menuToggle).toBeFocused();
    await runButton(page).scrollIntoViewIfNeeded();
    await expect(runButton(page)).toBeInViewport();
    await expect(storeLine(page)).toBeInViewport();
    await expect(results(page).getByRole("button", { name: /^현재가 순으로 정렬/ })).toBeEnabled();
    await storeLine(page).getByRole("button", { name: "업데이트", exact: true }).click({ trial: true });
    await results(page).getByRole("button", { name: /^현재가 순으로 정렬/ }).click();
    await expect(results(page).getByRole("columnheader", { name: "현재가 순으로 정렬", exact: true })).toHaveAttribute("aria-sort", "descending");
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
    scenario.reply("/api/screener/run", { body: currentResult() });
    await runButton(page).click();
    await expect(results(page)).toHaveAttribute("aria-busy", "false");
    await expect(panel(page).getByRole("alert")).toHaveCount(0);
    expectWholeRow(await rowGeometry(first));
    await first.getByRole("button").click();
    await expectChart(page, "가상전자");
  });
}

for (const [width, height] of [[320, 568], [1280, 600]]) {
  test(`${width}×${height}에서 긴 오류 설명도 끝까지 읽고 보존 결과를 차트로 연다`, async ({ scenario, screener, page }, info) => {
    await page.setViewportSize({ width: width!, height: height! });
    scenario.documents.saveScreens({ screens: [screen], revision: 1 });
    screener.showResult(currentResult());
    await page.goto("/");
    await openPanel(page, width!);
    await updateBand(page).getByRole("button", { name: "처음 받기" }).click();
    await waitForUpdateToFinish(page, "11-06(금)");
    await runButton(page).click();
    await expect(rows(page)).toHaveCount(10);
    await openResultDetails(page);
    const original = await metadata(page).textContent();
    const message = `${runError().error.message} ${"자료를 수집하지 못했습니다. 원인을 확인한 뒤 다시 실행해 주세요. ".repeat(18)}오류 설명 끝`;
    screener.failRun(runError(message));
    await runButton(page).click();
    const alert = panel(page).getByRole("alert");
    await expect(alert).toContainText("오류 설명 끝");
    await expect(alert).toContainText("이전 결과를 그대로 보입니다");
    await expect(metadata(page)).toHaveText(original!);
    await alert.evaluate((e) => e.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: info.outputPath("long-error-start.png"), fullPage: true });
    await alert.evaluate((e) => e.scrollIntoView({ block: "end" }));
    await page.screenshot({ path: info.outputPath("long-error-end.png"), fullPage: true });
    const first = rowOf(page, "110010");
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

const manyRows = () => ({
  ...allResult(),
  rows: Array.from({ length: 30 }, (_, index) => ({
    symbol: `1102${String(index).padStart(2, "0")}`,
    name: `가상목록${index}`,
    close: 10_000 + index * 125,
    changeRate: (index % 5) - 2,
    matchedDate: "2026-11-06",
    latestBarDate: "2026-11-06",
    provisional: index === 1,
  })),
});

async function runReady(page: Page, scenario: { documents: { saveScreens(value: { screens: Screen[]; revision: number }): void } }, screener: { showStatus(value: ReturnType<typeof readyStatus>): void; showResult(value: ReturnType<typeof allResult>): void }) {
  scenario.documents.saveScreens({ screens: [screen], revision: 1 });
  screener.showStatus(readyStatus());
  screener.showResult(manyRows());
  await page.goto("/");
  await openScreener(page);
  await runButton(page).click();
  await expect(rows(page)).toHaveCount(30);
  await expect(results(page)).toHaveAttribute("aria-busy", "false");
}

const wholeRowsShown = (page: Page) => rows(page).evaluateAll((list) => list.filter((row) => {
  const box = row.getBoundingClientRect();
  let top = 0;
  let bottom = window.innerHeight;
  for (let ancestor = row.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (!["auto", "scroll", "hidden", "clip"].includes(getComputedStyle(ancestor).overflowY)) continue;
    const clip = ancestor.getBoundingClientRect();
    top = Math.max(top, clip.top);
    bottom = Math.min(bottom, clip.bottom);
  }
  const head = row.closest("table")?.querySelector("thead")?.getBoundingClientRect();
  if (head) top = Math.max(top, head.bottom);
  return box.height > 0 && box.top >= top - 0.5 && box.bottom <= bottom + 0.5;
}).length);

test("스크리너 창이 754px이면 결과가 18줄 이상 보이고, 패널이 274px이면 세 줄 이상 보인다", async ({ scenario, screener, page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await runReady(page, scenario, screener);
  const tall = await panel(page).evaluate((el) => el.getBoundingClientRect().height);
  await page.setViewportSize({ width: 1440, height: Math.round(900 + 754 - tall) });
  await expect.poll(() => panel(page).evaluate((el) => Math.round(el.getBoundingClientRect().height))).toBe(754);
  expect(await wholeRowsShown(page)).toBeGreaterThanOrEqual(18);
  await page.setViewportSize({ width: 1440, height: Math.round(900 + 274 - tall) });
  await expect.poll(() => panel(page).evaluate((el) => Math.round(el.getBoundingClientRect().height))).toBe(274);
  expect(await wholeRowsShown(page)).toBeGreaterThanOrEqual(3);
});

test("창의 … 메뉴는 하나이고 조건식 일과 전체 다시 받기를 함께 담으며, 저장은 바뀐 것이 있을 때만 보인다", async ({ scenario, screener, page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await runReady(page, scenario, screener);
  await expect(panel(page).getByRole("button", { name: /메뉴$/ })).toHaveCount(1);
  const head = sentenceEditor(page);
  await expect(head.getByRole("button", { name: "저장", exact: true })).toHaveCount(0);
  await head.getByRole("button", { name: "스크리너 메뉴", exact: true }).click();
  const menu = page.getByRole("menu", { name: "스크리너 메뉴", exact: true });
  await expect(menu.getByRole("menuitem", { name: "이름 바꾸기", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "전체 다시 받기…", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "저장", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await renameScreen(head, "이름 바꾼 조건식");
  const save = head.getByRole("button", { name: "저장", exact: true });
  await expect(save).toBeVisible();
  await expect(save).toHaveCSS("border-top-style", "solid");
  const [saveBox, runBox] = [(await save.boundingBox())!, (await runButton(page).boundingBox())!];
  expect(saveBox.x + saveBox.width).toBeLessThan(runBox.x);
});

test("머리 아래 조건 요약 한 줄이 조건을 줄여 보이고 풍선말에 전체 문장을 둔다", async ({ scenario, screener, page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await runReady(page, scenario, screener);
  const summary = sentenceEditor(page).locator("[data-screen-summary]");
  await expect(summary).toHaveText("두 시장 · 조건 3개: 일봉 최근 1일 이내 종가가 1일 신고가인 봉이 있다, 일봉 최근 1일 이내 고가가 1일 신고가인 봉이 있다, 일봉 최근 1일 이내 거래량이 1일 신고거래량인 봉이 있다");
  await expect(summary).toHaveAttribute("title", "두 시장\n1. 일봉 최근 1일 이내 종가가 1일 신고가인 봉이 있다\n2. 일봉 최근 1일 이내 고가가 1일 신고가인 봉이 있다\n3. 일봉 최근 1일 이내 거래량이 1일 신고거래량인 봉이 있다");
  await expect(summary).toHaveCSS("font-size", "12px");
  expect(await summary.evaluate((el) => [getComputedStyle(el).textOverflow, getComputedStyle(el).whiteSpace, el.scrollWidth > el.clientWidth])).toEqual(["ellipsis", "nowrap", true]);
  const [summaryBox, runBox] = [(await summary.boundingBox())!, (await runButton(page).boundingBox())!];
  expect(summaryBox.y).toBeGreaterThanOrEqual(runBox.y + runBox.height);
});

test("잠정 값이 있는 줄과 없는 줄의 현재가 숫자 끝이 같다", async ({ scenario, screener, page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await runReady(page, scenario, screener);
  const numberEnd = (code: string) => rowOf(page, code).locator("td").nth(1).evaluate((td) => {
    const text = document.createTreeWalker(td, NodeFilter.SHOW_TEXT, { acceptNode: (node) => /\d/.test(node.textContent ?? "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP }).nextNode()!;
    const range = document.createRange();
    range.selectNodeContents(text);
    return range.getBoundingClientRect().right;
  });
  await expect(rowOf(page, "110201").getByLabel("잠정", { exact: true })).toBeVisible();
  expect(await numberEnd("110201")).toBeCloseTo(await numberEnd("110200"), 1);
  expect(await numberEnd("110201")).toBeCloseTo(await numberEnd("110202"), 1);
});

const toneOf = (page: Page, token: string) => page.evaluate((name) => {
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}, token);
const dotColor = (page: Page) => updateBand(page).locator(".conn-dot").evaluate((el) => getComputedStyle(el).backgroundColor);

test("일봉 자료가 없으면 점이 경고색이고 업데이트가 멈추면 위험색이다", async ({ scenario, screener, page }) => {
  scenario.documents.saveScreens({ screens: [screen], revision: 1 });
  screener.showStatus(emptyStatus());
  screener.updateTo({ ...emptyStatus(), update: { phase: "recent", done: 3, total: 10, full: false, error: runError("키움에 연결하지 못했습니다", "kiwoom_unreachable").error } });
  await page.goto("/");
  await openScreener(page);
  await expect(updateBand(page)).toContainText("아직 받은 KRX 일봉이 없습니다");
  expect(await dotColor(page)).toBe(await toneOf(page, "--warning"));
  await updateBand(page).getByRole("button", { name: "처음 받기" }).click();
  await expect(updateBand(page)).toContainText("업데이트가 멈췄습니다");
  expect(await dotColor(page)).toBe(await toneOf(page, "--danger"));
  expect(await toneOf(page, "--warning")).not.toBe(await toneOf(page, "--danger"));
});

test("실행이 실패해도 이전 결과 줄이 남고 다시 시도는 테두리 있는 버튼이다", async ({ scenario, screener, page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await runReady(page, scenario, screener);
  screener.failRun(runError("키움이 응답하지 않습니다"));
  await runButton(page).click();
  const alert = panel(page).getByRole("alert");
  await expect(alert).toContainText("실행하지 못했습니다: 키움이 응답하지 않습니다");
  await expect(alert).toContainText("이전 결과를 그대로 보입니다");
  await expect(rows(page)).toHaveCount(30);
  const retry = alert.getByRole("button", { name: "다시 시도", exact: true });
  await expect(retry).toBeEnabled();
  await expect(retry).toHaveCSS("border-top-style", "solid");
  await expect(retry).toHaveCSS("border-top-width", "1px");
  screener.showResult(manyRows());
  await retry.click();
  await expect(alert).toHaveCount(0);
  await expect(rows(page)).toHaveCount(30);
});
