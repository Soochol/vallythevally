import type { DrawingTool } from "../api/generated/DrawingTool";
import type { Period } from "../api/generated/Period";
import { TOOLS } from "../chart/drawings/tools";
import { PERIODS, PERIOD_LABEL } from "./symbol";

export type HotkeyAction =
  | { kind: "search" }
  | { kind: "period"; period: Period }
  | { kind: "periodStep"; step: -1 | 1 }
  | { kind: "toggleLog" }
  | { kind: "indicators" }
  | { kind: "showWatchlist" }
  | { kind: "systemSettings" }
  | { kind: "snapshot"; mode: "download" | "copy" }
  | { kind: "jump" };

export type DrawingHotkey = { kind: "select" } | { kind: "magnet" } | { kind: "magnetStrength" } | { kind: "hideAll" } | { kind: "tool"; tool: DrawingTool };

const DRAWING_HOTKEY_KINDS: ReadonlySet<string> = new Set<DrawingHotkey["kind"]>(["select", "magnet", "magnetStrength", "hideAll", "tool"]);
const isDrawingHotkey = (effect: HotkeyAction | DrawingHotkey): effect is DrawingHotkey => DRAWING_HOTKEY_KINDS.has(effect.kind);

export interface KeyLike {
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export type Layout = "desktop" | "phone";

export type KeyString = string;

export interface KeyCombo {
  code: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export type HotkeyGroup = "general" | "period" | "chart" | "drawing" | "tool";

export const HOTKEY_GROUP_LABEL: Readonly<Record<HotkeyGroup, string>> = { general: "일반", period: "봉 주기", chart: "차트", drawing: "드로잉", tool: "드로잉 도구" };

export interface HotkeyActionDef {
  readonly id: string;
  readonly name: string;
  readonly group: HotkeyGroup;
  readonly defaults: readonly KeyString[];
  readonly desktopOnly: boolean;
  readonly effect: HotkeyAction | DrawingHotkey;
}

export type HotkeyOverrides = Readonly<Record<string, readonly KeyString[]>>;

export type ActionKeys = Readonly<Record<string, readonly KeyString[]>>;

export const periodActionId = (period: Period) => `period:${period}`;
export const toolActionId = (tool: DrawingTool) => `tool:${tool}`;

const PERIOD_DEFAULT_KEYS: Partial<Record<Period, readonly KeyString[]>> = {
  "1m": ["Digit1"],
  "3m": ["Digit3"],
  "5m": ["Digit5"],
  "15m": ["Shift+Digit1"],
  "30m": ["Shift+Digit3"],
  "60m": ["Shift+Digit6"],
  D: ["KeyD"],
  W: ["KeyW"],
  M: ["KeyM"],
};

const TOOL_DEFAULT_KEYS: Partial<Record<DrawingTool, readonly KeyString[]>> = {
  trendline: ["KeyT", "Alt+KeyT"],
  hline: ["KeyH", "Alt+KeyH"],
  hray: ["Alt+KeyJ"],
  vline: ["Shift+KeyV", "Alt+KeyV"],
  rect: ["KeyR", "Alt+Shift+KeyR"],
  fib: ["KeyF", "Alt+KeyF"],
  text: ["KeyX"],
};

const action = (id: string, name: string, group: HotkeyGroup, defaults: readonly KeyString[], effect: HotkeyActionDef["effect"], desktopOnly = false): HotkeyActionDef =>
  ({ id, name, group, defaults, desktopOnly, effect });

export const HOTKEY_ACTIONS: readonly HotkeyActionDef[] = [
  action("search", "종목 검색", "general", ["Slash", "Ctrl+KeyK"], { kind: "search" }),
  ...PERIODS.map((period) => action(periodActionId(period), PERIOD_LABEL[period], "period", PERIOD_DEFAULT_KEYS[period] ?? [], { kind: "period", period })),
  action("periodPrev", "이전 봉 주기", "period", ["BracketLeft"], { kind: "periodStep", step: -1 }),
  action("periodNext", "다음 봉 주기", "period", ["BracketRight"], { kind: "periodStep", step: 1 }),
  action("toggleLog", "로그 축 켜기/끄기", "chart", ["KeyL"], { kind: "toggleLog" }),
  action("indicators", "지표 추가", "chart", ["KeyI"], { kind: "indicators" }),
  action("showWatchlist", "관심종목 창 보이기", "general", ["Alt+KeyW"], { kind: "showWatchlist" }, true),
  action("systemSettings", "시스템 설정", "general", ["Alt+Comma"], { kind: "systemSettings" }),
  action("jump", "바로가기", "chart", ["Alt+KeyG"], { kind: "jump" }),
  action("snapshotDownload", "차트 이미지 내려받기", "chart", ["Alt+KeyS"], { kind: "snapshot", mode: "download" }),
  action("snapshotCopy", "차트 이미지 복사", "chart", ["Alt+Shift+KeyS"], { kind: "snapshot", mode: "copy" }, true),
  action("select", "선택 도구", "drawing", ["KeyV"], { kind: "select" }, true),
  action("magnet", "자석 켜기/끄기", "drawing", ["KeyG"], { kind: "magnet" }, true),
  action("magnetStrength", "자석 세기 바꾸기", "drawing", ["Shift+KeyG"], { kind: "magnetStrength" }, true),
  action("hideAll", "모든 드로잉 숨기기", "drawing", ["Ctrl+Alt+KeyH"], { kind: "hideAll" }, true),
  ...TOOLS.map((tool) => action(toolActionId(tool.tool), tool.label, "tool", TOOL_DEFAULT_KEYS[tool.tool] ?? [], { kind: "tool", tool: tool.tool }, true)),
];

const ACTION_BY_ID: ReadonlyMap<string, HotkeyActionDef> = new Map(HOTKEY_ACTIONS.map((a) => [a.id, a]));

export const hotkeyAction = (id: string): HotkeyActionDef | undefined => ACTION_BY_ID.get(id);

const MODIFIER_CODES = ["ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight"];

const CODE_LABEL: Readonly<Record<string, string>> = {
  Slash: "/", Comma: ",", Period: ".", BracketLeft: "[", BracketRight: "]", Backslash: "\\", IntlBackslash: "\\", Semicolon: ";", Quote: "'", Backquote: "`", Minus: "-", Equal: "=",
  Space: "Space", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", Insert: "Insert",
  NumpadAdd: "Num +", NumpadSubtract: "Num -", NumpadMultiply: "Num *", NumpadDivide: "Num /", NumpadDecimal: "Num .",
  Escape: "Esc", Tab: "Tab", Enter: "Enter", NumpadEnter: "Enter", Delete: "Delete", Backspace: "Backspace",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
  ControlLeft: "Ctrl", ControlRight: "Ctrl", AltLeft: "Alt", AltRight: "Alt", ShiftLeft: "Shift", ShiftRight: "Shift", MetaLeft: "⌘", MetaRight: "⌘",
};

const isKnownCode = (code: string) => /^(Key[A-Z]|Digit\d|Numpad\d|F([1-9]|1[0-2]))$/.test(code) || code in CODE_LABEL;

const codeLabel = (code: string) => CODE_LABEL[code] ?? code.replace(/^(Key|Digit)/, "").replace(/^Numpad/, "Num ");

const keyStringOf = ({ code, ctrl, alt, shift }: KeyCombo): KeyString => [ctrl && "Ctrl", alt && "Alt", shift && "Shift", code].filter(Boolean).join("+");

export function comboOf(e: KeyLike): KeyCombo {
  return { code: e.code, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey, shift: e.shiftKey };
}

export const keyOf = (e: KeyLike): KeyString => keyStringOf(comboOf(e));

export function parseKey(key: unknown): KeyCombo | null {
  if (typeof key !== "string") return null;
  const parts = key.split("+");
  const code = parts.pop() ?? "";
  const combo = { code, ctrl: parts.includes("Ctrl"), alt: parts.includes("Alt"), shift: parts.includes("Shift") };
  return isKnownCode(code) && keyStringOf(combo) === key ? combo : null;
}

const LOCKED_CODES: ReadonlySet<string> = new Set(["Escape", "Tab", "Enter", "NumpadEnter", "Delete", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "F5", ...MODIFIER_CODES]);
const LOCKED_CTRL_CODES: ReadonlySet<string> = new Set(["KeyC", "KeyV", "KeyZ", "KeyY", "KeyW", "KeyT", "KeyN", "KeyR", "KeyL"]);

export function isLockedKey({ code, ctrl, alt, shift }: KeyCombo): boolean {
  return LOCKED_CODES.has(code) || (ctrl && !alt && (shift ? code === "KeyZ" : LOCKED_CTRL_CODES.has(code)));
}

export const LOCKED_KEY_LABELS: readonly string[] = ["Esc", "Tab", "Enter", "Delete", "Backspace", "방향키", "Ctrl+C", "Ctrl+V", "Ctrl+Z", "Ctrl+Y", "Ctrl+Shift+Z", "Ctrl+W", "Ctrl+T", "Ctrl+N", "Ctrl+R", "Ctrl+L", "F5", "Ctrl·Alt·Shift만 누른 것"];

const isBindableKey = (key: unknown): key is KeyString => {
  const combo = parseKey(key);
  return combo !== null && !isLockedKey(combo);
};

export function keyLabel(key: KeyString): string {
  const combo = parseKey(key);
  if (!combo) return key;
  return [combo.ctrl && "Ctrl", combo.alt && "Alt", combo.shift && "Shift", codeLabel(combo.code)].filter(Boolean).join("+");
}

export const keyCapsLabel = (key: KeyString): string => keyLabel(key).replaceAll("+", " ");

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((k, i) => k === b[i]);

const keyCache = new WeakMap<HotkeyOverrides, ActionKeys>();

export function actualKeys(overrides: HotkeyOverrides): ActionKeys {
  const cached = keyCache.get(overrides);
  if (cached) return cached;
  const keys = Object.fromEntries(HOTKEY_ACTIONS.map((a) => [a.id, overrides[a.id] ?? a.defaults]));
  keyCache.set(overrides, keys);
  return keys;
}

export const NO_HOTKEY_OVERRIDES: HotkeyOverrides = {};
export const DEFAULT_KEYS: ActionKeys = actualKeys(NO_HOTKEY_OVERRIDES);

const indexCache = new WeakMap<ActionKeys, ReadonlyMap<KeyString, HotkeyActionDef>>();

function keyIndex(keys: ActionKeys): ReadonlyMap<KeyString, HotkeyActionDef> {
  const cached = indexCache.get(keys);
  if (cached) return cached;
  const index = new Map<KeyString, HotkeyActionDef>();
  for (const a of HOTKEY_ACTIONS) for (const key of keys[a.id] ?? []) if (!index.has(key)) index.set(key, a);
  indexCache.set(keys, index);
  return index;
}

export const ownerOf = (keys: ActionKeys, key: KeyString): HotkeyActionDef | undefined => keyIndex(keys).get(key);

export function findAction(e: KeyLike, keys: ActionKeys, layout: Layout): HotkeyActionDef | null {
  const found = ownerOf(keys, keyOf(e));
  return found && (layout === "desktop" || !found.desktopOnly) ? found : null;
}

export function matchHotkey(e: KeyLike, layout: Layout, keys: ActionKeys): HotkeyAction | null {
  const effect = findAction(e, keys, layout)?.effect;
  return effect && !isDrawingHotkey(effect) ? effect : null;
}

export function matchDrawingHotkey(e: KeyLike, keys: ActionKeys): DrawingHotkey | null {
  const effect = findAction(e, keys, "desktop")?.effect;
  return effect && isDrawingHotkey(effect) ? effect : null;
}

export type AddKeyResult =
  | { kind: "added"; hotkeys: HotkeyOverrides }
  | { kind: "taken"; by: HotkeyActionDef }
  | { kind: "locked" }
  | { kind: "owned" };

const keysOf = (overrides: HotkeyOverrides, id: string): readonly KeyString[] => overrides[id] ?? hotkeyAction(id)?.defaults ?? [];

function withKeys(overrides: HotkeyOverrides, id: string, keys: readonly KeyString[]): HotkeyOverrides {
  if (sameList(keysOf(overrides, id), keys)) return overrides;
  const { [id]: _, ...rest } = overrides;
  return sameList(keys, hotkeyAction(id)?.defaults ?? []) ? rest : { ...rest, [id]: keys };
}

export function addKey(overrides: HotkeyOverrides, id: string, key: KeyString): AddKeyResult {
  if (!isBindableKey(key)) return { kind: "locked" };
  if (keysOf(overrides, id).includes(key)) return { kind: "owned" };
  const by = ownerOf(actualKeys(overrides), key);
  return by ? { kind: "taken", by } : { kind: "added", hotkeys: withKeys(overrides, id, [...keysOf(overrides, id), key]) };
}

export function moveKey(overrides: HotkeyOverrides, id: string, key: KeyString): HotkeyOverrides {
  const result = addKey(overrides, id, key);
  if (result.kind === "added") return result.hotkeys;
  if (result.kind !== "taken") return overrides;
  const without = withKeys(overrides, result.by.id, keysOf(overrides, result.by.id).filter((k) => k !== key));
  return withKeys(without, id, [...keysOf(without, id), key]);
}

export function removeKey(overrides: HotkeyOverrides, id: string, key: KeyString): HotkeyOverrides {
  return withKeys(overrides, id, keysOf(overrides, id).filter((k) => k !== key));
}

export function resetAction(overrides: HotkeyOverrides, id: string): HotkeyOverrides {
  const defaults = hotkeyAction(id)?.defaults ?? [];
  const keys = actualKeys(overrides);
  let next = overrides;
  for (const key of defaults) {
    const owner = ownerOf(keys, key);
    if (owner && owner.id !== id) next = withKeys(next, owner.id, keysOf(next, owner.id).filter((k) => k !== key));
  }
  return withKeys(next, id, defaults);
}

export const resetAllActions = (): HotkeyOverrides => NO_HOTKEY_OVERRIDES;

export function parseHotkeys(raw: unknown): { hotkeys: HotkeyOverrides; clean: boolean } {
  if (raw === undefined) return { hotkeys: NO_HOTKEY_OVERRIDES, clean: true };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { hotkeys: {}, clean: false };
  let clean = true;
  const given = new Map<string, readonly KeyString[]>();
  for (const [id, value] of Object.entries(raw)) {
    if (!ACTION_BY_ID.has(id) || !Array.isArray(value)) { clean = false; continue; }
    const kept = value.filter((key, i): key is KeyString => isBindableKey(key) && value.indexOf(key) === i);
    if (kept.length !== value.length) clean = false;
    given.set(id, kept);
  }
  const claimed = new Set<KeyString>();
  const hotkeys: Record<string, readonly KeyString[]> = {};
  for (const a of HOTKEY_ACTIONS) {
    const wanted = given.get(a.id) ?? a.defaults;
    const kept = wanted.filter((key) => !claimed.has(key));
    if (kept.length !== wanted.length) clean = false;
    kept.forEach((key) => claimed.add(key));
    if (!sameList(kept, a.defaults)) hotkeys[a.id] = kept;
  }
  return { hotkeys, clean };
}

export const shortcutOf = (keys: ActionKeys, id: string): string | undefined => {
  const key = keys[id]?.[0];
  return key === undefined ? undefined : keyLabel(key);
};

export const shortcutPreferringAlt = (keys: ActionKeys, id: string): string | undefined => {
  const list = keys[id] ?? [];
  const key = list.find((k) => parseKey(k)?.alt) ?? list[0];
  return key === undefined ? undefined : keyLabel(key);
};

export const keyTitle = (label: string, keys: ActionKeys, id: string): string => {
  const shortcut = shortcutOf(keys, id);
  return shortcut ? `${label} (${shortcut})` : label;
};

export const allShortcutsOf = (keys: ActionKeys, id: string): string => (keys[id] ?? []).map(keyLabel).join(" / ");

export const searchTitle = (keys: ActionKeys): string => {
  const shown = (keys.search ?? []).slice(0, 2).map(keyLabel).join(" 또는 ");
  return shown ? `종목 검색 (${shown})` : "종목 검색";
};
