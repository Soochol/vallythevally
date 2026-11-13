import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { HexColor } from "../../lib/colors";
import { ColorTable, type ThemeSwatch } from "./ColorTable";

const theme: ThemeSwatch<"ind-1" | "ind-2">[] = [{ name: "테마 1", value: "ind-1", css: "#E8C27A" }, { name: "테마 2", value: "ind-2", css: "#B9A6FF" }];
const pressed = (html: string) => [...html.matchAll(/aria-label="([^"]+)" aria-pressed="true"/g)].map((match) => match[1]);

test("테마 줄은 토큰을, 표는 HEX를 눌린 색으로 보이고 스와치마다 이름과 HEX를 붙인다", () => {
  const themed = renderToStaticMarkup(createElement(ColorTable<"ind-1" | "ind-2">, { label: "선 색상", value: "ind-2", theme, onChange: () => {} }));
  expect(themed).toContain('aria-label="테마 색"');
  expect(pressed(themed)).toEqual(["테마 2 #B9A6FF"]);
  expect(themed).toContain('aria-label="진한 파랑 #4A7FE0"');
  expect(themed).toContain("직접 고르기");
  const hex = renderToStaticMarkup(createElement(ColorTable<"ind-1" | "ind-2">, { label: "선 색상", value: "#4a7fe0" as HexColor, theme, onChange: () => {} }));
  expect(pressed(hex)).toEqual(["진한 파랑 #4A7FE0"]);
  expect(hex).toContain("진한 파랑");
});

test("드로잉처럼 테마 줄 없이 쓰면 표와 최근 줄만 보인다", () => {
  const html = renderToStaticMarkup(createElement(ColorTable, { label: "선 색", value: "#FF6B78" as HexColor, onChange: () => {} }));
  expect(html).not.toContain('aria-label="테마 색"');
  expect(html.match(/class="color-cell"/g)).toHaveLength(40);
  expect(pressed(html)).toEqual(["빨강 #FF6B78"]);
});
