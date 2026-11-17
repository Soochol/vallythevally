import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { AccountStatus } from "../src/api/generated/AccountStatus";
import { expect, test, type Scenario } from "./harness";

const SCREENS = path.resolve("../target/ux-screens");
const SIGNED_OUT: AccountStatus = { state: "signed_out" };
const SETUP_PATHS = ["/api/layouts", "/api/watchlists", "/api/ui-state"];
const HEADINGS = [/시세는 내 PC에/, /차트 위에/, /조건으로 거르고/, /다른 PC에서도/];

const route = (method: string, pathname: string) => (url: URL, request: { method(): string }) => url.pathname === pathname && request.method() === method;
const setupCalls = (scenario: Scenario) => scenario.requests.filter((r) => SETUP_PATHS.includes(new URL(r.url()).pathname));
const landing = (page: Page) => page.getByTestId("landing");
const story = (page: Page) => page.getByRole("region", { name: "스크롤 이야기" });
const loginButton = (page: Page) => page.getByRole("button", { name: "로그인", exact: true });
const loginDialog = (page: Page) => page.getByRole("dialog", { name: "로그인", exact: true });
const serverNote = (page: Page) => page.getByRole("heading", { name: /서버에 가는 것은\s*셋업뿐입니다/ });

async function shot(page: Page, name: string) {
  await mkdir(SCREENS, { recursive: true });
  await page.screenshot({ path: path.join(SCREENS, name) });
}

const scrollTo = (page: Page, viewports: number) => landing(page).evaluate((el, n) => { el.scrollTop = el.clientHeight * n; }, viewports);
const scrollToEnd = (page: Page) => landing(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });

async function expectInsideWidth(locator: Locator, width: number) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width);
}

const horizontalOverflow = (page: Page) => page.evaluate(() => ({ document: document.documentElement.scrollWidth, landing: document.querySelector<HTMLElement>("[data-testid=landing]")!.scrollWidth }));

test.describe("1440×900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("상단 막대에 로그인 단추 하나가 있고 로그인 창은 닫혀 있다. 스크롤하면 장이 1에서 4로 바뀌고 이어서 서버 안내가 나온다", async ({ page, scenario }) => {
    scenario.live.account = SIGNED_OUT;
    await page.goto("/");
    await expect(landing(page)).toBeVisible();
    await expect(page.getByRole("button")).toHaveCount(1);
    await expect(loginButton(page)).toHaveAttribute("aria-expanded", "false");
    await expect(loginDialog(page)).toHaveCount(0);
    await expect(story(page)).toHaveAttribute("data-step", "1");
    await expect(page.getByRole("heading", { level: 1, name: HEADINGS[0] })).toBeVisible();
    await expect(page.getByText("키움 REST API로 도는 개인 차트 워크스페이스.", { exact: true })).toBeVisible();
    await expect(serverNote(page)).not.toBeInViewport();
    await shot(page, "landing-desktop.png");

    for (const [step, viewports] of [[2, 1.125], [3, 1.875], [4, 2.625]] as const) {
      await scrollTo(page, viewports);
      await expect(story(page)).toHaveAttribute("data-step", String(step));
      await expect(loginButton(page)).toBeInViewport();
      await expect(page.getByRole("heading", { name: HEADINGS[step - 1]! })).toBeVisible();
    }
    await expect(page.locator(".landing-line")).not.toHaveCSS("stroke-dashoffset", "0px");

    await scrollTo(page, 3);
    await expect(page.locator(".landing-line")).toHaveCSS("stroke-dashoffset", "0px");
    await scrollToEnd(page);
    await expect(serverNote(page)).toBeInViewport();
    await expect(page.getByText("키움 키와 토큰, 시세, 스크리너 일봉, 재무자료")).toBeInViewport();
    await expect(loginButton(page)).toBeInViewport();

    await scrollTo(page, 0);
    await expect(story(page)).toHaveAttribute("data-step", "1");
  });

  test("로그인 단추가 창을 열고 Esc로 닫으면 초점이 단추로 돌아온다. 창 밖을 눌러도 닫힌다", async ({ page, scenario }) => {
    scenario.live.account = SIGNED_OUT;
    await page.goto("/");
    await loginButton(page).click();
    await expect(loginDialog(page)).toBeVisible();
    await expect(loginDialog(page).getByRole("heading", { name: "로그인", exact: true })).toBeVisible();
    await expect(loginButton(page)).toHaveAttribute("aria-expanded", "true");
    await shot(page, "landing-login-desktop.png");

    await page.keyboard.press("Escape");
    await expect(loginDialog(page)).toHaveCount(0);
    await expect(loginButton(page)).toHaveAttribute("aria-expanded", "false");
    await expect(loginButton(page)).toBeFocused();

    await loginButton(page).click();
    await expect(loginDialog(page)).toBeVisible();
    await page.mouse.click(300, 600);
    await expect(loginDialog(page)).toHaveCount(0);
    await expect(loginButton(page)).toHaveAttribute("aria-expanded", "false");
  });

  test("로그인 창의 네이버 단추는 provider를 보내 돌려준 주소로 이동하고 셋업을 읽지 않는다", async ({ page, scenario }) => {
    scenario.live.account = SIGNED_OUT;
    let started: unknown = null;
    await page.route("**/fake-idp/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<title>idp</title>" }));
    scenario.on(route("POST", "/api/account/login"), (request) => {
      started = request.postDataJSON();
      return { body: { url: `${new URL(request.url()).origin}/fake-idp/start?state=naver` } };
    });
    await page.goto("/");
    await loginButton(page).click();
    await loginDialog(page).getByRole("button", { name: "네이버로 로그인" }).click();
    await expect(page).toHaveURL(/\/fake-idp\/start\?state=naver$/);
    expect(started).toEqual({ provider: "naver" });
    expect(setupCalls(scenario)).toHaveLength(0);
  });

  test("이동하는 동안 두 단추가 꺼지고 이동 문장이 보인다", async ({ page, scenario }) => {
    scenario.live.account = SIGNED_OUT;
    await page.route("**/fake-idp/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<title>idp</title>" }));
    const held = scenario.hold(route("POST", "/api/account/login"));
    await page.goto("/");
    await loginButton(page).click();
    await loginDialog(page).getByRole("button", { name: "네이버로 로그인" }).click();
    await held.received;
    await expect(loginDialog(page).getByRole("button", { name: "Google로 로그인" })).toBeDisabled();
    await expect(loginDialog(page).getByRole("button", { name: "네이버로 로그인" })).toBeDisabled();
    await expect(loginDialog(page).getByRole("status")).toHaveText("네이버 로그인 화면으로 이동합니다");
    held.reply({ body: { url: `${new URL(page.url()).origin}/fake-idp/start?state=held` } });
    await expect(page).toHaveURL(/\/fake-idp\/start\?state=held$/);
  });

  test("움직임 줄이기: 고정 구간 없이 네 장이 모두 보이고 위에서 아래로 놓인다. 차트 선은 다 그려져 있다", async ({ page, scenario }) => {
    scenario.live.account = SIGNED_OUT;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await expect(landing(page)).toBeVisible();
    await expect(story(page)).toHaveCSS("position", "static");
    await expect(story(page)).not.toHaveAttribute("data-step", /.*/);
    await expect(page.locator(".landing-slide")).toHaveCount(4);
    let previousTop = -Infinity;
    for (const name of HEADINGS) {
      const heading = page.getByRole("heading", { name });
      await expect(heading).toBeVisible();
      await expect(heading.locator("xpath=..")).toHaveCSS("opacity", "1");
      const box = await heading.boundingBox();
      expect(box!.y).toBeGreaterThan(previousTop);
      previousTop = box!.y;
    }
    await expect(page.locator(".landing-line")).toHaveCSS("stroke-dashoffset", "0px");
    await expect(page.getByText("스크롤", { exact: true })).toHaveCount(0);
    await expect(page.locator(".landing-progress")).toHaveCount(0);
    await expect(loginButton(page)).toBeVisible();
    await shot(page, "landing-reduced-motion-desktop.png");
    await scrollToEnd(page);
    await expect(serverNote(page)).toBeInViewport();
    await expect(loginButton(page)).toBeInViewport();
  });
});

