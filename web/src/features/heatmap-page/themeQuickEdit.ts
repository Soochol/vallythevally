import type { QueryClient } from "@tanstack/react-query";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { changeThemesNow } from "../../api/heatmapThemes";
import { ApiRequestError } from "../../api/http";
import { addSymbolToTheme, appendThemeCopy, MAX_THEMES, MAX_THEME_NAME_CHARS, MAX_THEME_SYMBOLS, removeSymbolFromTheme, type SymbolOutcome, type ThemeCopy } from "../../lib/heatmapThemes";
import { type ToastUndo, useSelectionStore } from "../../stores/selection";
import { activeWatchlist, useWatchlistStore } from "../../stores/watchlist";
import { useUiStore } from "../../stores/ui";

export interface ThemeChoice {
  id: string;
  name: string;
  symbols: readonly SymbolCode[];
}

const toast = (text: string) => useSelectionStore.getState().showToast(text);

const addedText = (outcome: SymbolOutcome, theme: string, symbol: string): string => {
  switch (outcome) {
    case "added": return `‘${theme}’ 테마에 추가했습니다: ${symbol}`;
    case "duplicate": return `‘${theme}’ 테마에 이미 있습니다: ${symbol}`;
    case "full": return `‘${theme}’ 테마는 종목이 ${MAX_THEME_SYMBOLS}개라 더 넣을 수 없습니다`;
    case "index": return "지수는 테마에 담을 수 없습니다";
    case "missing": return `‘${theme}’ 테마가 이미 지워졌습니다`;
  }
};

const failureText = (error: unknown) => `테마를 저장하지 못했습니다: ${error instanceof ApiRequestError ? error.message : "알 수 없는 오류가 났습니다"}`;

export async function addSymbolToThemeNow(client: QueryClient, theme: ThemeChoice, code: SymbolCode, symbolName: string): Promise<void> {
  try {
    const { result } = await changeThemesNow(client, (themes) => {
      const edit = addSymbolToTheme(themes, theme.id, code);
      return { themes: edit.themes, result: edit.outcome };
    });
    toast(addedText(result, theme.name, symbolName));
  } catch (error) {
    toast(failureText(error));
  }
}

function restoreUndo(restore: () => void): ToastUndo & { done(): void } {
  const listeners = new Set<() => void>();
  let used = false;
  const done = () => { used = true; listeners.forEach((listener) => listener()); };
  return { available: () => !used, run: () => { done(); restore(); }, subscribe: (listener) => { listeners.add(listener); return () => void listeners.delete(listener); }, done };
}

async function restoreSymbolToTheme(client: QueryClient, theme: ThemeChoice, code: SymbolCode, index: number, symbolName: string): Promise<void> {
  try {
    const { result } = await changeThemesNow(client, (themes) => {
      const target = themes.find((candidate) => candidate.id === theme.id);
      if (!target) return { themes, result: "missing" as const };
      if (target.symbols.includes(code)) return { themes, result: "duplicate" as const };
      if (target.symbols.length >= MAX_THEME_SYMBOLS) return { themes, result: "full" as const };
      const symbols = [...target.symbols.slice(0, index), code, ...target.symbols.slice(index)];
      return { themes: themes.map((candidate) => (candidate.id === theme.id ? { ...candidate, symbols } : candidate)), result: "added" as const };
    });
    toast(addedText(result, theme.name, symbolName));
  } catch (error) {
    toast(failureText(error));
  }
}

export async function removeSymbolFromThemeNow(client: QueryClient, theme: ThemeChoice, code: SymbolCode, symbolName: string): Promise<void> {
  try {
    const { result } = await changeThemesNow(client, (themes) => {
      const index = themes.find((candidate) => candidate.id === theme.id)?.symbols.indexOf(code) ?? -1;
      return { themes: removeSymbolFromTheme(themes, theme.id, code), result: index };
    });
    if (result < 0) {
      toast(`‘${theme.name}’ 테마에 이미 없습니다: ${symbolName}`);
      return;
    }
    const undo = restoreUndo(() => void restoreSymbolToTheme(client, theme, code, result, symbolName));
    useSelectionStore.getState().showToast(`‘${theme.name}’ 테마에서 뺐습니다: ${symbolName}`, undo);
  } catch (error) {
    toast(failureText(error));
  }
}

export function addToActiveWatchlist(code: SymbolCode, symbolName: string): void {
  const watchlist = activeWatchlist(useWatchlistStore.getState().lists, useUiStore.getState().prefs.activeWatchlistId);
  if (watchlist.symbols.includes(code)) {
    toast(`이미 ${watchlist.name}에 있습니다: ${symbolName}`);
    return;
  }
  useWatchlistStore.getState().add(watchlist.id, code);
  toast(`${watchlist.name}에 넣었습니다: ${symbolName}`);
}

const copiedText = (result: ThemeCopy, name: string): string => {
  switch (result.outcome) {
    case "added": return `‘${name}’ 테마를 내 테마로 가져왔습니다 (종목 ${result.kept}개${result.total > result.kept ? `, ${result.total}개 중 앞의 ${result.kept}개만` : ""})`;
    case "sameName": return `이름이 같은 내 테마가 이미 있어 가져오지 않았습니다: ${name}`;
    case "overThemeLimit": return `내 테마가 ${MAX_THEMES}개라 더 가져올 수 없습니다`;
    case "invalidName": return `테마 이름이 비었거나 ${MAX_THEME_NAME_CHARS}자를 넘어 가져올 수 없습니다: ${name}`;
  }
};

export async function copyThemeToMineNow(client: QueryClient, theme: ThemeChoice): Promise<void> {
  try {
    const { result } = await changeThemesNow(client, (themes) => {
      const copy = appendThemeCopy(themes, crypto.randomUUID(), theme.name, theme.symbols);
      return { themes: copy.themes, result: copy.result };
    });
    toast(copiedText(result, theme.name));
  } catch (error) {
    toast(failureText(error));
  }
}
