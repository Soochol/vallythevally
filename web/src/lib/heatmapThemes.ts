import type { HeatmapTheme } from "../api/generated/HeatmapTheme";
import type { SymbolCode } from "../api/generated/SymbolCode";
import type { Watchlist } from "../api/generated/Watchlist";
import { isIndexCode } from "./symbol";

export const MAX_THEMES = 100;
export const MAX_THEME_SYMBOLS = 60;
export const MAX_THEME_NAME_CHARS = 40;

export type ThemeEdit = { ok: true; themes: HeatmapTheme[] } | { ok: false; problem: string };
export type SymbolOutcome = "added" | "duplicate" | "full" | "index" | "missing";

const nameLength = (name: string) => [...name].length;

export function themeNameProblem(name: string, themes: readonly HeatmapTheme[], selfId: string | null): string | null {
  if (name.trim() === "") return "테마 이름을 적어 주세요";
  if (name !== name.trim()) return "테마 이름 앞뒤에 공백을 둘 수 없습니다";
  if (nameLength(name) > MAX_THEME_NAME_CHARS) return `테마 이름은 ${MAX_THEME_NAME_CHARS}자까지입니다`;
  if (themes.some((theme) => theme.id !== selfId && theme.name === name)) return `같은 이름의 테마가 이미 있습니다: ${name}`;
  return null;
}

export function themesProblem(themes: readonly HeatmapTheme[]): string | null {
  if (themes.length > MAX_THEMES) return `테마는 ${MAX_THEMES}개까지 둘 수 있습니다`;
  for (const theme of themes) {
    const name = themeNameProblem(theme.name, themes, theme.id);
    if (name !== null) return name;
    if (theme.symbols.length > MAX_THEME_SYMBOLS) return `‘${theme.name}’ 테마는 종목을 ${MAX_THEME_SYMBOLS}개까지 담을 수 있습니다`;
    if (new Set(theme.symbols).size !== theme.symbols.length) return `‘${theme.name}’ 테마에 같은 종목이 두 번 들어 있습니다`;
    if (theme.symbols.some(isIndexCode)) return `‘${theme.name}’ 테마에는 지수를 담을 수 없습니다`;
  }
  return null;
}

export function sameThemes(a: readonly HeatmapTheme[], b: readonly HeatmapTheme[]): boolean {
  return a.length === b.length && a.every((theme, i) => {
    const other = b[i]!;
    return theme.id === other.id && theme.name === other.name && theme.symbols.length === other.symbols.length && theme.symbols.every((code, j) => code === other.symbols[j]);
  });
}

export const nextRevision = (stored: number, now: number = Date.now()): number => Math.max(stored + 1, now);

export function createTheme(themes: readonly HeatmapTheme[], id: string, name: string): ThemeEdit {
  if (themes.length >= MAX_THEMES) return { ok: false, problem: `테마는 ${MAX_THEMES}개까지 만들 수 있습니다` };
  const problem = themeNameProblem(name, themes, null);
  return problem === null ? { ok: true, themes: [...themes, { id, name, symbols: [] }] } : { ok: false, problem };
}

export function renameTheme(themes: readonly HeatmapTheme[], id: string, name: string): ThemeEdit {
  const target = themes.find((theme) => theme.id === id);
  if (!target || target.name === name) return { ok: true, themes: [...themes] };
  const problem = themeNameProblem(name, themes, id);
  return problem === null ? { ok: true, themes: themes.map((theme) => (theme.id === id ? { ...theme, name } : theme)) } : { ok: false, problem };
}

export const deleteTheme = (themes: readonly HeatmapTheme[], id: string): HeatmapTheme[] => themes.filter((theme) => theme.id !== id);

export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= items.length || to < 0 || to >= items.length) return [...items];
  const next = [...items];
  next.splice(to, 0, next.splice(from, 1)[0]!);
  return next;
}

const editTheme = (themes: readonly HeatmapTheme[], id: string, edit: (theme: HeatmapTheme) => HeatmapTheme): HeatmapTheme[] =>
  themes.map((theme) => (theme.id === id ? edit(theme) : theme));

export function addSymbolToTheme(themes: readonly HeatmapTheme[], id: string, code: SymbolCode): { themes: HeatmapTheme[]; outcome: SymbolOutcome } {
  const target = themes.find((theme) => theme.id === id);
  const unchanged = (outcome: SymbolOutcome) => ({ themes: [...themes], outcome });
  if (!target) return unchanged("missing");
  if (isIndexCode(code)) return unchanged("index");
  if (target.symbols.includes(code)) return unchanged("duplicate");
  if (target.symbols.length >= MAX_THEME_SYMBOLS) return unchanged("full");
  return { themes: editTheme(themes, id, (theme) => ({ ...theme, symbols: [...theme.symbols, code] })), outcome: "added" };
}

