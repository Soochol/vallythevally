import { type ActionKeys, type HotkeyActionDef, type HotkeyGroup, HOTKEY_ACTIONS, HOTKEY_GROUP_LABEL, keyCapsLabel, keyLabel, parseKey } from "../../lib/hotkeys";

export interface HotkeyGroupRows {
  readonly group: HotkeyGroup;
  readonly label: string;
  readonly actions: readonly HotkeyActionDef[];
}

export const LOCKED_KEY_ROWS: readonly (readonly [keys: string, what: string])[] = [
  ["Esc", "그리기 끝내기 · 창 닫기"],
  ["Delete · Backspace", "고른 드로잉 지우기"],
  ["Ctrl+C · Ctrl+V", "드로잉 복사 · 붙여넣기 (Shift·Alt를 더한 것 포함)"],
  ["Ctrl+Z · Ctrl+Y", "되돌리기 · 다시 하기 (Shift·Alt를 더한 것 포함)"],
  ["방향키", "고른 드로잉 옮기기"],
  ["Shift+/", "드로잉 단축키 도움말"],
  ["Ctrl+W · T · N · R · L · F5", "브라우저가 쓰는 키"],
  ["Tab · Enter", "화면 이동과 선택"],
];

const squeeze = (text: string) => text.toLowerCase().replaceAll(/\s+/g, "");

export function actionMatches(action: HotkeyActionDef, keys: ActionKeys, query: string): boolean {
  const wanted = squeeze(query);
  if (!wanted) return true;
  return squeeze(action.name).includes(wanted) || (keys[action.id] ?? []).some((key) => squeeze(keyLabel(key)) === wanted);
}

export function groupedRows(keys: ActionKeys, query: string): readonly HotkeyGroupRows[] {
  return (Object.keys(HOTKEY_GROUP_LABEL) as HotkeyGroup[])
    .map((group) => ({ group, label: HOTKEY_GROUP_LABEL[group], actions: HOTKEY_ACTIONS.filter((a) => a.group === group && actionMatches(a, keys, query)) }))
    .filter((rows) => rows.actions.length > 0);
}

export function lockedReason(key: string): string {
  const combo = parseKey(key);
  if (!combo) return "";
  const { code, ctrl } = combo;
  if (code === "Escape") return "그리기 끝내기와 창 닫기에 쓰는 키입니다";
  if (code === "Delete" || code === "Backspace") return "고른 드로잉 지우기에 쓰는 키입니다";
  if (code.startsWith("Arrow")) return "고른 드로잉 옮기기에 쓰는 키입니다";
  if (code === "Tab" || code === "Enter" || code === "NumpadEnter") return "화면 이동과 선택에 쓰는 키입니다";
  if (code === "Slash") return "드로잉 단축키 도움말을 여는 키입니다";
  if (ctrl && (code === "KeyC" || code === "KeyV")) return "드로잉 복사·붙여넣기에 쓰는 키입니다";
  if (ctrl && (code === "KeyZ" || code === "KeyY")) return "되돌리기·다시 하기에 쓰는 키입니다";
  return "브라우저가 쓰는 키입니다";
}

const MODIFIER_LABELS: ReadonlySet<string> = new Set(["Ctrl", "Alt", "Shift"]);

export function keyPieces(key: string): string[] {
  const tokens = keyCapsLabel(key).split(" ");
  let modifiers = 0;
  while (modifiers < tokens.length - 1 && MODIFIER_LABELS.has(tokens[modifiers]!)) modifiers++;
  return [...tokens.slice(0, modifiers), tokens.slice(modifiers).join(" ")];
}

export const lockedKeyPieces = (keysText: string): string[][] => keysText.split(" · ").map((group) => group.split("+"));
