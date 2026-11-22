import type { QueryClient } from "@tanstack/react-query";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { changeThemesNow } from "../../api/heatmapThemes";
import { ApiRequestError } from "../../api/http";
import { addSymbolToTheme, MAX_THEME_SYMBOLS, removeSymbolFromTheme, type SymbolOutcome } from "../../lib/heatmapThemes";
import { useSelectionStore } from "../../stores/selection";

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

export async function removeSymbolFromThemeNow(client: QueryClient, theme: ThemeChoice, code: SymbolCode, symbolName: string): Promise<void> {
  try {
    const { result } = await changeThemesNow(client, (themes) => {
      const held = themes.find((candidate) => candidate.id === theme.id)?.symbols.includes(code) ?? false;
      return { themes: removeSymbolFromTheme(themes, theme.id, code), result: held };
    });
    toast(result ? `‘${theme.name}’ 테마에서 뺐습니다: ${symbolName}` : `‘${theme.name}’ 테마에 이미 없습니다: ${symbolName}`);
  } catch (error) {
    toast(failureText(error));
  }
}
