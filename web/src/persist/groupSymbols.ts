import type { LinkColor } from "../api/generated/LinkColor";
import type { SymbolCode } from "../api/generated/SymbolCode";
import { LINK_COLORS } from "../api/linkColors";
import { WINDOW_KINDS } from "../layout/kinds";
import type { EditableLayout } from "../stores/layout";

export type GroupSymbols = Partial<Record<LinkColor, SymbolCode>>;

type StoredGroupSymbols = { v: 1; symbols: GroupSymbols };

const SYMBOL_CODE_PATTERN = /^(?:[0-9A-Z]{6}|IDX:[0-9]{3})$/;

export const groupSymbolsKey = (layoutId: string) => `vv.group-symbols.${layoutId}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSymbolCode(value: unknown): value is SymbolCode {
  return typeof value === "string" && SYMBOL_CODE_PATTERN.test(value);
}

function chartlessFollowsLinks(layout: EditableLayout): Set<LinkColor> {
  const chartLinks = new Set<LinkColor>();
  const followsLinks = new Set<LinkColor>();
  for (const window of layout.windows) {
    if (window.link === null) continue;
    if (window.kind === "chart") chartLinks.add(window.link);
    else if (WINDOW_KINDS[window.kind].link === "follows") followsLinks.add(window.link);
  }
  for (const link of chartLinks) followsLinks.delete(link);
  return followsLinks;
}

export function readGroupSymbols(layout: EditableLayout): GroupSymbols {
  const symbols: GroupSymbols = {};
  try {
    const raw = globalThis.localStorage?.getItem(groupSymbolsKey(layout.id));
    if (!raw) return symbols;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.v !== 1 || !isRecord(parsed.symbols)) return symbols;
    const allowed = chartlessFollowsLinks(layout);
    for (const link of LINK_COLORS) {
      if (!allowed.has(link) || !Object.prototype.hasOwnProperty.call(parsed.symbols, link)) continue;
      const value = parsed.symbols[link];
      if (isSymbolCode(value)) symbols[link] = value;
    }
  } catch {
    return {};
  }
  return symbols;
}

export function writeGroupSymbols(layout: EditableLayout, groupSymbols: GroupSymbols): void {
  try {
    const key = groupSymbolsKey(layout.id);
    const allowed = chartlessFollowsLinks(layout);
    const symbols: GroupSymbols = {};
    let count = 0;
    for (const link of LINK_COLORS) {
      if (!allowed.has(link)) continue;
      const code = groupSymbols[link];
      if (code !== undefined && isSymbolCode(code)) {
        symbols[link] = code;
        count += 1;
      }
    }
    if (count === 0) {
      globalThis.localStorage?.removeItem(key);
      return;
    }
    const stored: StoredGroupSymbols = { v: 1, symbols };
    globalThis.localStorage?.setItem(key, JSON.stringify(stored));
  } catch {
    return;
  }
}

export function clearGroupSymbols(layoutId: string): void {
  try {
    globalThis.localStorage?.removeItem(groupSymbolsKey(layoutId));
  } catch {
    return;
  }
}
