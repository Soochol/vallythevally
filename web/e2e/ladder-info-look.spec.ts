import type { Locator } from "@playwright/test";
import { expect, test } from "./harness";
import { INFO_PAGE_1, INFO_PAGE_2, infoCard, infoLabels, infoTab, openOrderWindow, ordersOn, tradingApi } from "./order-window";

const box = async (locator: Locator) => (await locator.boundingBox())!;

test("정보란에 글자 탭 줄이 없고 맨 아래 점 두 개로 시세와 종목을 넘긴다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await expect(infoLabels(page)).toHaveText(INFO_PAGE_1);
  const card = infoCard(page);
  const tabs = card.getByRole("tablist", { name: "상세 정보" });
  await expect(tabs.getByRole("tab")).toHaveCount(2);
  await expect(tabs).toHaveText("");
  const area = await box(card);
  const pager = await box(tabs);
  expect(Math.abs(pager.y + pager.height / 2 - (area.y + area.height - 12))).toBeLessThanOrEqual(2);
  const firstLine = await box(page.getByTestId("ladder-info").first());
  expect(Math.abs(firstLine.y - area.y)).toBeLessThanOrEqual(1);
  await expect(infoTab(page, "시세")).toHaveAttribute("aria-selected", "true");
  await infoTab(page, "종목").click();
  await expect(infoTab(page, "종목")).toHaveAttribute("aria-selected", "true");
  await expect(infoTab(page, "시세")).toHaveAttribute("aria-selected", "false");
  await expect(infoLabels(page)).toHaveText(INFO_PAGE_2);
  await infoTab(page, "시세").click();
  await expect(infoTab(page, "시세")).toHaveAttribute("aria-selected", "true");
  await expect(infoLabels(page)).toHaveText(INFO_PAGE_1);
});

test("정보란은 왼쪽 세로선 하나만 있고 테두리·둥근 모서리·다른 바탕·가로 구분선이 없다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await expect(page.getByTestId("order-ladder")).toHaveAttribute("data-divider", "");
  await expect(infoLabels(page)).toHaveText(INFO_PAGE_1);
  const look = await infoCard(page).evaluate((element) => {
    const style = getComputedStyle(element);
    const transparent = (color: string) => color === "transparent" || /rgba\(.*,\s*0\)$/.test(color);
    let behind = "";
    for (let node = element.parentElement; node !== null; node = node.parentElement) {
      const color = getComputedStyle(node).backgroundColor;
      if (!transparent(color)) { behind = color; break; }
    }
    return {
      left: [style.borderLeftWidth, style.borderLeftStyle],
      others: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth],
      outline: style.outlineStyle === "none" || style.outlineWidth === "0px",
      radius: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius],
      shadow: style.boxShadow,
      background: style.backgroundColor,
      backgroundTransparent: transparent(style.backgroundColor),
      behind,
    };
  });
  expect(look.left).toEqual(["1px", "solid"]);
  expect(look.others).toEqual(["0px", "0px", "0px"]);
  expect(look.outline).toBe(true);
  expect(look.radius).toEqual(["0px", "0px", "0px", "0px"]);
  expect(look.shadow).toBe("none");
  expect(look.backgroundTransparent).toBe(false);
  expect(look.background).toBe(look.behind);
  const lines = await page.getByTestId("ladder-info").evaluateAll((elements) => elements.map((element) => {
    const style = getComputedStyle(element);
    return [style.borderTopWidth, style.borderBottomWidth, style.boxShadow];
  }));
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) expect(line).toEqual(["0px", "0px", "none"]);
});
