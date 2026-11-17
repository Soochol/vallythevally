#!/usr/bin/env node
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const { chromium, expect } = createRequire(join(root, "web/package.json"))("@playwright/test");
const [baseURL, evidence, journey] = process.argv.slice(2);
if (!baseURL || !evidence || !journey) throw new Error("usage: drive.mjs <base-url> <evidence-dir> <journey>");
mkdirSync(evidence, { recursive: true });

let tag = journey;
const taken = (t) => readdirSync(evidence).some((f) => f.startsWith(`${t}.`) || f.startsWith(`${t}-0`) || f === `${t}-failure.png`);
for (let n = 2; taken(tag); n++) tag = `${journey}-${n}`;
const shot = (name) => join(evidence, `${tag}-${name}`);
const SEARCH_BUTTON_TITLE = "종목 검색 (/ 또는 Ctrl+K)";
const runState = (() => {
  try {
    return JSON.parse(readFileSync(join(dirname(resolve(evidence)), "state.json"), "utf8"));
  } catch {
    return {};
  }
})();
const SECRET_QUERY_KEYS = ["code", "state", "code_challenge", "nonce", "token"];
const SETUP_PATHS = ["/api/layouts", "/api/watchlists", "/api/ui-state", "/api/setup"];
const redacted = (u) => {
  const query = new URLSearchParams(u.search);
  for (const key of SECRET_QUERY_KEYS) if (query.has(key)) query.set(key, "…");
  const text = query.toString();
  return u.pathname + (text ? `?${text}` : "");
};
const journeys = {
  async "search-chart"(page, log) {
    await page.goto("/");
    const cell = page.getByRole("region", { name: /^칸 1: / });
    await cell.waitFor();
    await expect(cell).toHaveAttribute("aria-busy", "false");
    log("opened", await cell.getAttribute("aria-label"));
    await expect(cell).toHaveAttribute("aria-label", /^칸 1: 코스피 /);
    await page.getByTitle(SEARCH_BUTTON_TITLE).click();
    const dialog = page.getByRole("dialog", { name: "종목 검색" });
    await dialog.getByRole("combobox", { name: "종목 검색" }).fill("삼성전자");
    const option = dialog.getByRole("option").filter({ hasText: "005930" }).first();
    await option.waitFor();
    await page.screenshot({ path: shot("01-search-results.png") });
    await option.click();
    await expect(cell).toHaveAttribute("aria-label", /삼성전자/);
    await expect(cell).toHaveAttribute("aria-busy", "false");
    const chart = cell.locator("[data-bar-count]");
    await expect(chart).not.toHaveAttribute("data-bar-count", "0");
    const bars = Number(await chart.getAttribute("data-bar-count"));
    log("chart", { label: await cell.getAttribute("aria-label"), bars, firstBarT: await chart.getAttribute("data-first-bar-t") });
    await page.screenshot({ path: shot("02-chart-after-search.png") });
    if (!(bars > 0)) throw new Error("no bars rendered");
    const uiState = await (await page.request.get("/api/ui-state")).json();
    log("server ui-state after search", uiState);
    return { label: await cell.getAttribute("aria-label"), bars };
  },
  async "watchlist-add"(page, log) {
    await page.goto("/");
    const panel = page.getByRole("complementary", { name: "관심종목" });
    await expect(panel.getByRole("button", { name: /^관심종목 목록: / })).toHaveAccessibleName("관심종목 목록: 기본");
    await expect(panel.locator("li[data-code]")).toHaveCount(0);
    await page.screenshot({ path: shot("01-watchlist-empty.png") });
    await panel.getByRole("button", { name: "관심종목에 넣기" }).click();
    const dialog = page.getByRole("dialog", { name: "관심종목에 넣을 종목 검색" });
    await dialog.getByRole("combobox", { name: "종목 검색" }).fill("삼성전자");
    await dialog.getByRole("option").filter({ hasText: "005930" }).first().click();
    await expect(panel.locator('li[data-code="005930"]')).toBeVisible();
    await page.screenshot({ path: shot("02-watchlist-added.png") });
    await expect.poll(async () => JSON.stringify(await (await page.request.get("/api/watchlists")).json())).toContain("005930");
    await page.reload();
    await expect(page.getByRole("complementary", { name: "관심종목" }).locator('li[data-code="005930"]')).toBeVisible();
    const stored = await (await page.request.get("/api/watchlists")).json();
    log("server watchlists after reload", stored);
    await page.screenshot({ path: shot("03-watchlist-after-reload.png") });
    return { codes: ["005930"] };
  },
  async "account-login"(page, log) {
    if (runState.mode !== "account") throw new Error("account-login needs a run started with `vv.py up --account`");
    const connectorHost = new URL(baseURL).host;
    const accountHost = new URL(runState.account_url).host;
    const idpHost = new URL(runState.idp_url).host;
    const landing = page.getByTestId("landing");
    const story = page.getByRole("region", { name: "스크롤 이야기" });
    const accountStatus = async () => (await page.request.get("/api/account")).json();
    const modeOf = (path) => (statSync(path).mode & 0o777).toString(8);
    const tokenRows = async (token) => {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(runState.account_db_path, { readOnly: true });
      try {
        return db.prepare("SELECT count(*) AS n FROM connector_tokens WHERE token_hash = ?").get(createHash("sha256").update(token).digest()).n;
      } finally {
        db.close();
      }
    };
    const savedToken = () => JSON.parse(readFileSync(runState.account_state_path, "utf8")).token;
    const hopsOf = (provider, from) => {
      const found = (match) => {
        const index = requests.slice(from).findIndex(match);
        return index < 0 ? index : index + from;
      };
      const hop = (host, path, status) => found((r) => r.host === host && r.path.startsWith(path) && r.status === status);
      const hops = [
        ["connector POST /api/account/login", found((r) => r.host === connectorHost && r.method === "POST" && r.path === "/api/account/login" && r.status === 200)],
        [`account server /v1/auth/${provider}/start`, hop(accountHost, `/v1/auth/${provider}/start`, 302)],
        [`fake IdP /${provider}/authorize`, hop(idpHost, `/${provider}/authorize`, 302)],
        [`account server /v1/auth/${provider}/callback`, hop(accountHost, `/v1/auth/${provider}/callback`, 302)],
        ["connector /auth/complete", hop(connectorHost, "/auth/complete", 302)],
      ];
      const missing = hops.filter(([, index]) => index < 0).map(([name]) => name);
      if (missing.length) throw new Error(`login path is missing hops: ${missing.join(", ")}`);
      const order = hops.map(([, index]) => index);
      if (order.some((index, i) => i > 0 && index < order[i - 1])) throw new Error(`login hops happened out of order: ${order}`);
      return hops.map(([name]) => name);
    };
    const logIn = async (provider, name) => {
      const from = requests.length;
      await landing.getByRole("button", { name: "로그인", exact: true }).click();
      const popover = page.getByRole("dialog", { name: "로그인", exact: true });
      await expect(popover).toBeVisible();
      if (provider === "google") await page.screenshot({ path: shot("02-login-popover.png") });
      const complete = page.waitForResponse((r) => new URL(r.url()).host === connectorHost && new URL(r.url()).pathname === "/auth/complete");
      await popover.getByRole("button", { name: `${name}로 로그인` }).click();
      await complete;
      return hopsOf(provider, from);
    };

    await page.goto("/");
    await expect(landing).toBeVisible();
    await expect(story).toHaveAttribute("data-step", "1");
    await page.screenshot({ path: shot("01-landing.png") });
    const stepsSeen = new Set(["1"]);
    await page.mouse.move(720, 450);
    await expect.poll(async () => {
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(100);
      const step = await story.getAttribute("data-step");
      stepsSeen.add(step);
      return step;
    }, { timeout: 30000, intervals: [100] }).toBe("4");
    const setupRequests = requests.filter((r) => SETUP_PATHS.some((path) => r.path.startsWith(path)));
    expect(setupRequests).toHaveLength(0);
    log("step 1 landing is shown, no setup requests, story reached step 4", { stepsSeen: [...stepsSeen], accountStatus: await accountStatus() });

    const googleHops = await logIn("google", "Google");
    await expect.poll(accountStatus).toMatchObject({ state: "signed_in", provider: "google" });
    const wizard = page.getByRole("dialog", { name: "처음 설정", exact: true });
    const settings = page.getByRole("dialog", { name: "시스템 설정", exact: true });
    const openAccountMenu = async () => {
      await page.getByRole("button", { name: "시스템 설정", exact: true }).click();
      await settings.getByRole("tab", { name: "계정", exact: true }).click();
      return settings.getByRole("tabpanel");
    };
    await expect(wizard).toBeVisible({ timeout: 5000 });
    await page.screenshot({ path: shot("03-signed-in-wizard.png") });
    log("step 2 google login passed account server and fake IdP, ended signed_in, and the first-run wizard opens", { hops: googleHops, provider: "google", wizardAutoOpened: true });

    const token = savedToken();
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(modeOf(runState.account_state_path)).toBe("600");
    expect(modeOf(dirname(runState.account_state_path))).toBe("700");
    expect(await tokenRows(token)).toBe(1);
    log("step 3 state file exists with mode 600 in a 700 folder, account server holds the token row", { fileMode: modeOf(runState.account_state_path), folderMode: modeOf(dirname(runState.account_state_path)), tokenRowsInAccountDb: 1 });

    await wizard.getByRole("button", { name: "닫기" }).click();
    await expect(wizard).toHaveCount(0);
    const panel = await openAccountMenu();
    await expect(panel.getByText("Google", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "로그아웃", exact: true }).click();
    await expect(landing).toBeVisible();
    await page.screenshot({ path: shot("04-landing-after-logout.png") });
    await expect.poll(accountStatus).toEqual({ state: "signed_out" });
    await expect.poll(() => tokenRows(token)).toBe(0);
    expect(existsSync(runState.account_state_path)).toBe(false);
    log("step 4 logout from the account menu returned to the landing, state file removed, token row gone from the account DB", { accountStatus: await accountStatus(), tokenRowsInAccountDb: await tokenRows(token) });

    const naverHops = await logIn("naver", "네이버");
    await expect.poll(async () => (await accountStatus()).state).not.toBe("signed_out");
    const naverStatus = await accountStatus();
    const naverToken = savedToken();
    expect(await tokenRows(naverToken)).toBe(1);
    expect(naverStatus).toMatchObject({ state: "owner_mismatch", provider: "naver" });
    await expect(page.getByRole("main", { name: "계정 바꾸기 확인" })).toBeVisible();
    await page.screenshot({ path: shot("05-owner-mismatch-after-naver.png") });
    log("step 5 naver login passed the same path; the local setup belongs to the Google account so the connector reports owner_mismatch and the replace-local screen opens", { hops: naverHops, state: naverStatus.state, provider: naverStatus.provider, tokenRowsInAccountDb: 1 });

    const evidenceText = JSON.stringify({ steps, requests });
    if (evidenceText.includes(token) || evidenceText.includes(naverToken)) throw new Error("a connector token leaked into the evidence");
    return { providers: ["google", "naver"], finalState: naverStatus.state, wizardAutoOpened: true };
  },
};
if (!journeys[journey]) throw new Error(`unknown journey ${journey}; have ${Object.keys(journeys)}`);

