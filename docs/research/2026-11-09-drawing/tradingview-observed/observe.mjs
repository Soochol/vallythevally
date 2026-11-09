import { createRequire } from "node:module";
import { writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(process.argv[2], "package.json"));
const { chromium } = require("@playwright/test");
const browser = await chromium.launch({ chromiumSandbox: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 850 }, locale: "en-US" });
const log = join(here, "steps.log");
writeFileSync(log, `${new Date().toISOString()} tradingview.com/chart NASDAQ:AAPL 1D, not logged in, headless Chromium 1400x850\n`);
const note = (s) => appendFileSync(log, `${s}\n`);
const shot = async (name) => { await page.waitForTimeout(700); await page.screenshot({ path: join(here, `${name}.png`) }); note(`shot ${name}`); };
const m = page.mouse;

await page.goto("https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(12000);
await m.click(700, 650);
await page.keyboard.press("Escape");

note("A: Alt+T, click (250,620), move to (550,450) without button");
await page.keyboard.press("Alt+T");
await m.move(250, 620); await m.down(); await m.up();
await m.move(550, 450, { steps: 15 });
await shot("01-trend-after-first-click-moving");
await m.down(); await m.up();
await m.move(800, 700, { steps: 5 });
await shot("02-trend-after-second-click");

note("B: Alt+T then press-drag (300,700)->(650,560)");
await page.keyboard.press("Escape");
await page.keyboard.press("Alt+T");
await m.move(300, 700); await m.down();
await m.move(650, 560, { steps: 20 });
await shot("03-trend-press-drag-holding");
await m.up();
await m.move(820, 720, { steps: 5 });
await shot("04-trend-press-drag-released");

note("C: Alt+T, click (150,300), Shift held, click (450,280)");
await page.keyboard.press("Escape");
await page.keyboard.press("Alt+T");
await m.move(150, 300); await m.down(); await m.up();
await page.keyboard.down("Shift");
await m.move(450, 280, { steps: 15 });
await shot("05-trend-shift-preview");
await m.down(); await m.up();
await page.keyboard.up("Shift");
await shot("06-trend-shift-done");

note("D: select first trend line by clicking its middle (400,535)");
await page.keyboard.press("Escape");
await m.move(400, 535, { steps: 5 });
await shot("07-hover-trend");
await m.down(); await m.up();
await shot("08-trend-selected");

note("E: Ctrl+drag the selected trend line body down 120px");
await page.keyboard.down("Control");
await m.move(400, 535); await m.down();
await m.move(400, 655, { steps: 15 });
await m.up();
await page.keyboard.up("Control");
await shot("09-after-ctrl-drag");

note("F: Ctrl+Z");
await page.keyboard.press("Control+Z");
await shot("10-after-undo");

note("G: Alt+H click (600,250)");
await page.keyboard.press("Escape");
await page.keyboard.press("Alt+H");
await m.move(600, 250); await m.down(); await m.up();
await shot("11-hline");

note("H: Alt+Shift+R rectangle click (650,150) click (850,230)");
await page.keyboard.press("Escape");
await page.keyboard.press("Alt+Shift+R");
await m.move(650, 150); await m.down(); await m.up();
await m.move(850, 230, { steps: 10 });
await m.down(); await m.up();
await shot("12-rect");

note("I: Alt+F fib click (120,680) click (500,200)");
await page.keyboard.press("Escape");
await page.keyboard.press("Alt+F");
await m.move(120, 680); await m.down(); await m.up();
await m.move(500, 200, { steps: 10 });
await m.down(); await m.up();
await shot("13-fib");

note("J: right-click on rectangle border (650,190)");
await page.keyboard.press("Escape");
await m.click(650, 190, { button: "right" });
await shot("14-context-menu");
await page.keyboard.press("Escape");

await browser.close();
