import type { SymbolCode } from "../api/generated/SymbolCode";
import type { WatchGroup } from "../api/generated/WatchGroup";
import type { Watchlist } from "../api/generated/Watchlist";

export const MAX_WATCHLISTS = 20;
export const MAX_WATCHLIST_NAME = 20;
export const MAX_WATCH_GROUPS = 20;
export const FIRST_WATCHLIST_ID = "01900000-0000-7000-8000-000000000002";
export const DEFAULT_WATCHLISTS: readonly Watchlist[] = [{ id: FIRST_WATCHLIST_ID, name: "기본", symbols: [], groups: [] }];

export const WATCH_COLUMNS = ["price", "change", "changeRate", "volume"] as const;
export type WatchColumn = (typeof WATCH_COLUMNS)[number];
export const DEFAULT_WATCH_COLUMNS: readonly WatchColumn[] = ["price", "changeRate"];
export const WATCH_COLUMN_LABEL: Record<WatchColumn, string> = { price: "현재가", change: "등락", changeRate: "등락률", volume: "거래량" };

export function addSymbol(list: readonly SymbolCode[], code: SymbolCode): readonly SymbolCode[] {
  return list.includes(code) ? list : [...list, code];
}

export function addSymbols(list: readonly SymbolCode[], codes: readonly SymbolCode[]): readonly SymbolCode[] {
  const have = new Set(list);
  const fresh = [...new Set(codes)].filter((c) => !have.has(c));
  return fresh.length === 0 ? list : [...list, ...fresh];
}

export function groupOf(list: Watchlist, code: SymbolCode): WatchGroup | null {
  return list.groups.find((g) => g.symbols.includes(code)) ?? null;
}

export function ungrouped(list: Watchlist): readonly SymbolCode[] {
  const grouped = new Set(list.groups.flatMap((g) => g.symbols));
  return grouped.size === 0 ? list.symbols : list.symbols.filter((c) => !grouped.has(c));
}

export interface WatchSection {
  group: WatchGroup | null;
  symbols: readonly SymbolCode[];
}

export function watchSections(list: Watchlist): readonly WatchSection[] {
  return [...list.groups.map((group) => ({ group, symbols: group.symbols })), { group: null, symbols: ungrouped(list) }];
}

export const displayOrder = (list: Watchlist): readonly SymbolCode[] => watchSections(list).flatMap((s) => s.symbols);

const sameCodes = (a: readonly SymbolCode[], b: readonly SymbolCode[]) => a.length === b.length && a.every((c, i) => c === b[i]);

export function sameWatchlist(a: Watchlist, b: Watchlist): boolean {
  return a.id === b.id && a.name === b.name && sameCodes(a.symbols, b.symbols) && a.groups.length === b.groups.length &&
    a.groups.every((g, i) => g.id === b.groups[i]!.id && g.name === b.groups[i]!.name && sameCodes(g.symbols, b.groups[i]!.symbols));
}

const withGroups = (list: Watchlist, f: (groups: readonly WatchGroup[]) => readonly WatchGroup[]): Watchlist => {
  const groups = f(list.groups);
  return groups === list.groups ? list : { ...list, groups: [...groups] };
};

const withoutCode = (groups: readonly WatchGroup[], code: SymbolCode): readonly WatchGroup[] =>
  groups.some((g) => g.symbols.includes(code)) ? groups.map((g) => g.symbols.includes(code) ? { ...g, symbols: g.symbols.filter((c) => c !== code) } : g) : groups;

export function removeSymbol(list: Watchlist, code: SymbolCode): Watchlist {
  if (!list.symbols.includes(code)) return list;
  return { ...list, symbols: list.symbols.filter((c) => c !== code), groups: [...withoutCode(list.groups, code)] };
}

function reorder(codes: readonly SymbolCode[], code: SymbolCode, to: number): readonly SymbolCode[] {
  const from = codes.indexOf(code);
  const target = Math.max(0, Math.min(codes.length - 1, to));
  if (from < 0 || from === target) return codes;
  const next = codes.filter((c) => c !== code);
  next.splice(target, 0, code);
  return next;
}

export function moveSymbol(list: Watchlist, code: SymbolCode, to: number): Watchlist {
  const group = groupOf(list, code);
  if (group) {
    const symbols = reorder(group.symbols, code, to);
    return symbols === group.symbols ? list : withGroups(list, (gs) => gs.map((g) => g === group ? { ...g, symbols: [...symbols] } : g));
  }
  const loose = ungrouped(list);
  const moved = reorder(loose, code, to);
  if (moved === loose) return list;
  const looseSet = new Set(loose);
  let next = 0;
  return { ...list, symbols: list.symbols.map((c) => looseSet.has(c) ? moved[next++]! : c) };
}

export function moveSymbolBy(list: Watchlist, code: SymbolCode, step: -1 | 1): Watchlist {
  const section = groupOf(list, code)?.symbols ?? ungrouped(list);
  return moveSymbol(list, code, section.indexOf(code) + step);
}

export const nextGroupName = (list: Watchlist): string => nextName(list.groups, "그룹");

export const groupNameProblem = (list: Watchlist, typed: string, self: string | null): string | null =>
  namingProblem(list.groups, typed, self, "같은 이름의 그룹이 있습니다");

