import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { Badge } from "./Badge";
import { Chip } from "./Chip";
import { Field, SecretField, trimSecret } from "./Field";
import { Notice } from "./Notice";
import { Segmented } from "./Segmented";
import { Switch } from "./Switch";
import { panelDomId, Tabs, tabDomId } from "./Tabs";

const noop = () => undefined;
const html = (element: ReactElement) => renderToStaticMarkup(element);

test("Field는 도움말과 오류를 입력에 잇고 오류가 있으면 aria-invalid를 단다", () => {
  const out = html(h(Field, { id: "key", label: "키", help: "앞뒤 공백은 자릅니다", error: "비어 있습니다" }));
  expect(out).toContain('aria-invalid="true"');
  expect(out).toContain('aria-describedby="key-error key-help"');
  expect(out).toContain('id="key-error"');
  expect(out).toContain('id="key-help"');
  expect(out).toContain('for="key"');
});

test("Field는 오류가 없으면 aria-invalid를 달지 않고 받은 aria-describedby를 지킨다", () => {
  const out = html(h(Field, { id: "a", label: "이름", "aria-describedby": "outer" }));
  expect(out).not.toContain("aria-invalid");
  expect(out).toContain('aria-describedby="outer"');
});

test("SecretField는 기본으로 값을 가리고 보기·붙여넣기 단추를 칸 안에 둔다", () => {
  const out = html(h(SecretField, { id: "s", label: "비밀", value: "abc", onChange: noop }));
  expect(out).toContain('type="password"');
  expect(out).toContain('aria-label="보기"');
  expect(out).toContain("붙여넣기");
  expect(out).toMatch(/autocomplete="off"/i);
  expect(trimSecret("  abc \n")).toBe("abc");
});

test("Segmented는 라디오 묶음이면 고른 조각만 탭 순서에 두고 눌림 묶음이면 aria-pressed를 쓴다", () => {
  const options = [{ value: "a", label: "가" }, { value: "b", label: "나" }, { value: "c", label: "다", disabled: true }];
  const radio = html(h(Segmented<string>, { label: "종류", options, value: "b", onChange: noop }));
  expect(radio).toContain('role="radiogroup"');
  expect(radio.match(/role="radio"/g)).toHaveLength(3);
  expect(radio.match(/aria-checked="true"/g)).toHaveLength(1);
  expect(radio.match(/tabindex="-1"/g)).toHaveLength(2);
  const pressed = html(h(Segmented<string>, { label: "종류", mode: "pressed", options, value: "a", onChange: noop }));
  expect(pressed).toContain('role="group"');
  expect(pressed).toContain('aria-pressed="true"');
  expect(pressed).not.toContain('role="radio"');
});

test("Tabs는 고른 탭만 탭 순서에 두고 탭과 패널 id를 잇는다", () => {
  const items = [{ id: "a", label: "가" }, { id: "b", label: "나", count: 3 }];
  const out = html(h(Tabs, { label: "화면", idPrefix: "x", items, value: "b", onChange: noop }));
  expect(out).toContain('role="tablist"');
  expect(out).toContain(`id="${tabDomId("x", "b")}"`);
  expect(out).toContain(`aria-controls="${panelDomId("x", "b")}"`);
  expect(out.match(/aria-selected="true"/g)).toHaveLength(1);
  expect(out.match(/tabindex="0"/g)).toHaveLength(1);
  expect(out).toContain("<span>3</span>");
});

test("Tabs는 값이 어느 탭과도 맞지 않아도 첫 활성 탭을 탭 순서에 둔다", () => {
  const out = html(h(Tabs, { label: "화면", idPrefix: "x", items: [{ id: "a", label: "가", disabled: true }, { id: "b", label: "나" }], value: "none", onChange: noop }));
  expect(out.match(/tabindex="0"/g)).toHaveLength(1);
});

test("Chip은 눌림을, Badge는 톤을, Notice는 톤에 맞는 역할을, Switch는 스위치 역할을 낸다", () => {
  expect(html(h(Chip, { pressed: true, onPressedChange: noop, children: "켬" }))).toContain('aria-pressed="true"');
  expect(html(h(Badge, { tone: "danger", children: "위험" }))).toContain('data-tone="danger"');
  expect(html(h(Badge, { tone: "up", children: "상승" }))).toContain('data-tone="up"');
  expect(html(h(Notice, { tone: "danger", children: "오류" }))).toContain('role="alert"');
  expect(html(h(Notice, { children: "안내" }))).toContain('role="status"');
  expect(html(h(Notice, { action: { label: "열기", onClick: noop }, children: "안내" }))).toContain("열기");
  const sw = html(h(Switch, { checked: true, label: "주문 사용", onChange: noop }));
  expect(sw).toContain('role="switch"');
  expect(sw).toContain('aria-checked="true"');
  expect(sw).toContain("주문 사용");
});
