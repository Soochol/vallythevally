import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { installDartDisplay } from './dart-ui.mjs';

const [mode, root, destination, base, headed] = process.argv.slice(2);
const result = { status: 'failed', checks: {} };
let browser;
try {
  let playwright;
  try {
    const require = createRequire(path.join(root, 'web/package.json'));
    playwright = require('@playwright/test');
    result.checks.playwright = { status: 'available' };
  } catch {
    result.checks.playwright = { status: 'missing' };
    throw new Error('playwright_missing');
  }
  const { chromium, expect } = playwright;
  const executable = chromium.executablePath();
  result.checks.browser = { status: fs.existsSync(executable) ? 'available' : 'missing', executable };
  if (!fs.existsSync(executable)) throw new Error('browser_missing');
  const modes = mode === 'doctor' ? (headed === 'yes' ? [true, false] : [true]) : [headed !== 'yes'];
  for (const headless of modes) {
    const name = headless ? 'headless' : 'headed';
    if (!headless && !process.env.DISPLAY && process.platform === 'linux') {
      result.checks[name] = { status: 'display_missing' };
      continue;
    }
    try {
      browser = await chromium.launch({ headless, chromiumSandbox: true, timeout: 15000 });
      const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
      const page = await context.newPage();
      await page.setContent('<p>Chromium ready</p>');
      await expect(page.locator('p')).toHaveText('Chromium ready');
      result.checks[name] = { status: 'passed', version: browser.version() };
      if (mode === 'ui') {
        const verifyDisplay = await installDartDisplay(context, base);
        result.phase = 'navigation';
        await page.goto(base + '/?symbol=005930&period=Y');
        result.phase = 'chart';
        const cell = page.getByRole('region', { name: /^칸 1: / });
        await expect(cell).toHaveAttribute('aria-busy', 'false', { timeout: 45000 });
        await expect.poll(async () => Number(await cell.locator('[data-bar-count]').getAttribute('data-bar-count')), { timeout: 45000 }).toBeGreaterThan(0);
        result.phase = 'indicator';
        await page.getByRole('button', { name: /^지표/ }).first().click();
        const dialog = page.getByRole('dialog');
        const row = page.locator('[data-indicator-row]').filter({ hasText: /^매출액/ });
        if (await row.count() === 0) {
          await dialog.getByRole('option', { name: /^매출액/ }).click();
          await dialog.getByRole('button', { name: '매출액 추가', exact: true }).click();
        }
        await dialog.getByRole('button', { name: '입력창 닫기', exact: true }).click();
        await expect(row).toContainText('확인 완료', { timeout: 30000 });
        result.phase = 'detail';
        const summary = row.locator('summary');
        await summary.first().click();
        const point = JSON.parse(fs.readFileSync(path.join(destination, 'api.json'), 'utf8')).series.find(s => s.metric === 'revenue').points.filter(p => p.status === 'available' && p.value !== null).at(-1);
        const select = row.getByRole('combobox').first();
        const name = await select.getAttribute('aria-label');
        await select.click();
        const menu = page.getByRole('menu', name ? { name, exact: true } : {});
        await menu.getByRole('menuitemradio').filter({ hasText: new RegExp(`^${point.businessYear} /`) }).first().click();
        result.phase = 'compare';
        const value = point.value.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
        await expect(row).toContainText(`표시값 ${value}`);
        verifyDisplay();
        result.phase = 'complete';
        result.ui = { metric: 'revenue', year: point.businessYear, value: point.value, displayed: await row.innerText(), screenshot: path.join(destination, 'financials.png') };
        await page.screenshot({ path: result.ui.screenshot, fullPage: true });
      }
      await browser.close();
      browser = undefined;
    } catch {
      result.checks[name] = { status: 'launch_or_page_failed' };
      result.failure = mode === 'ui' ? 'ui_failed' : 'chromium_launch_failed';
      if (browser) await browser.close().catch(() => {});
      browser = undefined;
    }
  }
  result.status = Object.values(result.checks).every(c => ['passed', 'available'].includes(c.status)) ? 'passed' : 'failed';
} catch (error) {
  result.failure = ['playwright_missing', 'browser_missing', 'ui_failed', 'chromium_launch_failed'].includes(error.message) ? error.message : 'probe_failed';
} finally {
  if (browser) await browser.close().catch(() => {});
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, mode === 'ui' ? 'browser.json' : 'chromium.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  process.exitCode = result.status === 'passed' ? 0 : 1;
}