test.describe("390×844", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("가로 스크롤이 없고 제목과 로그인 단추, 열린 로그인 창의 단추가 화면 폭 안에 들어온다", async ({ page, scenario }) => {
    scenario.live.account = SIGNED_OUT;
    await page.goto("/");
    await expect(landing(page)).toBeVisible();
    await shot(page, "landing-phone.png");
    for (const name of HEADINGS) {
      const heading = page.getByRole("heading", { name });
      await expectInsideWidth(heading, 390);
      expect(await heading.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
    await expectInsideWidth(loginButton(page), 390);
    await loginButton(page).click();
    await expect(loginDialog(page)).toBeVisible();
    for (const name of ["Google로 로그인", "네이버로 로그인"]) await expectInsideWidth(loginDialog(page).getByRole("button", { name }), 390);
    await expectInsideWidth(loginDialog(page), 390);
    await shot(page, "landing-login-phone.png");
    const overflow = await horizontalOverflow(page);
    expect(overflow.document).toBeLessThanOrEqual(390);
    expect(overflow.landing).toBeLessThanOrEqual(390);

    await page.keyboard.press("Escape");
    await scrollToEnd(page);
    await expect(serverNote(page)).toBeInViewport();
    expect((await horizontalOverflow(page)).landing).toBeLessThanOrEqual(390);
  });

  test("움직임 줄이기도 가로 스크롤이 없다", async ({ page, scenario }) => {
    scenario.live.account = SIGNED_OUT;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await expect(story(page)).toHaveCSS("position", "static");
    for (const name of HEADINGS) await expectInsideWidth(page.getByRole("heading", { name }), 390);
    const overflow = await horizontalOverflow(page);
    expect(overflow.document).toBeLessThanOrEqual(390);
    expect(overflow.landing).toBeLessThanOrEqual(390);
    await shot(page, "landing-reduced-motion-phone.png");
  });
});

test("local_only: 랜딩이 없다", async ({ page }) => {
  await page.goto("/?symbol=005930");
  await expect(page.getByRole("region", { name: /^칸 1: / })).toHaveAttribute("aria-busy", "false");
  await expect(landing(page)).toHaveCount(0);
});
