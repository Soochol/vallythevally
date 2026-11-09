import type { SymbolCode } from "../api/generated/SymbolCode";

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
