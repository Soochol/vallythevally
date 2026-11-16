import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const collectorBinary = path.join(root, "target/debug/collector");
const rawFixtures = path.join(root, "crates/collector/tests/fixtures/raw/20260720");
const DATE = "20260720";
const KST_OFFSET_MS = 9 * 3_600_000;
const DAY_MS = 86_400_000;
const DAY_START_UNIX_MS = Date.UTC(2026, 6, 20) - KST_OFFSET_MS;
const GAP_FROM_MS = 10 * 3_600_000 + 31 * 60_000 + 10_000;
const GAP_TO_MS = GAP_FROM_MS + 20_000;
const DASH = "—";

const clock = (ms) => {
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
};
const hms = (digits) => `${digits.slice(0, 2)}:${digits.slice(2, 4)}:${digits.slice(4, 6)}`;
const absolute = (text) => Math.abs(Number(String(text ?? "").trim() || 0));
const signed = (text) => Number(String(text ?? "").trim() || 0);
const code3 = (code) => String(code).padStart(3, "0");

function readRawItems() {
  const items = [];
  const files = fs.readdirSync(rawFixtures).filter((name) => name.endsWith(".jsonl.zst")).sort();
  for (const file of files) {
    const text = zlib.zstdDecompressSync(fs.readFileSync(path.join(rawFixtures, file))).toString("utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      if (record.msg?.trnm !== "REAL") continue;
      const msOfDay = (record.recv_ms + KST_OFFSET_MS) % DAY_MS;
      for (const item of record.msg.data) items.push({ msOfDay, type: item.type, symbol: item.item, values: item.values });
    }
  }
  return items;
}

function expectations(items) {
  const members = {};
  for (const item of items.filter((entry) => entry.type === "0F")) {
    for (let slot = 1; slot <= 5; slot++) {
      for (const [codeField, nameField] of [[145 + slot, 140 + slot], [155 + slot, 150 + slot]]) {
        const code = signed(item.values[codeField]);
        const name = String(item.values[nameField] ?? "").trim();
        if (code !== 0 && name !== "") members[code3(code)] = name;
      }
    }
  }
  const lastBefore = (symbol, type, timeMs) =>
    items.filter((item) => item.symbol === symbol && item.type === type && item.msOfDay <= timeMs).at(-1);

  return {
    book(symbol, timeMs) {
      const row = lastBefore(symbol, "0D", timeMs);
      if (!row) return null;
      const level = (priceBase, qtyBase, number) => ({ price: absolute(row.values[priceBase + number]), qty: signed(row.values[qtyBase + number]) });
      const range = [...Array(10).keys()].map((index) => index + 1);
      return {
        recvMs: row.msOfDay,
        asks: range.map((number) => level(40, 60, number)),
        bids: range.map((number) => level(50, 70, number)),
        askTotal: signed(row.values["121"]),
        bidTotal: signed(row.values["125"]),
      };
    },
    trades(symbol, timeMs) {
      return items
        .filter((item) => item.symbol === symbol && item.type === "0B" && item.msOfDay <= timeMs && signed(item.values["15"]) !== 0)
        .slice(-20)
        .reverse()
        .map((item) => ({
          time: hms(String(item.values["20"])),
          price: absolute(item.values["10"]),
          qty: Math.abs(signed(item.values["15"])),
          side: signed(item.values["15"]) > 0 ? "buy" : "sell",
          venue: item.values["9081"] === "KRX" ? "KRX" : item.values["9081"] === "NXT" ? "NXT" : "",
        }));
    },
    program(symbol, timeMs) {
      const row = lastBefore(symbol, "0w", timeMs);
      if (!row) return null;
      const sellQty = signed(row.values["202"]);
      const sellAmt = signed(row.values["204"]);
      const buyQty = signed(row.values["206"]);
      const buyAmt = signed(row.values["208"]);
      return { sellQty, sellAmt, buyQty, buyAmt, netQty: buyQty - sellQty, netAmt: buyAmt - sellAmt };
    },
    brokers(symbol, timeMs) {
      const row = lastBefore(symbol, "0F", timeMs);
      if (!row) return null;
      const side = (codeBase, qtyBase) =>
        [1, 2, 3, 4, 5].map((slot) => {
          const code = signed(row.values[codeBase + slot]);
          return code === 0 ? { name: "", qty: "" } : { name: members[code3(code)] ?? code3(code), qty: signed(row.values[qtyBase + slot]) };
        });
      return { sell: side(145, 160), buy: side(155, 170) };
    },
  };
}

