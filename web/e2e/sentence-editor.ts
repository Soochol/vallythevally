import type { Locator, Page } from "@playwright/test";
import { expect } from "./harness";

export const sentenceEditor = (page: Page) => page.getByRole("region", { name: "조건식 편집", exact: true });
export const numberToken = (scope: Locator, name: string) => scope.getByRole("button", { name, exact: true });

export async function setNumber(scope: Locator, name: string, value: string) {
  const page = scope.page();
  await numberToken(scope, name).click();
  const popup = page.getByRole("dialog", { name: `${name} 편집`, exact: true });
  const input = popup.getByRole("textbox", { name, exact: true });
  await input.fill(value);
  await input.press("Enter");
  await expect(popup).toBeHidden();
}

export async function renameScreen(scope: Locator, name: string) {
  const page = scope.page();
  await screenAction(scope, "이름 바꾸기");
  const popup = page.getByRole("dialog", { name: "조건식 이름 바꾸기", exact: true });
  await popup.getByRole("textbox", { name: "조건식 이름", exact: true }).fill(name);
  await popup.getByRole("button", { name: "적용", exact: true }).click();
  await expect(popup).toBeHidden();
}

export async function screenAction(scope: Locator, action: string) {
  await scope.getByRole("button", { name: "조건식 메뉴", exact: true }).click();
  await scope.page().getByRole("menu", { name: "조건식 메뉴", exact: true }).getByRole("menuitem", { name: action, exact: true }).click();
}

export async function addCondition(scope: Locator, label = "신고가") {
  await scope.getByRole("button", { name: "조건 추가", exact: true }).click();
  const popup = scope.page().getByRole("dialog", { name: "조건 추가", exact: true });
  await popup.getByRole("textbox", { name: "조건 종류 검색", exact: true }).fill(label);
  await popup.getByRole("button").filter({ has: popup.page().locator("span", { hasText: new RegExp(`^${label}$`) }) }).click();
}

export async function conditionAction(scope: Locator, line: number, action: string) {
  await scope.getByRole("button", { name: `조건 ${line} 메뉴`, exact: true }).click();
  await scope.page().getByRole("menu", { name: `조건 ${line} 메뉴`, exact: true }).getByRole("menuitem", { name: action, exact: true }).click();
}

export async function chooseKind(scope: Locator, line: number, choice: string | { label: string }) {
  const label = typeof choice === "string" ? KIND_NAMES[choice] ?? choice : choice.label;
  await scope.getByRole("button", { name: `조건 ${line} 메뉴`, exact: true }).click();
  await scope.page().getByRole("menu", { name: `조건 ${line} 메뉴`, exact: true }).getByRole("menuitemradio", { name: label, exact: true }).click();
}

export async function toggleExclude(scope: Locator, group: "종류" | "상태", name: string) {
  await scope.getByRole("button", { name: `${group} 제외 추가`, exact: true }).click();
  await scope.page().getByRole("menu", { name: `${group} 제외 추가`, exact: true }).getByRole("menuitemcheckbox", { name, exact: true }).click();
  await scope.page().keyboard.press("Escape");
}

export async function savedEditor(scope: Locator) {
  await expect(scope.getByText("변경됨", { exact: true })).toHaveCount(0);
  await expect(scope.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
}

export async function fillNumber(trigger: Locator, value: string) {
  const label = await trigger.getAttribute("aria-label");
  if (label === null) throw new Error("숫자 값 버튼에 이름이 없습니다");
  await trigger.click();
  const popup = trigger.page().getByRole("dialog", { name: `${label} 편집`, exact: true });
  const input = popup.getByRole("textbox", { name: label, exact: true });
  await input.fill(value);
  await input.press("Enter");
  await expect(popup).toBeHidden();
}

export async function expandEditor(page: Page) {
  const expand = sentenceEditor(page).getByRole("button", { name: "조건 펼치기", exact: true });
  if (await expand.count()) await expand.click();
  await expect(sentenceEditor(page)).toBeVisible();
}

const KIND_NAMES: Readonly<Record<string, string>> = {
  new_high: "신고가", new_low: "신저가", value_range: "값 범위", change: "등락률", near_extreme: "고점·저점 거리",
  volume_high: "신고거래량", traded_value_high: "신고거래대금", surge: "거래 급증", ma_position: "이평 위치",
  ma_alignment: "이평 배열", ma_cross: "이평 교차", rsi: "RSI", macd: "MACD", stochastic: "스토캐스틱",
  bollinger: "볼린저 밴드", ichimoku: "일목균형표", market_cap: "시가총액",
};

export async function expectKind(scope: Locator, line: number, value: string) {
  await scope.getByRole("button", { name: `조건 ${line} 메뉴`, exact: true }).click();
  const item = scope.page().getByRole("menu", { name: `조건 ${line} 메뉴`, exact: true }).getByRole("menuitemradio", { name: KIND_NAMES[value] ?? value, exact: true });
  await expect(item).toHaveAttribute("aria-checked", "true");
  await expect(item).toHaveText(KIND_NAMES[value] ?? value);
  await scope.page().keyboard.press("Escape");
}

export async function expectSentences(scope: Locator, expected: readonly string[]) {
  const lines = scope.getByRole("list", { name: "조건", exact: true }).getByRole("listitem");
  await expect(lines).toHaveCount(expected.length);
  await expect.poll(() => lines.evaluateAll((items) => items.map((item) => {
    const errors = [...item.querySelectorAll('[role="alert"]')];
    return (errors.length ? errors.map((e) => e.textContent).join("") : item.querySelector(".sentence-condition")?.textContent ?? item.textContent ?? "").replace(/^그리고/, "").trim();
  }))).toEqual(expected.map((text) => text.replace(/^그리고/, "")));
}
