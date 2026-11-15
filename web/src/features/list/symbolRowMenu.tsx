import type { SymbolCode } from "../../api/generated/SymbolCode";
import { compareRefusal } from "../../chart/settings";
import type { ChartWindowState } from "../../stores/layout";
import { useLayoutStore } from "../../stores/layout";
import type { WindowId } from "../../layout/kinds";
import { useSelectionStore } from "../../stores/selection";
import { ChartIcon, CopyIcon, PlusIcon } from "../icons";
import type { MenuItem } from "../menu/Menu";

const COMPARE_REFUSAL_TEXT = { full: "비교 종목은 3개까지입니다", main: "현재 종목은 비교에 추가할 수 없습니다", dup: "이미 비교에 있습니다" } as const;

const toast = (text: string) => useSelectionStore.getState().showToast(text);

export function addRowToCompare(cellId: WindowId, cell: Pick<ChartWindowState, "chartSettings" | "symbol">, code: SymbolCode, name: string) {
  const refusal = compareRefusal(cell.chartSettings, code, cell.symbol);
  if (refusal) return toast(COMPARE_REFUSAL_TEXT[refusal]);
  useLayoutStore.getState().addCompare(cellId, code);
  toast(`비교에 추가했습니다: ${name}`);
}

export async function copySymbolCode(code: SymbolCode) {
  try {
    await navigator.clipboard.writeText(code);
  } catch {
    return toast("종목코드를 복사하지 못했습니다");
  }
  toast(`종목코드를 복사했습니다: ${code}`);
}

interface SymbolRowMenuItems {
  name: string;
  code: SymbolCode;
  onOpen(): void;
  onCompare(): void;
}

export function symbolRowMenuItems({ name, code, onOpen, onCompare }: SymbolRowMenuItems) {
  return {
    heading: { kind: "heading", label: `${name} ${code}` } satisfies MenuItem,
    open: { kind: "action", label: "이 칸에 열기", icon: <ChartIcon />, hint: "↵", onSelect: onOpen } satisfies MenuItem,
    compare: { kind: "action", label: "비교에 추가", icon: <PlusIcon />, hint: "Shift+↵", onSelect: onCompare } satisfies MenuItem,
    copyCode: { kind: "action", label: "종목코드 복사", icon: <CopyIcon />, onSelect: () => void copySymbolCode(code) } satisfies MenuItem,
  };
}