const tmp = join(root, "target/t");
mkdirSync(tmp, { recursive: true });
const browser = await chromium.launch({ env: { ...process.env, TMPDIR: tmp }, chromiumSandbox: true });
const context = await browser.newContext({ baseURL, locale: "ko-KR", timezoneId: "Asia/Seoul", viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
const page = await context.newPage();
const requests = [];
const hosts = new Set();
const consoleErrors = [];
const steps = [];
page.on("request", (r) => hosts.add(new URL(r.url()).host));
page.on("websocket", (w) => hosts.add(new URL(w.url()).host));
page.on("response", (r) => { const u = new URL(r.url()); requests.push({ status: r.status(), method: r.request().method(), host: u.host, path: redacted(u) }); });
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));
const log = (...a) => { steps.push(a); console.log("drive:", ...a.map((x) => (typeof x === "string" ? x : JSON.stringify(x)))); };
let outcome = { journey, ok: false };
try {
  const result = await journeys[journey](page, log);
  outcome = { journey, ok: true, result };
} catch (e) {
  outcome = { journey, ok: false, error: String(e) };
  await page.screenshot({ path: shot("failure.png") }).catch(() => {});
} finally {
  const allowed = new Set([new URL(baseURL).host, ...(runState.mode === "account" ? [new URL(runState.account_url).host, new URL(runState.idp_url).host] : [])]);
  const foreignHosts = [...hosts].filter((h) => !allowed.has(h) && h !== "");
  if (outcome.ok && (consoleErrors.length || foreignHosts.length)) outcome = { ...outcome, ok: false, error: `consoleErrors=${consoleErrors.length} foreignHosts=${foreignHosts.join(",")}` };
  writeFileSync(join(evidence, `${tag}.json`), JSON.stringify({ ...outcome, baseURL, steps, requests, foreignHosts, consoleErrors }, null, 1));
  await browser.close();
}
console.log(JSON.stringify(outcome));
process.exit(outcome.ok ? 0 : 1);
