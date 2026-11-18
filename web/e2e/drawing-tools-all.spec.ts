import type { Page } from "@playwright/test";
import { cell, chartOf, expect, saveChartShare, SEARCH_BUTTON_TITLE, test, type Scenario, pollSaved } from "./harness";
import { bodyAlong, chartPoint, drawings, expandDock, mirror, open, pickTool, settledMirror } from "./drawing-probe";
import { TOOLS, toolsByGroup } from "../src/chart/drawings/tools";
import type { Tool } from "../src/chart/drawings/toolSpec";

type At = readonly [number, number];

async function collapseDock(page: Page) {
  await page.mouse.move(5, 5);
  await cell(page).focus();
  await expect(page.getByRole("navigation", { name: "드로잉 도구" }).locator(".draw-pill")).toHaveAttribute("aria-expanded", "false");
  let last = "";
  await expect.poll(async () => {
    const now = JSON.stringify(await page.getByRole("navigation", { name: "드로잉 도구" }).boundingBox());
    const same = now === last;
    last = now;
    return same;
  }, { intervals: [30, 30, 60, 100] }).toBe(true);
}

const GROUP_LABEL: Record<Tool["group"], string> = { line: "선", fib: "피보나치·갠", shape: "도형", note: "주석", measure: "측정", pattern: "패턴" };
const COLUMNS = 9;
const ROWS = 4;
const CELL = { left: 0.06, top: 0.22, width: 0.085, height: 0.12 };
const SPOTS: readonly At[] = [[0.15, 0.75], [0.6, 0.25], [0.85, 0.6], [0.35, 0.4], [0.05, 0.05], [0.95, 0.95], [0.5, 0.6]];
const menuGroups = () => [...toolsByGroup()].filter(([, tools]) => tools.length > 1);

function cellSpots(index: number, count: number): At[] {
  expect(index, "도구 격자 칸").toBeLessThan(COLUMNS * ROWS);
  expect(count, "한 칸의 점").toBeLessThanOrEqual(SPOTS.length);
  const x0 = CELL.left + (index % COLUMNS) * CELL.width;
  const y0 = CELL.top + Math.floor(index / COLUMNS) * CELL.height;
  return SPOTS.slice(0, count).map(([fx, fy]) => [x0 + fx * CELL.width * 0.8, y0 + fy * CELL.height * 0.8]);
}

async function clickAt(page: Page, spots: readonly At[]) {
  for (const spot of spots) {
    const p = await chartPoint(page, ...spot);
    await page.mouse.move(p.x, p.y, { steps: 4 });
    await page.mouse.click(p.x, p.y);
  }
}

async function place(page: Page, tool: Tool, index: number): Promise<(saved: number) => void> {
  const placement = tool.placement;
  switch (placement.kind) {
    case "points": {
      const clicks = placement.oneClick ? 1 : placement.count;
      await clickAt(page, cellSpots(index, clicks));
      return (saved) => expect(saved).toBe(placement.count);
    }
    case "polyline": {
      const spots = cellSpots(index, 3);
      await clickAt(page, spots);
      const last = await chartPoint(page, ...spots.at(-1)!);
      await page.mouse.dblclick(last.x, last.y);
      return (saved) => expect(saved).toBe(spots.length);
    }
    case "freehand": {
      const trail = await Promise.all(cellSpots(index, 4).map((spot) => chartPoint(page, ...spot)));
      await page.mouse.move(trail[0]!.x, trail[0]!.y);
      await page.mouse.down();
      for (const p of trail.slice(1)) await page.mouse.move(p.x, p.y, { steps: 20 });
      await page.mouse.up();
      return (saved) => { expect(saved).toBeGreaterThanOrEqual(placement.min); expect(saved).toBeLessThanOrEqual(placement.max); };
    }
  }
}

interface Slice { name: string; placed: readonly { tool: Tool; index: number }[] }