export const removeSymbolFromTheme = (themes: readonly HeatmapTheme[], id: string, code: SymbolCode): HeatmapTheme[] =>
  editTheme(themes, id, (theme) => (theme.symbols.includes(code) ? { ...theme, symbols: theme.symbols.filter((held) => held !== code) } : theme));

export const moveSymbol = (themes: readonly HeatmapTheme[], id: string, from: number, to: number): HeatmapTheme[] =>
  editTheme(themes, id, (theme) => ({ ...theme, symbols: moveItem(theme.symbols, from, to) }));

export type ThemeCopy =
  | { outcome: "added"; kept: number; total: number }
  | { outcome: "sameName" | "invalidName" | "overThemeLimit" };

export function appendThemeCopy(themes: readonly HeatmapTheme[], id: string, name: string, symbols: readonly SymbolCode[]): { themes: HeatmapTheme[]; result: ThemeCopy } {
  const trimmed = name.trim();
  const unchanged = (outcome: "sameName" | "invalidName" | "overThemeLimit") => ({ themes: [...themes], result: { outcome } as const });
  if (themes.some((theme) => theme.name === trimmed)) return unchanged("sameName");
  if (themes.length >= MAX_THEMES) return unchanged("overThemeLimit");
  if (themeNameProblem(trimmed, themes, null) !== null) return unchanged("invalidName");
  const stocks = [...new Set(symbols)].filter((code) => !isIndexCode(code));
  const kept = stocks.slice(0, MAX_THEME_SYMBOLS);
  return { themes: [...themes, { id, name: trimmed, symbols: kept }], result: { outcome: "added", kept: kept.length, total: stocks.length } };
}

export interface ImportReport {
  imported: string[];
  sameName: string[];
  invalidName: string[];
  overThemeLimit: string[];
  truncated: { name: string; kept: number; total: number }[];
  indexDropped: { name: string; count: number }[];
}

export function importWatchlistGroups(themes: readonly HeatmapTheme[], list: Watchlist, newId: () => string): { themes: HeatmapTheme[]; report: ImportReport } {
  const report: ImportReport = { imported: [], sameName: [], invalidName: [], overThemeLimit: [], truncated: [], indexDropped: [] };
  const next = [...themes];
  for (const group of list.groups) {
    const name = group.name.trim();
    if (name === "" || nameLength(name) > MAX_THEME_NAME_CHARS) {
      report.invalidName.push(group.name);
      continue;
    }
    if (next.some((theme) => theme.name === name)) {
      report.sameName.push(name);
      continue;
    }
    if (next.length >= MAX_THEMES) {
      report.overThemeLimit.push(name);
      continue;
    }
    const unique = [...new Set(group.symbols)];
    const stocks = unique.filter((code) => !isIndexCode(code));
    if (stocks.length < unique.length) report.indexDropped.push({ name, count: unique.length - stocks.length });
    if (stocks.length > MAX_THEME_SYMBOLS) report.truncated.push({ name, kept: MAX_THEME_SYMBOLS, total: stocks.length });
    next.push({ id: newId(), name, symbols: stocks.slice(0, MAX_THEME_SYMBOLS) });
    report.imported.push(name);
  }
  return { themes: next, report };
}

export function importNotices(listName: string, groupCount: number, report: ImportReport): string[] {
  if (groupCount === 0) return [`‘${listName}’ 목록에는 그룹이 없어 가져올 테마가 없습니다.`];
  const notices = [`‘${listName}’ 목록에서 테마 ${report.imported.length}개를 가져왔습니다.`];
  if (report.sameName.length > 0) notices.push(`이름이 같은 테마가 이미 있어 건너뜀: ${report.sameName.join(", ")}`);
  if (report.invalidName.length > 0) notices.push(`이름이 비었거나 ${MAX_THEME_NAME_CHARS}자를 넘어 건너뜀: ${report.invalidName.map((name) => `‘${name}’`).join(", ")}`);
  if (report.overThemeLimit.length > 0) notices.push(`테마가 ${MAX_THEMES}개를 넘어 건너뜀: ${report.overThemeLimit.join(", ")}`);
  for (const { name, kept, total } of report.truncated) notices.push(`‘${name}’ 그룹은 종목이 ${total}개라 앞의 ${kept}개만 넣었습니다.`);
  for (const { name, count } of report.indexDropped) notices.push(`‘${name}’ 그룹의 지수 ${count}개는 뺐습니다.`);
  return notices;
}
