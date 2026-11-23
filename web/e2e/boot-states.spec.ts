import type { Locator, Page } from "@playwright/test";
import type { AccountStatus } from "../src/api/generated/AccountStatus";
import { DEFAULT_LAYOUT_ID, expect, test } from "./harness";

const TOPBAR = (page: Page) => page.getByRole("toolbar", { name: "차트 도구 막대" });
const RAIL = (page: Page) => page.getByRole("navigation", { name: "페이지 메뉴" });
const STATUS_BAR = (page: Page) => page.getByRole("contentinfo");
const SKELETON = (page: Page) => page.locator("[data-shell-skeleton]");
const RESTORING_STATUS = "마지막 화면을 불러오는 중…";
const MALFORMED_ACCOUNT = { state: "owner_mismatch", provider: "naver" } as unknown as AccountStatus;

async function rectOf(target: Locator) {
  const box = await target.boundingBox();
  if (!box) throw new Error("영역이 보이지 않습니다");
  return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
}

test.use({ viewport: { width: 1440, height: 900 } });

test("레이아웃 응답을 붙잡은 동안 틀 뼈대가 보이고 응답을 풀면 같은 자리에 실제 화면이 온다", async ({ page, scenario }) => {
  const held = scenario.hold((url, request) => request.method() === "GET" && url.pathname.startsWith("/api/layouts/"));
  await page.goto("/");
  await held.received;
  const skeleton = SKELETON(page);
  await expect(skeleton).toBeVisible();
  await expect(skeleton).toHaveAttribute("aria-busy", "true");
  await expect(page.getByLabel("마지막 화면을 불러오는 중", { exact: true })).toBeVisible();
  const placeholder = {
    topbar: await rectOf(skeleton.locator("[data-skeleton-part=topbar]")),
    rail: await rectOf(skeleton.locator("[data-skeleton-part=rail]")),
    status: await rectOf(skeleton.locator("[data-skeleton-part=status]")),
  };
  await expect(skeleton.locator("[data-skeleton-part=status]").getByText(RESTORING_STATUS, { exact: true })).toBeVisible();
  await expect(skeleton.locator("[data-skeleton-part=topbar]").getByText("vally", { exact: true })).toBeVisible();
  await expect(TOPBAR(page)).toHaveCount(0);
  held.reply({ body: scenario.documents.layout(DEFAULT_LAYOUT_ID) });
  await expect(TOPBAR(page)).toBeVisible();
  await expect(skeleton).toHaveCount(0);
  expect(await rectOf(TOPBAR(page))).toEqual(placeholder.topbar);
  expect(await rectOf(RAIL(page))).toEqual(placeholder.rail);
  const status = await rectOf(STATUS_BAR(page));
  expect({ y: status.y, height: status.height }).toEqual({ y: placeholder.status.y, height: placeholder.status.height });
});

test("응답이 바로 오면 불러오는 중 글자가 한 번도 보이지 않는다", async ({ page }) => {
  await page.addInitScript(() => {
    const seen = { skeleton: false, label: false };
    Object.assign(window, { restoringProbe: seen });
    new MutationObserver(() => { if (document.querySelector("[data-shell-skeleton]")) seen.skeleton = true; }).observe(document, { childList: true, subtree: true });
    document.addEventListener("animationstart", (event) => { if (event.target instanceof Element && event.target.closest(".shell-skeleton-status")) seen.label = true; }, true);
  });
  await page.goto("/");
  await expect(TOPBAR(page)).toBeVisible();
  await expect(page.getByText("마지막 화면을 불러오는 중…", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { restoringProbe: { skeleton: boolean; label: boolean } }).restoringProbe)).toEqual({ skeleton: true, label: false });
});

test("그리다 예외가 나면 오류 화면이 보이고 다시 불러오기가 페이지를 다시 연다", async ({ page, scenario }) => {
  scenario.live.account = MALFORMED_ACCOUNT;
  await page.goto("/");
  const screen = page.getByRole("alert").filter({ hasText: "화면을 그리다 문제가 생겼습니다" });
  await expect(screen).toBeVisible();
  await expect(screen.getByRole("button", { name: "기본 화면으로 열기", exact: true })).toBeVisible();
  await expect(screen.getByRole("button", { name: "오류 내용 복사", exact: true })).toBeVisible();
  await expect(TOPBAR(page)).toHaveCount(0);
  scenario.live.account = { state: "local_only" };
  const loaded = page.waitForEvent("load");
  await screen.getByRole("button", { name: "다시 불러오기", exact: true }).click();
  await loaded;
  await expect(TOPBAR(page)).toBeVisible();
  await expect(screen).toHaveCount(0);
});

test("기본 화면으로 열기는 마지막 레이아웃을 건너뛰고 저장된 문서를 건드리지 않는다", async ({ page, scenario }) => {
  const stored = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  scenario.live.account = MALFORMED_ACCOUNT;
  await page.goto("/");
  const screen = page.getByRole("alert").filter({ hasText: "화면을 그리다 문제가 생겼습니다" });
  await expect(screen).toBeVisible();
  scenario.live.account = { state: "local_only" };
  const requestsBefore = scenario.requests.length;
  const loaded = page.waitForEvent("load");
  await screen.getByRole("button", { name: "기본 화면으로 열기", exact: true }).click();
  await loaded;
  await expect(TOPBAR(page)).toBeVisible();
  await expect(STATUS_BAR(page)).toContainText("기본 화면으로 열었습니다");
  const reopened = scenario.requests.slice(requestsBefore);
  const calls = reopened.map((request) => `${request.method()} ${new URL(request.url()).pathname}`);
  expect(calls.filter((call) => call.includes("/api/layouts"))).toEqual([]);
  expect(calls.filter((call) => !call.startsWith("GET "))).toEqual([]);
  expect(scenario.documents.layout(DEFAULT_LAYOUT_ID)).toEqual(stored);
});