const SLICE_SIZE = 5;
const SLICES: readonly Slice[] = [...toolsByGroup()].flatMap(([group, groupTools]) => {
  const slices: Slice[] = [];
  const size = Math.ceil(groupTools.length / Math.ceil(groupTools.length / SLICE_SIZE));
  for (let from = 0; from < groupTools.length; from += size) {
    const placed = groupTools.slice(from, from + size).map((tool) => ({ tool, index: TOOLS.indexOf(tool) }));
    slices.push({ name: `${GROUP_LABEL[group]} ${from + 1}~${from + placed.length}번째`, placed });
  }
  return slices;
});

async function placeSlice(page: Page, scenario: Scenario, slice: Slice) {
  for (const [count, { tool, index }] of slice.placed.entries()) {
    await pickTool(page, GROUP_LABEL[tool.group], tool.label);
    const checkPoints = await place(page, tool, index);
    if (tool.text?.editOnPlace) {
      const editor = page.getByRole("textbox", { name: "드로잉 글자" });
      await expect(editor).toBeFocused();
      await editor.press("Enter");
      await expect(editor).toBeHidden();
    }
    await pollSaved(async () => (await drawings(scenario)).length, { message: tool.label }).toBe(count + 1);
    const saved = (await drawings(scenario)).at(-1)!;
    expect(saved.tool, tool.label).toBe(tool.tool);
    checkPoints(saved.points.length);
  }
  await page.keyboard.press("Escape");
}

const tools = () => TOOLS.map((t) => t.tool).sort();
const toolNames = (slice: Slice) => slice.placed.map(({ tool }) => tool.tool).sort();

test("등록된 도구는 36개이고, 쪼갠 시험 묶음이 36개를 빠짐없이 한 번씩 받는다", () => {
  expect(TOOLS).toHaveLength(36);
  expect(SLICES.flatMap(toolNames).sort()).toEqual(tools());
  expect(Math.max(...SLICES.map((slice) => slice.placed.length))).toBeLessThanOrEqual(SLICE_SIZE);
});

