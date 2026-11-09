import { expect, test } from "vitest";
import { type KeyLike, matchHotkey } from "./hotkeys";

const key = (code: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  code,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

test("자판 위치(event.code)로 판단하므로 한글 입력 상태의 D(ㅇ)도 일봉이다", () => {
  expect(matchHotkey(key("KeyD"), "desktop")).toEqual({ kind: "period", period: "D" });
  expect(matchHotkey(key("KeyM"), "desktop")).toEqual({ kind: "period", period: "M" });
});

test("검색은 / 와 Ctrl+K", () => {
  expect(matchHotkey(key("Slash"), "desktop")).toEqual({ kind: "search" });
  expect(matchHotkey(key("KeyK", { ctrlKey: true }), "desktop")).toEqual({ kind: "search" });
  expect(matchHotkey(key("KeyK"), "desktop")).toBeNull();
});

test("수식키가 붙은 글자는 단축키가 아니다", () => {
  expect(matchHotkey(key("KeyD", { ctrlKey: true }), "desktop")).toBeNull();
  expect(matchHotkey(key("KeyL", { shiftKey: true }), "desktop")).toBeNull();
  expect(matchHotkey(key("BracketRight"), "desktop")).toEqual({ kind: "periodStep", step: 1 });
});

test("숫자는 분봉이다. Shift를 붙이면 15·30·60분", () => {
  expect(matchHotkey(key("Digit1"), "desktop")).toEqual({ kind: "period", period: "1m" });
  expect(matchHotkey(key("Digit5"), "desktop")).toEqual({ kind: "period", period: "5m" });
  expect(matchHotkey(key("Digit1", { shiftKey: true }), "desktop")).toEqual({ kind: "period", period: "15m" });
  expect(matchHotkey(key("Digit3", { shiftKey: true }), "desktop")).toEqual({ kind: "period", period: "30m" });
  expect(matchHotkey(key("Digit6", { shiftKey: true }), "desktop")).toEqual({ kind: "period", period: "60m" });
  expect(matchHotkey(key("Digit6"), "desktop")).toBeNull();
  expect(matchHotkey(key("Digit1", { ctrlKey: true }), "desktop")).toBeNull();
});

test("Alt+W는 관심종목 접기, W만 누르면 주봉", () => {
  expect(matchHotkey(key("KeyW", { altKey: true }), "desktop")).toEqual({ kind: "toggleWatch" });
  expect(matchHotkey(key("KeyW"), "desktop")).toEqual({ kind: "period", period: "W" });
});

test("Alt+S는 차트 이미지 내려받기, Alt+Shift+S는 복사, S만 누르면 아무것도 아니다", () => {
  expect(matchHotkey(key("KeyS", { altKey: true }), "desktop")).toEqual({ kind: "snapshot", mode: "download" });
  expect(matchHotkey(key("KeyS", { altKey: true, shiftKey: true }), "desktop")).toEqual({ kind: "snapshot", mode: "copy" });
  expect(matchHotkey(key("KeyS"), "desktop")).toBeNull();
  expect(matchHotkey(key("KeyS", { altKey: true, ctrlKey: true }), "desktop")).toBeNull();
});

test("휴대폰은 내려받기만 하므로 Alt+Shift+S가 단축키가 아니다", () => {
  expect(matchHotkey(key("KeyS", { altKey: true }), "phone")).toEqual({ kind: "snapshot", mode: "download" });
  expect(matchHotkey(key("KeyS", { altKey: true, shiftKey: true }), "phone")).toBeNull();
  expect(matchHotkey(key("KeyD"), "phone")).toEqual({ kind: "period", period: "D" });
});