const readScreen = () => {
  const text = (id) => document.getElementById(id);
  const number = (node) => (node.dataset.value === "" ? "" : Number(node.dataset.value));
  const root = document.getElementById("replay");
  return {
    ready: root.dataset.ready === "true",
    cursorMs: Number(root.dataset.cursorMs),
    clock: text("clock").textContent,
    gapBanner: text("gap-banner").dataset.on,
    book: [...document.querySelectorAll("[data-book-row]")].map((row) => ({
      side: row.dataset.side,
      level: Number(row.dataset.level),
      price: row.dataset.price === "" ? "" : Number(row.dataset.price),
      qty: row.dataset.qty === "" ? "" : Number(row.dataset.qty),
      text: row.querySelector(".price").textContent,
    })),
    askTotal: number(text("book-ask-total")),
    bidTotal: number(text("book-bid-total")),
    trades: [...document.querySelectorAll("[data-trade-row]")]
      .filter((row) => row.dataset.price !== "")
      .map((row) => ({ time: row.dataset.time, price: Number(row.dataset.price), qty: Number(row.dataset.qty), side: row.dataset.side, venue: row.dataset.venue })),
    program: ["net-qty", "net-amt", "buy-qty", "buy-amt", "sell-qty", "sell-amt"].map((name) => [name, number(text(`program-${name}`)), text(`program-${name}`).textContent]),
    brokers: ["sell", "buy"].map((side) =>
      [...document.querySelectorAll(`[data-broker-row][data-side="${side}"]`)].map((row) => ({
        name: row.dataset.name,
        qty: row.dataset.qty === "" ? "" : Number(row.dataset.qty),
      })),
    ),
  };
};

function assertBook(screen, expected, label) {
  if (expected === null) {
    assert.ok(screen.book.every((row) => row.price === "" && row.qty === "" && row.text === DASH), `${label}: 호가창이 빈 값이 아니다`);
    return;
  }
  const lines = [...expected.asks.map((level, index) => ({ side: "ask", level: index + 1, ...level })).reverse(), ...expected.bids.map((level, index) => ({ side: "bid", level: index + 1, ...level }))];
  assert.equal(screen.book.length, 20, `${label}: 호가 줄 수`);
  screen.book.forEach((row, index) => {
    assert.deepEqual({ side: row.side, level: row.level, price: row.price, qty: row.qty }, lines[index], `${label}: 호가 ${row.side}${row.level}`);
  });
  assert.equal(screen.askTotal, expected.askTotal, `${label}: 매도 총잔량`);
  assert.equal(screen.bidTotal, expected.bidTotal, `${label}: 매수 총잔량`);
}

function assertFlows(screen, symbol, timeMs, expect, label) {
  assertBook(screen, expect.book(symbol, timeMs), label);
  assert.deepEqual(screen.trades, expect.trades(symbol, timeMs), `${label}: 최근 체결`);
  const program = expect.program(symbol, timeMs);
  const shown = Object.fromEntries(screen.program.map(([name, value]) => [name, value]));
  if (program === null) assert.ok(Object.values(shown).every((value) => value === ""), `${label}: 프로그램매매가 빈 값이 아니다`);
  else
    assert.deepEqual(shown, { "net-qty": program.netQty, "net-amt": program.netAmt, "buy-qty": program.buyQty, "buy-amt": program.buyAmt, "sell-qty": program.sellQty, "sell-amt": program.sellAmt }, `${label}: 프로그램매매`);
  const brokers = expect.brokers(symbol, timeMs);
  if (brokers === null) assert.ok(screen.brokers.flat().every((row) => row.name === "" && row.qty === ""), `${label}: 거래원이 빈 값이 아니다`);
  else assert.deepEqual(screen.brokers, [brokers.sell, brokers.buy], `${label}: 거래원`);
}

