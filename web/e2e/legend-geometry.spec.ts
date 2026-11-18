import { cell, expect, test } from "./harness";

type Viewport = { pricePane: { top: number; height: number } | null; axisWidth: number };
type LegendGeometryHarness = {
  fit: (change: "content" | "geometry") => void;
  setNotice: (text: string | null) => void;
  setDisplay: (display: { showLegend: boolean; showOhlcChange: boolean }) => void;
  presentationHost: { readViewport: () => Viewport };
  presentation: { kind: "invalidated" | "settled" };
};

declare global {
  interface Window {
    legendGeometryProbe: { instance: LegendGeometryHarness; checks: number; projections: number };
  }
}

test("legend samples current inputs, skips duplicate geometry and retains content and font invalidations", async ({ page }) => {
  await page.route("**/assets/*.js", async (route) => {
    const response = await route.fetch();
    let body = await response.text();
    if (!body.includes("readGeometryInputs()")) return route.fulfill({ response, body });
    expect([...body.matchAll(/readGeometryInputs\(\)\{/g)]).toHaveLength(1);
    body = body.replace(/readGeometryInputs\(\)\{/, "$&window.legendGeometryProbe??={checks:0,projections:0};window.legendGeometryProbe.instance=this;window.legendGeometryProbe.checks++;");
    body = body.replace(/projection\(\)\{/g, "$&if(this.root?.matches('.chart-legend'))window.legendGeometryProbe.projections++;");
    await route.fulfill({ response, body });
  });
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.evaluate(() => document.fonts.ready);
  const phases = await page.evaluate(async () => {
    const frames = async () => { for (let i = 0; i < 6; i++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); };
    await frames();
    const probe = window.legendGeometryProbe;
    const legend = probe.instance;
    const original = legend.presentationHost.readViewport;
    const current = original();
    legend.presentationHost.readViewport = () => current;
    const counts = () => ({ checks: probe.checks, projections: probe.projections });
    const result = [counts()];
    legend.fit("geometry");
    legend.fit("geometry");
    await frames();
    result.push(counts());
    legend.fit("geometry");
    current.axisWidth += 1;
    await frames();
    result.push(counts());
    if (!current.pricePane) throw new Error("가격 패널이 없습니다");
    current.pricePane.height -= 1;
    legend.fit("geometry");
    await frames();
    result.push(counts());
    legend.fit("geometry");
    await frames();
    result.push(counts());
    legend.fit("content");
    legend.fit("geometry");
    await frames();
    result.push(counts());
    legend.setNotice("");
    await frames();
    result.push(counts());
    legend.setNotice("");
    legend.setDisplay({ showLegend: true, showOhlcChange: false });
    await frames();
    result.push(counts());
    legend.setNotice(null);
    await frames();
    result.push(counts());
    legend.presentationHost.readViewport = original;
    legend.fit("geometry");
    await frames();
    return { result };
  });
  const delta = (first: number, last: number) => {
    const before = phases.result[first];
    const after = phases.result[last];
    if (!before || !after) throw new Error("범례 단계가 없습니다");
    return { checks: after.checks - before.checks, projections: after.projections - before.projections };
  };
  expect(delta(0, 1)).toEqual({ checks: 1, projections: 0 });
  for (const [first, last] of [[1, 2], [2, 3], [4, 5], [5, 6], [7, 8]] satisfies [number, number][]) expect(delta(first, last).projections).toBe(1);
  expect(delta(3, 4)).toEqual({ checks: 1, projections: 0 });
  expect(delta(6, 7)).toEqual({ checks: 0, projections: 0 });
  const fonts = await page.evaluate(async () => {
    const probe = window.legendGeometryProbe;
    const family = getComputedStyle(document.body).fontFamily;
    const rules = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]);
    const rule = rules.find((rule) => rule instanceof CSSFontFaceRule && /U\+41(?:-|,)/i.test(rule.style.getPropertyValue("unicode-range")));
    if (!(rule instanceof CSSFontFaceRule)) throw new Error("A 글리프의 실제 글꼴 원천이 없습니다");
    const font = new FontFace((family.split(",")[0] ?? family).trim().replaceAll('"', ""), rule.style.getPropertyValue("src"), { unicodeRange: "U+0041" });
    document.fonts.add(font);
    let loaded = 0;
    const count = () => loaded++;
    document.fonts.addEventListener("loadingdone", count);
    const before = probe.projections;
    await font.load();
    await document.fonts.ready;
    for (let i = 0; i < 6; i++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    document.fonts.removeEventListener("loadingdone", count);
    return { loaded, projections: probe.projections - before, sameFamily: getComputedStyle(document.body).fontFamily === family, status: font.status };
  });
  expect(fonts).toEqual({ loaded: 1, projections: 1, sameFamily: true, status: "loaded" });
});
