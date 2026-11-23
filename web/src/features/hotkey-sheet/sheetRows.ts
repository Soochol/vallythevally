import { type ActionKeys, type HotkeyGroup, HOTKEY_ACTIONS, keyLabel } from "../../lib/hotkeys";

export type SheetGroupId = "find" | "chart" | "layout" | "drawing";

export const SHEET_GROUP_LABEL: Readonly<Record<SheetGroupId, string>> = { find: "찾기·이동", chart: "차트", layout: "창 배치", drawing: "드로잉" };

const SHEET_GROUPS: readonly SheetGroupId[] = ["find", "chart", "layout", "drawing"];

export interface SheetRow {
  readonly id: string;
  readonly name: string;
  readonly labels: readonly string[];
  readonly changeable: boolean;
}

export interface SheetSection {
  readonly group: SheetGroupId;
  readonly label: string;
  readonly rows: readonly SheetRow[];
}

const GROUP_OF: Readonly<Record<HotkeyGroup, SheetGroupId>> = { general: "find", period: "chart", chart: "chart", drawing: "drawing", tool: "drawing" };
const GROUP_OVERRIDES: Readonly<Record<string, SheetGroupId>> = { showWatchlist: "layout", jump: "find" };

const FIXED_ROWS: readonly { group: SheetGroupId; row: SheetRow }[] = [
  { group: "find", row: { id: "hotkey-sheet", name: "단축키 판 열기", labels: ["?"], changeable: false } },
  { group: "layout", row: { id: "layout-undo", name: "배치 되돌리기", labels: ["Ctrl+Z"], changeable: false } },
  { group: "layout", row: { id: "layout-redo", name: "다시 하기", labels: ["Ctrl+Shift+Z", "Ctrl+Y"], changeable: false } },
  { group: "drawing", row: { id: "drawing-help", name: "드로잉 단축키 도움말 (차트 위에서)", labels: ["?"], changeable: false } },
];

const squeeze = (text: string) => text.toLowerCase().replaceAll(/\s+/g, "");

export function rowMatches(row: SheetRow, query: string): boolean {
  const wanted = squeeze(query);
  return wanted === "" || squeeze(row.name).includes(wanted) || row.labels.some((label) => squeeze(label) === wanted);
}

export function sheetSections(keys: ActionKeys, query: string): readonly SheetSection[] {
  const bound = HOTKEY_ACTIONS
    .map((action) => ({ group: GROUP_OVERRIDES[action.id] ?? GROUP_OF[action.group], row: { id: action.id, name: action.name, labels: (keys[action.id] ?? []).map(keyLabel), changeable: true } }))
    .filter(({ row }) => row.labels.length > 0);
  const all = [...bound, ...FIXED_ROWS];
  return SHEET_GROUPS
    .map((group) => ({ group, label: SHEET_GROUP_LABEL[group], rows: all.filter((entry) => entry.group === group && rowMatches(entry.row, query)).map((entry) => entry.row) }))
    .filter((section) => section.rows.length > 0);
}

export const keyParts = (label: string): readonly string[] => label.split(/\+(?=.)/);