async function startServer(runDir) {
  const data = path.join(runDir, "data");
  fs.mkdirSync(path.join(data, "raw", DATE), { recursive: true });
  for (const file of fs.readdirSync(rawFixtures)) {
    if (file.endsWith(".zst")) fs.copyFileSync(path.join(rawFixtures, file), path.join(data, "raw", DATE, file));
  }
  const gapEvents = [
    { recv_ms: DAY_START_UNIX_MS + GAP_FROM_MS, event: "down", reason: "시험" },
    { recv_ms: DAY_START_UNIX_MS + GAP_TO_MS, event: "live" },
  ];
  fs.writeFileSync(
    path.join(data, "raw", DATE, "1030-001.jsonl.zst"),
    zlib.zstdCompressSync(Buffer.from(gapEvents.map((line) => `${JSON.stringify(line)}\n`).join(""))),
  );
  const build = spawnSync(collectorBinary, ["build", "--data", data, "--date", DATE], { encoding: "utf8" });
  fs.writeFileSync(path.join(runDir, "build.log"), build.stdout + build.stderr);
  assert.equal(build.status, 0, `collector build 실패: ${build.stderr}`);
  const server = spawn(collectorBinary, ["serve", "--data", data, "--bind", "127.0.0.1:0"], { stdio: ["ignore", "pipe", "inherit"] });
  const lines = readline.createInterface({ input: server.stdout });
  const timer = setTimeout(() => server.kill("SIGKILL"), 20_000);
  const [first] = await once(lines, "line");
  clearTimeout(timer);
  assert.match(first, /^http:\/\/127\.0\.0\.1:\d+$/, `serve의 첫 줄이 주소가 아니다: ${first}`);
  return { server, base: first };
}

