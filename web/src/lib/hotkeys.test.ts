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
  expect(matchHotkey(key("KeyD"))).toEqual({ kind: "period", period: "D" });
  expect(matchHotkey(key("KeyM"))).toEqual({ kind: "period", period: "M" });
});

test("검색은 / 와 Ctrl+K", () => {
  expect(matchHotkey(key("Slash"))).toEqual({ kind: "search" });
  expect(matchHotkey(key("KeyK", { ctrlKey: true }))).toEqual({ kind: "search" });
  expect(matchHotkey(key("KeyK"))).toBeNull();
});

test("수식키가 붙은 글자는 단축키가 아니다", () => {
  expect(matchHotkey(key("KeyD", { ctrlKey: true }))).toBeNull();
  expect(matchHotkey(key("KeyL", { shiftKey: true }))).toBeNull();
  expect(matchHotkey(key("BracketRight"))).toEqual({ kind: "periodStep", step: 1 });
});