export function createGroup(list: Watchlist, id: string, name: string, codes: readonly SymbolCode[] = []): Watchlist {
  if (list.groups.length >= MAX_WATCH_GROUPS || list.groups.some((g) => g.id === id || g.name === name)) return list;
  const members = [...new Set(codes)].filter((c) => list.symbols.includes(c));
  const groups = members.reduce(withoutCode, list.groups);
  return { ...list, groups: [...groups, { id, name, symbols: members }] };
}

export function renameGroup(list: Watchlist, id: string, name: string): Watchlist {
  if (!list.groups.some((g) => g.id === id && g.name !== name) || list.groups.some((g) => g.name === name)) return list;
  return withGroups(list, (gs) => gs.map((g) => g.id === id ? { ...g, name } : g));
}

export function moveGroupBy(list: Watchlist, id: string, step: -1 | 1): Watchlist {
  const from = list.groups.findIndex((g) => g.id === id);
  const to = from + step;
  if (from < 0 || to < 0 || to >= list.groups.length) return list;
  const groups = [...list.groups];
  [groups[from], groups[to]] = [groups[to]!, groups[from]!];
  return { ...list, groups };
}

export function ungroup(list: Watchlist, id: string): Watchlist {
  return withGroups(list, (gs) => gs.some((g) => g.id === id) ? gs.filter((g) => g.id !== id) : gs);
}

export function deleteGroup(list: Watchlist, id: string): Watchlist {
  const group = list.groups.find((g) => g.id === id);
  if (!group) return list;
  const gone = new Set(group.symbols);
  return { ...list, symbols: list.symbols.filter((c) => !gone.has(c)), groups: list.groups.filter((g) => g !== group) };
}

export function assignGroup(list: Watchlist, code: SymbolCode, groupId: string | null): Watchlist {
  const current = groupOf(list, code);
  if (!list.symbols.includes(code) || (current?.id ?? null) === groupId || (groupId !== null && !list.groups.some((g) => g.id === groupId))) return list;
  return withGroups(list, (gs) => withoutCode(gs, code).map((g) => g.id === groupId ? { ...g, symbols: [...g.symbols, code] } : g));
}

export function duplicateWatchlist(original: Watchlist, id: string, name: string, newId: () => string): Watchlist {
  return { id, name, symbols: [...original.symbols], groups: original.groups.map((g) => ({ id: newId(), name: g.name, symbols: [...g.symbols] })) };
}

interface Named {
  id: string;
  name: string;
}

function nextName(items: readonly Named[], prefix: string): string {
  const taken = new Set(items.map((l) => l.name));
  for (let n = 1; ; n++) if (!taken.has(`${prefix} ${n}`)) return `${prefix} ${n}`;
}

export const nextListName = (lists: readonly Watchlist[]): string => nextName(lists, "목록");

export function listNameFrom(lists: readonly Watchlist[], base: string): string {
  const taken = new Set(lists.map((l) => l.name));
  const cut = (room: number) => [...base.trim()].slice(0, room).join("").trim();
  const whole = cut(MAX_WATCHLIST_NAME);
  if (!taken.has(whole)) return whole;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const name = cut(MAX_WATCHLIST_NAME - suffix.length) + suffix;
    if (!taken.has(name)) return name;
  }
}

function namingProblem(items: readonly Named[], typed: string, self: string | null, taken: string): string | null {
  const name = typed.trim();
  if (name === "") return "이름을 입력하세요";
  if ([...name].length > MAX_WATCHLIST_NAME) return `이름은 ${MAX_WATCHLIST_NAME}자까지입니다`;
  if (items.some((l) => l.name === name && l.id !== self)) return taken;
  return null;
}

export const nameProblem = (lists: readonly Watchlist[], typed: string, self: string | null): string | null =>
  namingProblem(lists, typed, self, "같은 이름의 목록이 있습니다");

export type Transfer = "move" | "copy";

export function transferSymbol(lists: readonly Watchlist[], from: string, to: string, code: SymbolCode, how: Transfer): readonly Watchlist[] {
  const source = lists.find((l) => l.id === from);
  const target = lists.find((l) => l.id === to);
  if (from === to || !source?.symbols.includes(code) || target === undefined) return lists;
  const alreadyInTarget = target.symbols.includes(code);
  if (how === "copy" && alreadyInTarget) return lists;
  return lists.map((l) => {
    if (l.id === to) return alreadyInTarget ? l : { ...l, symbols: [...l.symbols, code] };
    if (l.id === from && how === "move") return removeSymbol(l, code);
    return l;
  });
}

const isCodes = (x: unknown): x is SymbolCode[] => Array.isArray(x) && x.every((s) => typeof s === "string");

const isNamedCodes = (x: unknown): x is Named & { symbols: SymbolCode[] } =>
  typeof x === "object" && x !== null && typeof (x as WatchGroup).id === "string" && typeof (x as WatchGroup).name === "string" && isCodes((x as WatchGroup).symbols);

export function parseWatchlists(x: unknown): Watchlist[] | null {
  if (!Array.isArray(x) || x.length === 0 || !x.every(isNamedCodes)) return null;
  const lists: Watchlist[] = [];
  for (const l of x) {
    const groups: unknown = (l as { groups?: unknown }).groups ?? [];
    if (!Array.isArray(groups) || !groups.every(isNamedCodes)) return null;
    const members = new Set(l.symbols);
    const taken = new Set<SymbolCode>();
    lists.push({
      id: l.id,
      name: l.name,
      symbols: l.symbols,
      groups: groups.map((g) => ({ id: g.id, name: g.name, symbols: g.symbols.filter((c) => members.has(c) && !taken.has(c) && taken.add(c)) })),
    });
  }
  return lists;
}