for (const slice of SLICES) {
  test(`모든 도구 ${slice.name}: 도구 막대에서 골라 놓고, 새로고침 뒤에도 ${slice.placed.length}개가 저장된 드로잉에 도구 이름으로 남고, 휴대폰 폭에서는 보이되 편집 조작은 없다`, async ({ page, scenario }, testInfo) => {
    const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
    saveChartShare(scenario, 0.642);
    await page.setViewportSize({ width: 1280, height: 940 });
    await open(page);
    await placeSlice(page, scenario, slice);
    expect(await drawings(scenario)).toHaveLength(slice.placed.length);
    await expect.poll(async () => (await mirror(page)).map((d) => d.tool).sort()).toEqual(toolNames(slice));
    const saved = await drawings(scenario);
    const placedMirror = await settledMirror(page);

    await page.reload();
    await expect.poll(async () => (await mirror(page)).map((d) => d.tool).sort()).toEqual(toolNames(slice));
    expect((await mirror(page)).every((d) => d.points.every((p) => p !== null))).toBe(true);
    const reloadedMirror = await settledMirror(page);
    for (const placed of placedMirror) {
      const again = reloadedMirror.find((d) => d.id === placed.id)!;
      expect(again.tool, placed.tool).toBe(placed.tool);
      expect(again.points, placed.tool).toHaveLength(placed.points.length);
      placed.points.forEach((p, i) => {
        expect(again.points[i]!.x, `${placed.tool} 점 ${i} x`).toBeCloseTo(p!.x, 0);
        expect(again.points[i]!.y, `${placed.tool} 점 ${i} y`).toBeCloseTo(p!.y, 0);
      });
    }
    expect(await drawings(scenario)).toEqual(saved);
    await page.screenshot({ path: testInfo.outputPath("all-tools-1280.png") });

    expect((await drawings(scenario)).map((d) => d.tool).sort()).toEqual(toolNames(slice));

    await collapseDock(page);
    const chart = chartOf(cell(page));
    const pane = await chart.evaluate((el) => {
      const r = [...el.querySelectorAll("canvas")].map((c) => c.getBoundingClientRect()).sort((a, b) => b.width * b.height - a.width * a.height)[0]!;
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const shot = () => page.screenshot({ clip: pane, mask: [page.getByRole("navigation", { name: "드로잉 도구" })] });
    const shown = await shot();
    await cell(page).focus(); await page.keyboard.press("Control+Alt+h");
    await expect.poll(async () => (await shot()).equals(shown), { message: "모든 드로잉을 숨기면 차트 그림이 바뀐다" }).toBe(false);
    await page.keyboard.press("Control+Alt+h");
    await expect.poll(async () => (await shot()).equals(shown), { message: "다시 보이면 그림이 돌아온다" }).toBe(true);

    const first = slice.placed[0]!.tool;
    const frame = (await chart.boundingBox())!;
    const anchors = new Map((await settledMirror(page)).filter((d) => d.points.length > 1).map((d) => [d.tool, d.points[0]!]));
    const target = slice.placed.map(({ tool }) => tool.tool).find((tool) => anchors.has(tool))!;
    await expect(async () => {
      await page.mouse.move(frame.x + anchors.get(target)!.x, frame.y + anchors.get(target)!.y);
      await page.mouse.down(); await page.mouse.up();
      expect((await mirror(page)).find((d) => d.tool === target)?.handles.length).toBeGreaterThan(0);
    }).toPass();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("navigation", { name: "드로잉 도구" })).toBeHidden();
    await expect(page.getByRole("toolbar", { name: "드로잉 스타일" })).toBeHidden();
    await expect.poll(async () => (await mirror(page)).map((d) => d.tool).sort()).toEqual(toolNames(slice));
    expect((await mirror(page)).flatMap((d) => d.handles)).toHaveLength(0);
    const r = (await chart.boundingBox())!;
    await page.mouse.click(r.x + r.width * 0.3, r.y + r.height * 0.4); await page.keyboard.press("Delete");
    const onFirst = (await mirror(page)).find((d) => d.tool === first.tool)!.points[0]!;
    await page.mouse.click(r.x + onFirst.x, r.y + onFirst.y); await page.keyboard.press("Delete");
    expect(await drawings(scenario)).toHaveLength(slice.placed.length);
    await page.screenshot({ path: testInfo.outputPath("all-tools-phone.png") });

    await page.reload();
    await expect.poll(async () => (await mirror(page)).length).toBe(slice.placed.length);
    const phoneShown = await chart.screenshot();
    for (const d of await drawings(scenario)) scenario.documents.deleteDrawing(d.id);
    await page.reload();
    await expect(chart).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
    await expect.poll(async () => (await mirror(page)).length).toBe(0);
    expect((await chart.screenshot()).equals(phoneShown)).toBe(false);
    expect(errors).toEqual([]);
  });
}

for (const width of [1280, 1024, 800]) {
  test(`도구 막대: 창 폭 ${width}px에서 차트 안에 머물고 모든 버튼과 그룹 메뉴에 닿는다`, async ({ page, scenario }) => {
    if (width === 800) saveChartShare(scenario, 0.5);
    await page.setViewportSize({ width, height: 800 });
    await open(page);
    const bar = page.getByRole("navigation", { name: "드로잉 도구" });
    const chart = (await chartOf(cell(page)).boundingBox())!;
    const pill = (await bar.boundingBox())!;
    expect(pill.x).toBeGreaterThanOrEqual(chart.x);
    expect(pill.x + pill.width).toBeLessThanOrEqual(chart.x + chart.width);
    await expandDock(page);
    const box = (await bar.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(chart.x);
    expect(box.x + box.width).toBeLessThanOrEqual(chart.x + chart.width);
    const overflow = await bar.evaluate((el) => el.scrollWidth - el.clientWidth);
    if (width === 800) {
      expect(overflow).toBeGreaterThan(0);
      const help = bar.getByRole("button", { name: "드로잉 단축키 도움말", exact: true });
      await expect(help).not.toBeInViewport({ ratio: 1 });
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(overflow + 50, 0);
      await expect.poll(() => bar.evaluate((el) => el.scrollLeft)).toBe(overflow);
      const own = (await help.boundingBox())!;
      expect(own.x + own.width).toBeLessThanOrEqual(box.x + box.width + 1);
      await help.click();
      await expect(page.getByRole("dialog", { name: "드로잉 단축키" })).toBeInViewport({ ratio: 1 });
      await page.keyboard.press("Escape");
    } else expect(overflow).toBe(0);
    const buttons = bar.getByRole("button");
    for (let i = 0; i < await buttons.count(); i++) {
      const button = buttons.nth(i);
      await button.scrollIntoViewIfNeeded();
      const own = (await button.boundingBox())!;
      expect(own.x, await button.getAttribute("aria-label") ?? "").toBeGreaterThanOrEqual(box.x - 1);
      expect(own.x + own.width, await button.getAttribute("aria-label") ?? "").toBeLessThanOrEqual(box.x + box.width + 1);
    }
    expect((await bar.boundingBox())!).toEqual(box);
    const viewport = page.viewportSize()!;
    for (const group of menuGroups().map(([g]) => GROUP_LABEL[g])) {
      await expandDock(page);
      const toggle = bar.getByRole("button", { name: `${group} 도구 펼치기`, exact: true });
      await toggle.scrollIntoViewIfNeeded();
      await toggle.click();
      const menu = page.getByRole("menu", { name: `${group} 도구` });
      await expect(menu).toBeVisible();
      const m = (await menu.boundingBox())!;
      expect(m.x, group).toBeGreaterThanOrEqual(0);
      expect(m.y, group).toBeGreaterThanOrEqual(0);
      expect(m.x + m.width, group).toBeLessThanOrEqual(viewport.width);
      expect(m.y + m.height, group).toBeLessThanOrEqual(viewport.height);
      const items = menu.getByRole("menuitem");
      for (let i = 0; i < await items.count(); i++) await expect(items.nth(i)).toBeInViewport({ ratio: 1 });
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
    }
  });
}

test("도구 막대: 높이 300px 창에서도 그룹 메뉴는 창 안에 있고 메뉴 안을 넘겨 마지막 도구까지 고른다", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 300 });
  await open(page);
  const bar = page.getByRole("navigation", { name: "드로잉 도구" });
  for (const [group, tools] of menuGroups()) {
    const label = GROUP_LABEL[group];
    await expandDock(page);
    await bar.getByRole("button", { name: `${label} 도구 펼치기`, exact: true }).click();
    const menu = page.getByRole("menu", { name: `${label} 도구` });
    await expect(menu).toBeVisible();
    const m = (await menu.boundingBox())!;
    expect(m.y, label).toBeGreaterThanOrEqual(0);
    expect(m.y + m.height, label).toBeLessThanOrEqual(300);
    const room = await menu.evaluate((el) => el.scrollHeight - el.clientHeight);
    if (group === "line") expect(room, "선 도구 메뉴는 넘쳐서 넘긴다").toBeGreaterThan(0);
    await page.mouse.move(m.x + m.width / 2, m.y + m.height / 2);
    await page.mouse.wheel(0, room + 50);
    await expect.poll(() => menu.evaluate((el) => el.scrollTop)).toBe(room);
    const last = tools.at(-1)!;
    const item = menu.getByRole("menuitem").filter({ hasText: last.label });
    await expect(item).toBeInViewport({ ratio: 1 });
    await item.click();
    await expandDock(page);
    await expect(bar.getByRole("button", { name: last.label, exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
  }
});

const PIN_SLICE_SIZE = 4;
const PIN_SLICES = menuGroups().flatMap(([group, groupTools]) => {
  const size = Math.ceil(groupTools.length / Math.ceil(groupTools.length / PIN_SLICE_SIZE));
  return Array.from({ length: Math.ceil(groupTools.length / size) }, (_, n) => {
    const slice = groupTools.slice(n * size, (n + 1) * size);
    return { group, tools: slice, name: `${GROUP_LABEL[group]} ${n * size + 1}~${n * size + slice.length}번째` };
  });
});

test("도구 막대: 고정 시험 묶음이 메뉴가 있는 그룹의 도구를 빠짐없이 한 번씩 받는다", () => {
  expect(PIN_SLICES.flatMap(({ tools }) => tools.map((t) => t.tool)).sort()).toEqual(menuGroups().flatMap(([, groupTools]) => groupTools.map((t) => t.tool)).sort());
  expect(Math.max(...PIN_SLICES.map(({ tools }) => tools.length))).toBeLessThanOrEqual(PIN_SLICE_SIZE);
});

for (const { group, tools, name } of PIN_SLICES) {
  test(`도구 막대: 단축키가 없는 도구는 제목과 메뉴에 빈 단축키를 보이지 않는다 (${name})`, async ({ page }) => {
    await open(page);
    const bar = page.getByRole("navigation", { name: "드로잉 도구" });
    await expandDock(page);
    await bar.getByRole("button", { name: `${GROUP_LABEL[group]} 도구 펼치기`, exact: true }).click();
    const menu = page.getByRole("menu", { name: `${GROUP_LABEL[group]} 도구` });
    for (const tool of tools) {
      await menu.getByRole("menuitemcheckbox", { name: `${tool.label} 막대에 고정`, exact: true }).click();
      await expect(menu.getByRole("menuitem").filter({ hasText: tool.label }).locator("kbd:empty")).toHaveCount(0);
    }
    await page.keyboard.press("Escape");
    for (const tool of tools) {
      await pickTool(page, GROUP_LABEL[group], tool.label);
      await expect(bar.getByRole("button", { name: tool.label, exact: true })).not.toHaveAttribute("title", /\(\)/);
    }
    await expandDock(page);
    const pinned = bar.getByRole("button", { name: /고정 도구$/ });
    await expect(pinned.first()).toBeVisible();
    for (const button of await pinned.all()) await expect(button).not.toHaveAttribute("title", /\(\)/);
  });
}

test("도구 막대: 단축키로 고른 도구를 그룹 버튼이 기억한다", async ({ page }) => {
  await open(page);
  const bar = page.getByRole("navigation", { name: "드로잉 도구" });
  await cell(page).focus(); await page.keyboard.press("Alt+j");
  await expandDock(page);
  await expect(bar.getByRole("button", { name: "수평 반직선", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expandDock(page);
  await expect(bar.getByRole("button", { name: "선택 도구", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(bar.getByRole("button", { name: "수평 반직선", exact: true })).toBeVisible();
});

test("작은 막대: 위쪽 드로잉을 골라도 도크를 가리지 않는다", async ({ page, scenario }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page);
  await page.evaluate(() => {
    const probe = { overDock: [] as number[] };
    (window as unknown as { barProbe: typeof probe }).barProbe = probe;
    new MutationObserver(() => {
      const bar = document.querySelector("[role=toolbar][aria-label='드로잉 스타일']")?.getBoundingClientRect();
      const dock = document.querySelector("nav[aria-label='드로잉 도구']")?.getBoundingClientRect();
      let hidden = false;
      for (let node: Element | null = document.querySelector("[role=toolbar][aria-label='드로잉 스타일']"); node; node = node.parentElement) if (node instanceof HTMLElement && node.style.visibility === "hidden") hidden = true;
      const shown = !hidden;
      if (shown && bar?.width && dock && bar.top < dock.bottom && bar.bottom > dock.top && bar.left < dock.right && bar.right > dock.left) probe.overDock.push(bar.top);
    }).observe(document.body, { subtree: true, childList: true, attributes: true });
  });
  const probe = () => page.evaluate(() => (window as unknown as { barProbe: { overDock: number[] } }).barProbe);
  for (const top of [0.16, 0.18, 0.2]) {
    await pickTool(page, "선", "추세선"); await clickAt(page, [[0.3, top], [0.4, top + 0.08]]);
    await expect.poll(async () => (await mirror(page)).filter((d) => d.selected).length).toBe(1);
    const dock = (await page.getByRole("navigation", { name: "드로잉 도구" }).boundingBox())!;
    await expect.poll(async () => (await page.getByRole("toolbar", { name: "드로잉 스타일" }).boundingBox())!.y, { message: `${top}` }).toBeGreaterThanOrEqual(dock.y + dock.height);
    const style = page.getByRole("toolbar", { name: "드로잉 스타일" });
    await cell(page).focus(); await page.keyboard.press("Control+Alt+h");
    await expect(style).toBeHidden();
    await page.keyboard.press("Control+Alt+h");
    await expect(style).toBeVisible();
    await pickTool(page, "선", "반직선");
    await page.keyboard.press("Escape");
  }
  expect(await drawings(scenario)).toHaveLength(3);
  await cell(page).focus(); await page.keyboard.press("Control+Alt+h");
  await page.keyboard.press("Control+Alt+h");
  await clickAt(page, [[0.35, 0.24]]);
  await expect(page.getByRole("toolbar", { name: "드로잉 스타일" })).toBeVisible();
  await page.waitForTimeout(200);
  expect((await probe()).overDock).toEqual([]);
});

test("여러 도구: 다른 그룹의 드로잉 셋을 상자로 골라 함께 옮기고, 복제하고, 지우고, 되돌린다", async ({ page, scenario }) => {
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  await open(page);
  const count = async () => (await drawings(scenario)).length;
  await pickTool(page, "주석", "말풍선"); await clickAt(page, [[0.54, 0.42], [0.62, 0.36]]);
  await page.getByRole("textbox", { name: "드로잉 글자" }).press("Enter");
  await pickTool(page, "도형", "타원"); await clickAt(page, [[0.42, 0.4], [0.5, 0.3]]);
  await pickTool(page, "선", "추세선"); await clickAt(page, [[0.3, 0.4], [0.38, 0.32]]);
  await pollSaved(count).toBe(3);
  await page.keyboard.press("Escape");

  const style = page.getByRole("toolbar", { name: "드로잉 스타일" });
  const boxSelect = async (from: At, to: At) => {
    const a = await chartPoint(page, ...from); const b = await chartPoint(page, ...to);
    await cell(page).focus(); await page.keyboard.down("Control");
    await page.mouse.move(a.x, a.y); await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 10 }); await page.mouse.up(); await page.keyboard.up("Control");
    await expect.poll(async () => (await mirror(page)).filter((d) => d.selected).map((d) => d.tool).sort()).toEqual(["callout", "ellipse", "trendline"]);
  };
  await boxSelect([0.26, 0.24], [0.66, 0.48]);
  await expect(style.getByText("3개 선택됨")).toBeAttached();
  await expect(style.getByRole("button", { name: "선 색 선택", exact: true })).toBeVisible();
  for (const label of ["선 굵기", "선 모양"]) await expect(style.getByRole("combobox", { name: label, exact: true })).toBeVisible();
  for (const label of ["채움 색 선택", "글자 색 선택"]) await expect(style.getByRole("button", { name: label, exact: true })).toHaveCount(0);

  const before = await drawings(scenario);
  const ellipse = (await mirror(page)).find((d) => d.tool === "ellipse")!;
  const r = (await chartOf(cell(page)).boundingBox())!;
  const [a, b] = ellipse.points;
  const grab = { x: r.x + a!.x, y: r.y + (a!.y + b!.y) / 2 };
  await page.mouse.move(grab.x, grab.y); await page.mouse.down();
  await page.mouse.move(grab.x + 40, grab.y + 60, { steps: 10 }); await page.mouse.up();
  await pollSaved(async () => (await drawings(scenario)).every((d) => d.points[0]!.price !== before.find((x) => x.id === d.id)!.points[0]!.price)).toBe(true);

  await style.getByRole("button", { name: "드로잉 복제", exact: true }).click();
  await pollSaved(count).toBe(6);
  await cell(page).focus(); await page.keyboard.press("Control+z");
  await pollSaved(count).toBe(3);

  await boxSelect([0.2, 0.1], [0.72, 0.62]);
  await cell(page).focus(); await page.keyboard.press("Delete");
  await pollSaved(count).toBe(0);
  await page.keyboard.press("Control+z");
  await pollSaved(async () => (await drawings(scenario)).map((d) => d.tool).sort()).toEqual(["callout", "ellipse", "trendline"]);
  await page.keyboard.press("Control+z");
  await pollSaved(async () => (await drawings(scenario)).map((d) => d.points)).toEqual(before.map((d) => d.points));

  await pickTool(page, "측정", "날짜 범위"); await clickAt(page, [[0.74, 0.7], [0.8, 0.7]]);
  await pollSaved(count).toBe(4);
  const callout = await chartPoint(page, 0.54, 0.42); const range = await chartPoint(page, 0.74, 0.7);
  await page.mouse.click(callout.x, callout.y);
  await page.keyboard.down("Control"); await page.mouse.click(range.x, range.y); await page.keyboard.up("Control");
  await expect.poll(async () => (await mirror(page)).filter((d) => d.selected).map((d) => d.tool).sort()).toEqual(["callout", "daterange"]);
  for (const label of ["채움 색 선택", "글자 색 선택"]) await expect(style.getByRole("button", { name: label, exact: true })).toBeVisible();
  await expect(style.getByRole("button", { name: "선 색 선택", exact: true })).toHaveCount(0);
  for (const label of ["선 굵기", "선 모양"]) await expect(style.getByRole("combobox", { name: label, exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test.describe("봉을 읽는 도구", () => {
  test.use({ clockStart: "20261109100000" });
  const SYMBOL = "005930";
  const BAR_TOOLS = ["avwap", "regression", "volprofile"];

  async function pushPrice(scenario: Scenario, page: Page, price: number) {
    await expect(async () => {
      expect(await scenario.live.update(SYMBOL, { c: price, v: 1000 })).toBeGreaterThan(0);
      await expect(chartOf(cell(page))).toHaveAttribute("data-last-close", String(price), { timeout: 1000 });
    }).toPass({ timeout: 15_000 });
  }

  async function chooseSymbol(page: Page, symbol: string) {
    await page.getByTitle(SEARCH_BUTTON_TITLE).click();
    const dialog = page.getByRole("dialog", { name: "종목 검색" });
    await dialog.getByRole("combobox", { name: "종목 검색" }).fill(symbol);
    await dialog.getByRole("option").filter({ hasText: symbol }).first().click();
    await expect(dialog).toBeHidden();
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  }

  async function choosePeriod(page: Page, label: string) {
    await page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("group", { name: "봉 주기" }).getByRole("button", { name: label, exact: true }).click();
    await expect(cell(page)).toHaveAttribute("aria-label", new RegExp(` ${label}$`));
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  }

  async function bodyPoint(page: Page, id: string) {
    const r = (await chartOf(cell(page)).boundingBox())!;
    const x = r.x + (await mirror(page)).find((d) => d.id === id)!.points[0]!.x + 40;
    return bodyAlong(page, [[{ x, y: r.y + r.height * 0.15 }, { x, y: r.y + r.height * 0.85 }]]);
  }

  test("회귀 채널, 기준봉 VWAP, 구간 거래량 프로파일을 함께 옮기고, 봉 주기·종목·실시간 봉을 거쳐도 남는다", async ({ page, scenario }) => {
    const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
    const bars = scenario.market.page({ symbol: SYMBOL }).bars;
    expect(bars.some((b) => b.v > 0), `${SYMBOL} 봉의 거래량`).toBe(true);
    const barOf = (t: number) => bars.findLastIndex((b) => b.t <= t);
    const saved = () => scenario.documents.drawings(SYMBOL);
    const count = async () => (await saved()).length;
    const selected = async () => (await mirror(page)).filter((d) => d.selected).map((d) => d.tool).sort();
    const shownTools = async () => (await mirror(page)).filter((d) => d.points.every((p) => p !== null)).map((d) => d.tool).sort();
    const expectPainted = async (where: string) => {
      await expect.poll(shownTools).toEqual(BAR_TOOLS);
      await collapseDock(page);
      const pane = await chartOf(cell(page)).evaluate((el) => {
        const r = [...el.querySelectorAll("canvas")].map((c) => c.getBoundingClientRect()).sort((a, b) => b.width * b.height - a.width * a.height)[0]!;
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      });
      const shot = () => page.screenshot({ clip: pane, mask: [page.getByRole("navigation", { name: "드로잉 도구" }), cell(page).locator(".chart-legend")] });
      await expect.poll(async () => (await mirror(page)).find((d) => d.tool === "volprofile")?.texts).toEqual([expect.stringMatching(/^\d+분봉 기준$/)]);
      const painted = await shot();
      await cell(page).focus(); await page.keyboard.press("Control+Alt+h");
      await expect.poll(async () => (await shot()).equals(painted), { message: `${where}: 모든 드로잉을 숨기면 그림이 바뀐다` }).toBe(false);
      await page.keyboard.press("Control+Alt+h");
      await expect.poll(async () => (await shot()).equals(painted), { message: `${where}: 다시 보이면 그림이 돌아온다` }).toBe(true);
      await page.keyboard.press("Escape");
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    };

    await page.goto(`/?symbol=${SYMBOL}`);
    await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
    await pollSaved(async () => scenario.live.subscriptions().map((s) => s.symbol)).toContain(SYMBOL);

    await pickTool(page, "선", "회귀 채널"); await clickAt(page, [[0.25, 0.5], [0.4, 0.5]]);
    await pollSaved(count).toBe(1);
    await pickTool(page, "측정", "기준봉 VWAP"); await clickAt(page, [[0.48, 0.5]]);
    await pollSaved(count).toBe(2);
    await pickTool(page, "측정", "구간 거래량 프로파일"); await clickAt(page, [[0.56, 0.5], [0.7, 0.5]]);
    await pollSaved(count).toBe(3);
    await page.keyboard.press("Escape");
    await expect.poll(selected).toEqual([]);

    const boxSelect = async () => {
      const a = await chartPoint(page, 0.2, 0.18); const b = await chartPoint(page, 0.76, 0.86);
      await cell(page).focus(); await page.keyboard.down("Control");
      await page.mouse.move(a.x, a.y); await page.mouse.down();
      await page.mouse.move(b.x, b.y, { steps: 10 }); await page.mouse.up(); await page.keyboard.up("Control");
      await expect.poll(selected).toEqual(BAR_TOOLS);
    };
    await boxSelect();

    const before = await saved();
    const avwapId = before.find((d) => d.tool === "avwap")!.id;
    const grab = await bodyPoint(page, avwapId);
    await page.mouse.move(grab.x, grab.y); await page.mouse.down();
    await page.mouse.move(grab.x + 60, grab.y, { steps: 10 }); await page.mouse.up();
    await pollSaved(async () => (await saved()).every((d) => d.points[0]!.t !== before.find((x) => x.id === d.id)!.points[0]!.t)).toBe(true);
    const moved = await saved();
    const shifts = moved.flatMap((d) => d.points.map((p, i) => barOf(p.t) - barOf(before.find((x) => x.id === d.id)!.points[i]!.t)));
    expect(shifts[0]).toBeGreaterThan(0);
    expect(new Set(shifts), `옮긴 봉 수 ${shifts}`).toEqual(new Set([shifts[0]]));
    await expect.poll(selected).toEqual(BAR_TOOLS);

    await expect.poll(shownTools).toEqual(BAR_TOOLS);

    await choosePeriod(page, "주");
    await expectPainted("주봉");
    await choosePeriod(page, "일");
    await expectPainted("일봉");
    const wholeChart = async () => {
      const box = (await chartOf(cell(page)).boundingBox())!;
      return page.screenshot({ clip: { x: box.x + 4, y: box.y + 4, width: box.width - 8, height: box.height - 8 }, mask: [page.getByRole("navigation", { name: "드로잉 도구" }), cell(page).locator(".chart-legend")] });
    };
    let daily = await wholeChart();
    await expect.poll(async () => {
      const now = await wholeChart();
      const same = now.equals(daily);
      daily = now;
      return same;
    }).toBe(true);
    await chooseSymbol(page, "005935");
    await expect.poll(() => mirror(page)).toEqual([]);
    await chooseSymbol(page, SYMBOL);
    await expectPainted("종목을 바꿨다 돌아온 뒤");
    await expect.poll(async () => (await wholeChart()).equals(daily), { message: "종목을 바꿨다 돌아오면 가격축까지 일봉 그림이 같다" }).toBe(true);

    await pushPrice(scenario, page, 201_000);
    await pushPrice(scenario, page, 202_500);
    await expectPainted("실시간 봉 뒤");
    expect((await saved()).map((d) => [d.id, d.points]).sort()).toEqual(moved.map((d) => [d.id, d.points]).sort());
    expect(errors).toEqual([]);
  });
});
