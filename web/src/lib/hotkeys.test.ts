import { describe, expect, test } from "vitest";
import { TOOLS } from "../chart/drawings/tools";
import { PERIODS } from "./symbol";
import {
  actualKeys, addKey, DEFAULT_KEYS, findAction, HOTKEY_ACTIONS, hotkeyAction, keyLabel, keyOf, matchDrawingHotkey, matchHotkey,
  moveKey, parseKey, periodActionId, removeKey, resetAction, resetAllActions, searchTitle, toolActionId, type KeyLike, type HotkeyOverrides,
} from "./hotkeys";

const key = (code: string, mods: Partial<KeyLike> = {}): KeyLike => ({ code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
const global = (e: KeyLike, layout: "desktop" | "phone" = "desktop") => matchHotkey(e, layout, DEFAULT_KEYS);
const drawing = (e: KeyLike) => matchDrawingHotkey(e, DEFAULT_KEYS);
const keysOf = (o: HotkeyOverrides, id: string) => actualKeys(o)[id];

describe("동작 목록", () => {
  test("ID는 겹치지 않고 봉 주기 12개와 도구 36개를 모두 담는다", () => {
    expect(new Set(HOTKEY_ACTIONS.map((a) => a.id)).size).toBe(HOTKEY_ACTIONS.length);
    expect(PERIODS.every((p) => hotkeyAction(periodActionId(p)))).toBe(true);
    expect(TOOLS).toHaveLength(36);
    expect(TOOLS.every((t) => hotkeyAction(toolActionId(t.tool))?.group === "tool")).toBe(true);
  });

  test("기본 실제 키에서 한 키 조합은 한 동작에만 있다", () => {
    const all = HOTKEY_ACTIONS.flatMap((a) => a.defaults);
    expect(new Set(all).size).toBe(all.length);
    expect(all.every((k) => parseKey(k) !== null)).toBe(true);
  });

  test("10분·분기·연은 기본 키가 없다", () => {
    for (const p of ["10m", "Q", "Y"] as const) expect(DEFAULT_KEYS[periodActionId(p)]).toEqual([]);
  });
});

describe("기본 키는 지금의 단축키와 같다", () => {
  test("자판 위치(event.code)로 판단하므로 한글 입력 상태의 D(ㅇ)도 일봉이다", () => {
    expect(global(key("KeyD"))).toEqual({ kind: "period", period: "D" });
    expect(global(key("KeyM"))).toEqual({ kind: "period", period: "M" });
  });

  test("검색은 / 와 Ctrl+K(⌘K)", () => {
    expect(global(key("Slash"))).toEqual({ kind: "search" });
    expect(global(key("KeyK", { ctrlKey: true }))).toEqual({ kind: "search" });
    expect(global(key("KeyK", { metaKey: true }))).toEqual({ kind: "search" });
    expect(global(key("KeyK"))).toBeNull();
  });

  test("수식키가 붙은 글자는 단축키가 아니다", () => {
    expect(global(key("KeyD", { ctrlKey: true }))).toBeNull();
    expect(global(key("KeyL", { shiftKey: true }))).toBeNull();
    expect(global(key("BracketRight"))).toEqual({ kind: "periodStep", step: 1 });
    expect(global(key("BracketLeft"))).toEqual({ kind: "periodStep", step: -1 });
  });

  test("숫자는 분봉이다. Shift를 붙이면 15·30·60분", () => {
    expect(global(key("Digit1"))).toEqual({ kind: "period", period: "1m" });
    expect(global(key("Digit5"))).toEqual({ kind: "period", period: "5m" });
    expect(global(key("Digit1", { shiftKey: true }))).toEqual({ kind: "period", period: "15m" });
    expect(global(key("Digit3", { shiftKey: true }))).toEqual({ kind: "period", period: "30m" });
    expect(global(key("Digit6", { shiftKey: true }))).toEqual({ kind: "period", period: "60m" });
    expect(global(key("Digit6"))).toBeNull();
    expect(global(key("Digit1", { ctrlKey: true }))).toBeNull();
  });

  test("Alt+W는 데스크톱에서만 관심종목 창 보이기, W만 누르면 주봉", () => {
    expect(global(key("KeyW", { altKey: true }))).toEqual({ kind: "showWatchlist" });
    expect(global(key("KeyW", { altKey: true }), "phone")).toBeNull();
    expect(global(key("KeyW"))).toEqual({ kind: "period", period: "W" });
  });

  test("Alt+S는 차트 이미지 내려받기, Alt+Shift+S는 데스크톱에서만 복사", () => {
    expect(global(key("KeyS", { altKey: true }))).toEqual({ kind: "snapshot", mode: "download" });
    expect(global(key("KeyS", { altKey: true, shiftKey: true }))).toEqual({ kind: "snapshot", mode: "copy" });
    expect(global(key("KeyS", { altKey: true, shiftKey: true }), "phone")).toBeNull();
    expect(global(key("KeyS", { altKey: true }), "phone")).toEqual({ kind: "snapshot", mode: "download" });
    expect(global(key("KeyS"))).toBeNull();
    expect(global(key("KeyS", { altKey: true, ctrlKey: true }))).toBeNull();
  });

  test("I·L·Alt+,·Alt+G", () => {
    expect(global(key("KeyI"), "phone")).toEqual({ kind: "indicators" });
    expect(global(key("KeyL"))).toEqual({ kind: "toggleLog" });
    expect(global(key("Comma", { altKey: true }))).toEqual({ kind: "systemSettings" });
    expect(global(key("KeyG", { altKey: true }), "phone")).toEqual({ kind: "jump" });
    expect(global(key("KeyG", { altKey: true, shiftKey: true }))).toBeNull();
  });

  test("드로잉 도구 키는 지금의 표 그대로다", () => {
    const tool = (code: string, mods: Partial<KeyLike> = {}) => drawing(key(code, mods));
    expect(tool("KeyT")).toEqual({ kind: "tool", tool: "trendline" });
    expect(tool("KeyT", { altKey: true })).toEqual({ kind: "tool", tool: "trendline" });
    expect(tool("KeyH")).toEqual({ kind: "tool", tool: "hline" });
    expect(tool("KeyH", { altKey: true })).toEqual({ kind: "tool", tool: "hline" });
    expect(tool("KeyJ", { altKey: true })).toEqual({ kind: "tool", tool: "hray" });
    expect(tool("KeyV", { shiftKey: true })).toEqual({ kind: "tool", tool: "vline" });
    expect(tool("KeyV", { altKey: true })).toEqual({ kind: "tool", tool: "vline" });
    expect(tool("KeyR")).toEqual({ kind: "tool", tool: "rect" });
    expect(tool("KeyR", { altKey: true, shiftKey: true })).toEqual({ kind: "tool", tool: "rect" });
    expect(tool("KeyF")).toEqual({ kind: "tool", tool: "fib" });
    expect(tool("KeyF", { altKey: true })).toEqual({ kind: "tool", tool: "fib" });
    expect(tool("KeyX")).toEqual({ kind: "tool", tool: "text" });
  });

  test("V·G·Shift+G·Ctrl+Alt+H는 드로잉 동작이다", () => {
    expect(drawing(key("KeyV"))).toEqual({ kind: "select" });
    expect(drawing(key("KeyG"))).toEqual({ kind: "magnet" });
    expect(drawing(key("KeyG", { shiftKey: true }))).toEqual({ kind: "magnetStrength" });
    expect(drawing(key("KeyH", { ctrlKey: true, altKey: true }))).toEqual({ kind: "hideAll" });
    expect(drawing(key("KeyH", { metaKey: true, altKey: true }))).toEqual({ kind: "hideAll" });
  });

  test("지금 단축키가 아니던 키는 아무 동작도 찾지 않는다", () => {
    for (const e of [key("KeyQ"), key("KeyQ", { altKey: true }), key("KeyG", { altKey: true, ctrlKey: true })]) {
      expect(findAction(e, DEFAULT_KEYS, "desktop")).toBeNull();
    }
  });

  test("전역 검사는 드로잉 키를, 드로잉 검사는 전역 키를 건너뛴다", () => {
    expect(global(key("KeyT"))).toBeNull();
    expect(drawing(key("KeyD"))).toBeNull();
  });
});

describe("키 글자", () => {
  test("지금 글자와 같다", () => {
    expect(keyLabel("Slash")).toBe("/");
    expect(keyLabel("Ctrl+KeyK")).toBe("Ctrl+K");
    expect(keyLabel("Alt+Comma")).toBe("Alt+,");
    expect(keyLabel("Shift+Digit1")).toBe("Shift+1");
    expect(keyLabel("Alt+Shift+KeyS")).toBe("Alt+Shift+S");
    expect(keyLabel("BracketLeft")).toBe("[");
  });

  test("키 이벤트에서 저장하는 모양을 만든다. ⌘는 Ctrl이다", () => {
    expect(keyOf(key("KeyK", { metaKey: true }))).toBe("Ctrl+KeyK");
    expect(keyOf(key("KeyS", { shiftKey: true, altKey: true }))).toBe("Alt+Shift+KeyS");
  });

  test("순서가 틀리거나 모르는 키는 읽지 않는다", () => {
    expect(parseKey("Shift+Alt+KeyR")).toBeNull();
    expect(parseKey("Alt+Alt+KeyR")).toBeNull();
    expect(parseKey("Hyper+KeyR")).toBeNull();
    expect(parseKey("KeyZZ")).toBeNull();
    expect(parseKey("")).toBeNull();
    expect(parseKey(3)).toBeNull();
  });

  test("검색 칸 제목은 앞 키 둘을 보이고, 키가 없으면 글자와 괄호를 뺀다", () => {
    expect(searchTitle(DEFAULT_KEYS)).toBe("종목 검색 (/ 또는 Ctrl+K)");
    expect(searchTitle(actualKeys({ search: ["KeyQ"] }))).toBe("종목 검색 (Q)");
    expect(searchTitle(actualKeys({ search: [] }))).toBe("종목 검색");
  });
});

describe("키 더하기", () => {
  test("빈 키에 Q를 더하면 된다", () => {
    const result = addKey({}, periodActionId("10m"), "KeyQ");
    expect(result.kind).toBe("added");
    if (result.kind === "added") expect(keysOf(result.hotkeys, periodActionId("10m"))).toEqual(["KeyQ"]);
  });

  test("일에 W를 더하면 주가 쓴다고 알린다", () => {
    const result = addKey({}, periodActionId("D"), "KeyW");
    expect(result.kind === "taken" && result.by.id).toBe(periodActionId("W"));
  });

  test("바꿀 수 없는 키는 더하지 않는다", () => {
    for (const k of ["Ctrl+KeyW", "Escape", "Shift+ShiftLeft", "ControlLeft", "Ctrl+Shift+KeyZ", "ArrowLeft", "Alt+ArrowLeft", "F5", "Tab", "Ctrl+KeyC", "not a key"]) {
      expect(addKey({}, periodActionId("10m"), k).kind, k).toBe("locked");
    }
    expect(addKey({}, periodActionId("10m"), "Ctrl+Shift+KeyW").kind).toBe("added");
  });

  test("이 동작이 이미 가진 키는 이미 있다고 알린다", () => {
    expect(addKey({}, periodActionId("D"), "KeyD").kind).toBe("owned");
  });
});

describe("옮기기·빼기·기본값", () => {
  test("옮기면 W는 일에만 있고 주에는 없다", () => {
    const moved = moveKey({}, periodActionId("D"), "KeyW");
    expect(keysOf(moved, periodActionId("D"))).toEqual(["KeyD", "KeyW"]);
    expect(keysOf(moved, periodActionId("W"))).toEqual([]);
    expect(findAction(key("KeyW"), actualKeys(moved), "desktop")?.id).toBe(periodActionId("D"));
  });

  test("쓰는 동작이 없으면 옮기기는 더하기와 같고, 바꿀 수 없는 키는 그대로 둔다", () => {
    expect(keysOf(moveKey({}, periodActionId("10m"), "KeyQ"), periodActionId("10m"))).toEqual(["KeyQ"]);
    const o = {};
    expect(moveKey(o, periodActionId("10m"), "Escape")).toBe(o);
  });

  test("빼면 그 동작은 키가 없다", () => {
    const removed = removeKey({}, "toggleLog", "KeyL");
    expect(keysOf(removed, "toggleLog")).toEqual([]);
    expect(findAction(key("KeyL"), actualKeys(removed), "desktop")).toBeNull();
    expect(removeKey(removed, "toggleLog", "KeyL")).toBe(removed);
  });

  test("기본값으로 되돌리면 옮겨 갔던 기본 키를 되찾고 그 동작에서는 빠진다", () => {
    const moved = moveKey({}, periodActionId("D"), "KeyW");
    const back = resetAction(moved, periodActionId("W"));
    expect(keysOf(back, periodActionId("W"))).toEqual(["KeyW"]);
    expect(keysOf(back, periodActionId("D"))).toEqual(["KeyD"]);
    expect(back).toEqual({});
  });

  test("기본값과 같아진 동작은 바꾼 것에 남지 않는다", () => {
    const removed = removeKey({}, "toggleLog", "KeyL");
    expect(addKey(removed, "toggleLog", "KeyL")).toMatchObject({ kind: "added", hotkeys: {} });
  });

  test("모두 기본값으로", () => {
    expect(resetAllActions()).toEqual({});
  });

  test("어떤 편집 순서로도 한 키는 한 동작에만 있다", () => {
    let o: HotkeyOverrides = {};
    const edits: [string, string][] = [["period:D", "KeyW"], ["tool:trendline", "KeyD"], ["period:W", "KeyT"], ["tool:text", "KeyW"], ["search", "KeyT"]];
    for (const [id, k] of edits) o = moveKey(o, id, k);
    o = resetAction(o, "period:D");
    const all = Object.values(actualKeys(o)).flat();
    expect(new Set(all).size).toBe(all.length);
  });
});
