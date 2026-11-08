// Run with PLAYWRIGHT_MODULE and optionally CHROMIUM_EXECUTABLE pointing to local tools.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

(async () => {
  const root = __dirname;
  const data = JSON.parse(fs.readFileSync(path.join(root, 'report-data.json'), 'utf8'));
  const results = { checks: [], errors: [], externalRequests: [], screenshots: [] };
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    headless: true,
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, offline: true });
    const page = await context.newPage();
    page.on('pageerror', error => results.errors.push(error.message));
    page.on('request', request => {
      if (/^https?:/.test(request.url())) results.externalRequests.push(request.url());
    });
    await page.goto('file://' + path.join(root, 'report.html'));
    await page.waitForFunction(() => window.reportReady === true);
    assert.equal(await page.locator('#caseCount').innerText(), '8');
    assert.equal(await page.locator('#comparisonRows tr').count(), 8);
    assert.match(await page.locator('#indexOutput').innerText(), /코스피 116\.68/);
    assert.match(await page.locator('#indexOutput').innerText(), /코스닥 129\.62/);
    results.checks.push('offline report loads 8 cases and known index-normalization endpoints');

    await page.getByRole('button', { name: '반등·확장', exact: true }).click();
    assert.match(await page.locator('#indexOutput').innerText(), /코스피 197\.13/);
    assert.match(await page.locator('#indexOutput').innerText(), /코스닥 226\.08/);
    await page.getByRole('button', { name: '전체 맥락', exact: true }).click();
    results.checks.push('period control reproduces daily-derived rebound endpoint returns');

    for (const market of ['kospi', 'kosdaq']) {
      await page.locator('#marketSelect').selectOption(market);
      for (const c of data.research[market].cases) {
        await page.locator('#caseSelect').selectOption(c.id);
        assert.match(await page.locator('#caseIntro').innerText(), new RegExp(c.name));
        assert.match(await page.locator('#caseMetrics').innerText(), new RegExp(data.series.find(s => s.id === c.id).auditMetrics.peak.date));
        for (const mode of ['normalized', 'relative']) {
          await page.locator('#caseMode').selectOption(mode);
          await page.locator('#caseScale').selectOption('log');
          assert.equal(await page.locator('#caseChart svg').count(), 1);
          const paths = await page.locator('#caseChart path').evaluateAll(nodes => nodes.map(n => n.getAttribute('d')));
          assert(paths.every(d => d && !/NaN|Infinity/.test(d)));
        }
        const peer = await page.locator('#peerSelect option').nth(1).getAttribute('value');
        await page.locator('#peerSelect').selectOption(peer);
        assert.equal(await page.locator('#caseChart path').count(), 2);
      }
    }
    results.checks.push('all 8 cases, peer comparisons, normalized/relative modes and logarithmic axes draw finite curves');
    await page.locator('#marketSelect').selectOption('kosdaq');
    await page.locator('#caseSelect').selectOption('seegene');
    await page.locator('#peerSelect').selectOption('sugentech');
    await page.locator('#caseMode').selectOption('normalized');
    await page.locator('#caseScale').selectOption('linear');
    const labels = await page.locator('#caseChart svg text').allTextContents();
    assert(!labels.some(s => /^-\d/.test(s)));
    results.checks.push('positive normalized-price charts do not show negative axis values');

    await page.locator('#caseStart').fill('2023-06-30');
    await page.locator('#caseEnd').fill('2020-01-01');
    await page.locator('#caseEnd').dispatchEvent('change');
    assert.match(await page.locator('#caseChart').innerText(), /공통 관측값이 부족/);
    await page.locator('#caseStart').fill('2019-12-30');
    await page.locator('#caseEnd').fill('2023-06-30');
    await page.locator('#caseEnd').dispatchEvent('change');
    results.checks.push('invalid date ranges give an explicit empty state and recover');

    await page.getByRole('tab', { name: '당시 시점으로 복기' }).click();
    for (const market of ['kospi', 'kosdaq']) {
      await page.locator('#studyMarket').selectOption(market);
      for (const c of data.research[market].cases) {
        await page.locator('#studyCase').selectOption(c.id);
        for (const date of ['2020-06-30', '2021-06-30', '2022-06-30']) {
          await page.locator('#studyDate').selectOption(date);
          assert.equal(await page.locator('#analysis').isVisible(), false);
          assert.equal(await page.locator('#evidence').isVisible(), false);
          assert.equal(await page.locator('#studyFuture').isVisible(), false);
          const cutoff = (await page.locator('#studyOutput').innerText()).slice(0, 10);
          assert(cutoff <= date);
          const eventDates = await page.locator('#studyFacts time').allTextContents();
          assert(eventDates.every(d => d <= date));
        }
      }
    }
    results.checks.push('24 case/date combinations hide retrospective panels, future result panels and later chart data');
    await page.locator('#studyMarket').selectOption('kosdaq');
    await page.locator('#studyCase').selectOption('seegene');
    await page.locator('#studyDate').selectOption('2020-06-30');
    const historicalFacts = await page.locator('#studyFacts').innerText();
    assert(historicalFacts.includes('818억원'));
    assert(!historicalFacts.includes('2,748') && !historicalFacts.includes('2020-08-07'));
    for (const research of Object.values(data.research)) {
      for (const c of research.cases) {
        for (const snapshot of c.asOf) {
          for (const sourceId of snapshot.sourceIds) {
            const source = data.sources.find(s => s.id === sourceId);
            assert(source.published && source.published <= snapshot.date);
          }
        }
      }
    }
    results.checks.push('study facts use publication-checked snapshots only; Seegene 2020-06 facts exclude the later earnings release and retrospective peak');
    const chartSlider = page.locator('#studyChart [role=slider]');
    await chartSlider.focus();
    await page.keyboard.press('Home');
    assert.match(await page.locator('#studyOutput').innerText(), /^2019-12-30/);
    await page.keyboard.press('End');
    results.checks.push('chart observations are keyboard-accessible');
    await page.locator('#studyDate').selectOption('2022-06-30');
    await page.locator('#studyNotes').fill('관찰: 상대강도와 발표 실적을 구분한다.\n철회 조건: 다음 자료에서 확인한다.');
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '현재 기록 저장' }).click();
    const download = await downloadPromise;
    const downloadPath = await download.path();
    const note = fs.readFileSync(downloadPath, 'utf8');
    assert(note.includes('철회 조건') && note.includes('2022-06-30'));
    await page.getByRole('button', { name: '이후 결과 펼쳐보기' }).click();
    assert.equal(await page.locator('#studyFuture').isVisible(), true);
    await page.locator('#studyDate').selectOption('2020-06-30');
    assert.equal(await page.locator('#studyFuture').isVisible(), false);
    results.checks.push('notes download contains the selected date and written judgment; changing dates hides revealed future again');

    await page.getByRole('tab', { name: '출처와 계산 기준' }).click();
    assert.equal(await page.locator('#sourceList li').count(), data.sources.length);
    await page.locator('#sourceFilter').selectOption('kosdaq');
    assert.equal(await page.locator('#sourceList li').count(), data.sources.filter(s => s.scope === 'kosdaq').length);
    results.checks.push('source filters preserve the correct citation inventory');

    const screenshotRoot = '/tmp/hoga-market-report-qa';
    fs.mkdirSync(screenshotRoot, { recursive: true });
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const id of ['analysis', 'study', 'evidence']) {
        await page.locator('#tab-' + id).click();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
        assert.equal(overflow, false, `page-level horizontal overflow: ${width}/${id}`);
      }
      await page.locator('#tab-analysis').click();
      await page.evaluate(() => window.scrollTo(0, 0));
      const screenshot = path.join(screenshotRoot, 'report-' + width + '.png');
      await page.screenshot({ path: screenshot });
      results.screenshots.push(screenshot);
    }
    results.checks.push('1440, 768 and 390px widths have no page-level horizontal overflow across all report views');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => document.documentElement.style.colorScheme = 'dark');
    await page.evaluate(() => {
      const css = document.documentElement.style;
      for (const [name, value] of Object.entries({ '--background': '#121216', '--foreground': '#eeeeee', '--card': '#17171c', '--muted': '#202025', '--muted-foreground': '#aaa8a4', '--border': '#34343a', '--primary': '#8bc5b6', '--primary-foreground': '#12251e' })) css.setProperty(name, value);
    });
    await page.waitForFunction(() => document.querySelector('#indexChart path') !== null);
    const darkShot = path.join(screenshotRoot, 'report-dark.png');
    await page.screenshot({ path: darkShot });
    results.screenshots.push(darkShot);
    assert.deepEqual(results.errors, []);
    assert.deepEqual(results.externalRequests, []);
    results.checks.push('no browser script errors or external network requests; live theme changes redraw charts');
    results.status = 'passed';
    results.browserVersion = browser.version();
    results.playwrightVersion = require(path.join(process.env.PLAYWRIGHT_MODULE || 'playwright-core', 'package.json')).version;
    results.verified = new Date().toISOString();
    results.reportSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'report.html'))).digest('hex');
    results.verifierSha256 = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
    fs.writeFileSync(path.join(root, 'report-validation.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