const parent = path.join(root, "target/hoga-replay-tests");
fs.mkdirSync(parent, { recursive: true });
fs.mkdirSync(path.join(root, "target/t"), { recursive: true });
process.env.TMPDIR = path.join(root, "target/t");
const runDir = fs.mkdtempSync(path.join(parent, "run-"));
const result = { status: "failed", runDir, checks: {} };
let browser;
let serverProcess;
try {
  assert.ok(fs.existsSync(collectorBinary), `${collectorBinary}가 없다. 먼저 python3 scripts/dev.py cargo build -p collector를 실행한다`);
  const expect = expectations(readRawItems());
  const { server, base } = await startServer(runDir);
  serverProcess = server;
  result.base = base;

  const require = createRequire(path.join(root, "web/package.json"));
  const { chromium } = require("@playwright/test");
  browser = await chromium.launch({ headless: true, chromiumSandbox: true, timeout: 30_000 });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: "ko-KR", timezoneId: "Asia/Seoul" });
  const page = await context.newPage();

  const outsideRequests = [];
  const spanResponses = [];
  const problems = [];
  page.on("request", (request) => {
    if (!request.url().startsWith(base)) outsideRequests.push(request.url());
  });
  page.on("response", (response) => {
    if (response.url().endsWith(".hoga")) spanResponses.push({ url: response.url(), status: response.status(), encoding: response.headers()["content-encoding"] ?? null });
  });
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));

  const settle = async (timeMs) => {
    await page.waitForFunction((target) => {
      const replay = document.getElementById("replay");
      return replay.dataset.ready === "true" && Number(replay.dataset.cursorMs) === target;
    }, timeMs, { timeout: 15_000 });
    return page.evaluate(readScreen);
  };
  const open = async (item, time) => {
    await page.goto(`${base}/?date=${DATE}&item=${item}&t=${time}`);
  };

  const check = async (name, work) => {
    try {
      result.checks[name] = { status: "passed", ...(await work()) };
    } catch (error) {
      result.checks[name] = { status: "failed", message: String(error.message ?? error) };
      throw error;
    }
  };

  await check("book-1958", async () => {
    const timeMs = 19 * 3_600_000 + 58 * 60_000;
    await open("005930_NX", "19:58:00.000");
    const screen = await settle(timeMs);
    const expected = expect.book("005930_NX", timeMs);
    assert.ok(expected, "기대 호가가 없다");
    assertBook(screen, expected, "19:58:00.000");
    assert.equal(screen.clock, "19:58:00.000");
    const shot = path.join(runDir, "book-1958.png");
    await page.screenshot({ path: shot, fullPage: true });
    return { screenshot: shot, expectedRecvMs: expected.recvMs };
  });

  await check("book-next-span", async () => {
    const timeMs = 20 * 3_600_000 + 300;
    await open("005930_NX", "20:00:00.300");
    const screen = await settle(timeMs);
    const expected = expect.book("005930_NX", timeMs);
    assert.ok(expected, "기대 호가가 없다");
    assert.ok(expected.recvMs >= 20 * 3_600_000, `이월 행 뒤의 새 행이 아니다: ${clock(expected.recvMs)}`);
    assertBook(screen, expected, "20:00:00.300");
    return { expectedRecvMs: expected.recvMs };
  });

  await check("flows-1030", async () => {
    const timeMs = 10 * 3_600_000 + 30 * 60_000 + 30_000;
    await open("005930", "10:30:30.000");
    const screen = await settle(timeMs);
    assertFlows(screen, "005930", timeMs, expect, "10:30:30.000");
    assert.ok(screen.trades.length > 0, "체결이 하나도 없다");
    const shot = path.join(runDir, "flows-1030.png");
    await page.screenshot({ path: shot, fullPage: true });
    return { screenshot: shot, trades: screen.trades.length };
  });

  await check("keyboard-moves-the-cursor", async () => {
    let cursor = 10 * 3_600_000 + 30 * 60_000 + 30_000;
    await page.locator("#bar").focus();
    const steps = [["ArrowRight", 1000], ["Shift+ArrowRight", 10_000], ["ArrowLeft", -1000], ["PageDown", -60_000], ["PageUp", 60_000]];
    const visited = [];
    for (const [key, delta] of steps) {
      await page.keyboard.press(key);
      cursor += delta;
      const screen = await settle(cursor);
      assertFlows(screen, "005930", cursor, expect, `${key} → ${clock(cursor)}`);
      assert.equal(screen.clock, clock(cursor));
      visited.push(clock(cursor));
    }
    return { visited };
  });

  await check("cursor-exactly-on-a-row-time", async () => {
    const expected = expect.book("005930_NX", 19 * 3_600_000 + 58 * 60_000);
    await open("005930_NX", clock(expected.recvMs));
    const screen = await settle(expected.recvMs);
    assertBook(screen, expected, `행 시각 ${clock(expected.recvMs)}`);
    const before = expect.book("005930_NX", expected.recvMs - 1);
    assert.notDeepEqual(before, expected, "바로 앞 시각의 호가가 같아 시험이 구분하지 못한다");
    return { rowTime: clock(expected.recvMs) };
  });

  await check("trades-continue-from-the-earlier-span", async () => {
    const timeMs = 10 * 3_600_000 + 30 * 60_000;
    await open("005930", "10:30:00.000");
    const screen = await settle(timeMs);
    assertFlows(screen, "005930", timeMs, expect, "10:30:00.000");
    assert.equal(screen.trades.length, 20, "앞 구간의 체결이 이어지지 않았다");
    return { trades: screen.trades.length };
  });

  await check("home-and-end-keys", async () => {
    await open("005930", "10:30:30.000");
    await settle(10 * 3_600_000 + 30 * 60_000 + 30_000);
    await page.locator("#bar").focus();
    const first = 10 * 3_600_000 + 25 * 60_000;
    const last = 10 * 3_600_000 + 35 * 60_000 - 1;
    await page.keyboard.press("Home");
    assertFlows(await settle(first), "005930", first, expect, "Home");
    await page.keyboard.press("End");
    assertFlows(await settle(last), "005930", last, expect, "End");
    return { first: clock(first), last: clock(last) };
  });

  await check("playback-10x", async () => {
    const startMs = 10 * 3_600_000 + 30 * 60_000;
    await open("005930", "10:30:00.000");
    await settle(startMs);
    await page.selectOption("#speed", "10");
    await page.click("#play");
    await page.waitForTimeout(1000);
    await page.click("#play");
    assert.equal(await page.locator("#play").getAttribute("data-playing"), "false", "멈추지 않았다");
    await page.waitForFunction(() => document.getElementById("replay").dataset.ready === "true", null, { timeout: 15_000 });
    const finalCursor = Number(await page.locator("#replay").getAttribute("data-cursor-ms"));
    const advanced = finalCursor - startMs;
    assert.ok(advanced >= 5000 && advanced <= 15_000, `커서가 ${advanced}ms 움직였다 (5000~15000 기대)`);
    const screen = await settle(finalCursor);
    assertFlows(screen, "005930", finalCursor, expect, `재생 뒤 ${clock(finalCursor)}`);
    const frameStat = await page.locator("#frame-stat").textContent();
    return { advancedMs: advanced, finalCursor: clock(finalCursor), frameStat };
  });

  await check("collection-gap", async () => {
    const gapBannerAt = async (timeMs) => {
      await open("005930", clock(timeMs));
      return (await settle(timeMs)).gapBanner;
    };
    assert.equal(await gapBannerAt(GAP_FROM_MS - 1), "false", "끊김 시작 직전");
    assert.equal(await gapBannerAt(GAP_FROM_MS), "true", "끊김 시작 시각");
    assert.equal(await gapBannerAt(GAP_FROM_MS + 10_000), "true", "끊김 안");
    assert.equal(await gapBannerAt(GAP_TO_MS - 1), "true", "끊김 끝 직전");
    assert.equal(await gapBannerAt(GAP_TO_MS), "false", "끊김 끝 시각");
    await open("005930", clock(GAP_FROM_MS + 10_000));
    await settle(GAP_FROM_MS + 10_000);
    await page.waitForFunction(() => document.querySelectorAll(".bar-gap").length > 0, null, { timeout: 15_000 });
    const shot = path.join(runDir, "gap-1031.png");
    await page.screenshot({ path: shot, fullPage: true });
    return { screenshot: shot };
  });

  await check("network-and-console", async () => {
    assert.deepEqual(outsideRequests, [], "띄운 주소 밖으로 요청이 나갔다");
    assert.ok(spanResponses.length > 0, "구간 파일 응답이 없다");
    for (const response of spanResponses) {
      assert.equal(response.status, 200, response.url);
      assert.equal(response.encoding, "br", `content-encoding: ${response.url}`);
    }
    assert.deepEqual(problems, [], "콘솔·페이지 오류가 있다");
    return { spanResponses: spanResponses.length };
  });

  result.status = "passed";
} catch (error) {
  result.error = String(error?.stack ?? error);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill("SIGTERM");
    await Promise.race([once(serverProcess, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
    if (serverProcess.exitCode === null) serverProcess.kill("SIGKILL");
  }
  fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ status: result.status, runDir, result: path.join(runDir, "result.json"), error: result.error }));
  process.exitCode = result.status === "passed" ? 0 : 1;
}
