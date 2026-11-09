import type { SymbolCode } from "../api/generated/SymbolCode";
import type { Watchlist } from "../api/generated/Watchlist";

export const MAX_WATCHLISTS = 20;
export const MAX_WATCHLIST_NAME = 20;
export const FIRST_WATCHLIST_ID = "01900000-0000-7000-8000-000000000002";
export const DEFAULT_WATCHLISTS: readonly Watchlist[] = [{ id: FIRST_WATCHLIST_ID, name: "기본", symbols: [] }];

export const WATCH_COLUMNS = ["price", "change", "changeRate", "volume"] as const;
export type WatchColumn = (typeof WATCH_COLUMNS)[number];
export const DEFAULT_WATCH_COLUMNS: readonly WatchColumn[] = ["price", "changeRate"];
export const WATCH_COLUMN_LABEL: Record<WatchColumn, string> = { price: "현재가", change: "등락", changeRate: "등락률", volume: "거래량" };

export function addSymbol(list: readonly SymbolCode[], code: SymbolCode): readonly SymbolCode[] {
  return list.includes(code) ? list : [...list, code];
}

export function removeSymbol(list: readonly SymbolCode[], code: SymbolCode): readonly SymbolCode[] {
  return list.includes(code) ? list.filter((c) => c !== code) : list;
}

export function moveSymbol(list: readonly SymbolCode[], code: SymbolCode, to: number): readonly SymbolCode[] {
  const from = list.indexOf(code);
  const target = Math.max(0, Math.min(list.length - 1, to));
  if (from < 0 || from === target) return list;
  const next = list.filter((c) => c !== code);
  next.splice(target, 0, code);
  return next;
}

export const moveSymbolBy = (list: readonly SymbolCode[], code: SymbolCode, step: -1 | 1) =>
  moveSymbol(list, code, list.indexOf(code) + step);

export function nextListName(lists: readonly Watchlist[]): string {
  const taken = new Set(lists.map((l) => l.name));
  for (let n = 1; ; n++) if (!taken.has(`목록 ${n}`)) return `목록 ${n}`;
}

/** 이름을 쓸 수 없으면 그 까닭을, 쓸 수 있으면 null. `name`은 앞뒤 공백을 지운 값이어야 한다. */
export function nameProblem(lists: readonly Watchlist[], name: string, self: string | null): string | null {
  if (name === "") return "이름을 입력하세요";
  if ([...name].length > MAX_WATCHLIST_NAME) return `이름은 ${MAX_WATCHLIST_NAME}자까지입니다`;
  if (lists.some((l) => l.name === name && l.id !== self)) return "같은 이름의 목록이 있습니다";
  return null;
}

export type Transfer = "move" | "copy";

/** 대상 목록의 끝에 붙인다. 이미 있으면 붙이지 않고, 옮기기는 원래 목록에서 빼기만 한다. */
export function transferSymbol(lists: readonly Watchlist[], from: string, to: string, code: SymbolCode, how: Transfer): readonly Watchlist[] {
  const target = lists.find((l) => l.id === to);
  const inTarget = target?.symbols.includes(code) ?? true;
  if (from === to || target === undefined || !lists.some((l) => l.id === from && l.symbols.includes(code)) || (how === "copy" && inTarget)) return lists;
  return lists.map((l) => {
    if (l.id === to) return inTarget ? l : { ...l, symbols: [...l.symbols, code] };
    if (l.id === from && how === "move") return { ...l, symbols: [...removeSymbol(l.symbols, code)] };
    return l;
  });
}

export function isWatchlists(x: unknown): x is Watchlist[] {
  return (
    Array.isArray(x) &&
    x.length > 0 &&
    x.every(
      (l: unknown) =>
        typeof l === "object" &&
        l !== null &&
        typeof (l as Watchlist).id === "string" &&
        typeof (l as Watchlist).name === "string" &&
        Array.isArray((l as Watchlist).symbols) &&
        (l as Watchlist).symbols.every((s) => typeof s === "string"),
    )
  );
}
