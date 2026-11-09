import type { SymbolCode } from "../api/generated/SymbolCode";

// 관심종목 목록 다루기. 모두 새 배열을 돌려주고, 바뀌는 것이 없으면 받은 배열을 그대로 돌려준다.

/** 끝에 넣는다. 이미 있으면 그대로다(서버는 중복을 400으로 거절한다). */
export function addSymbol(list: readonly SymbolCode[], code: SymbolCode): readonly SymbolCode[] {
  return list.includes(code) ? list : [...list, code];
}

export function removeSymbol(list: readonly SymbolCode[], code: SymbolCode): readonly SymbolCode[] {
  return list.includes(code) ? list.filter((c) => c !== code) : list;
}

/** code를 to 자리로 옮긴다(끌어 놓기). to는 목록 안으로 자른다. */
export function moveSymbol(list: readonly SymbolCode[], code: SymbolCode, to: number): readonly SymbolCode[] {
  const from = list.indexOf(code);
  const target = Math.max(0, Math.min(list.length - 1, to));
  if (from < 0 || from === target) return list;
  const next = list.filter((c) => c !== code);
  next.splice(target, 0, code);
  return next;
}

/** 한 칸 위(-1)나 아래(+1)로(Alt+↑/↓). 끝에서는 그대로다. */
export const moveSymbolBy = (list: readonly SymbolCode[], code: SymbolCode, step: -1 | 1) =>
  moveSymbol(list, code, list.indexOf(code) + step);
