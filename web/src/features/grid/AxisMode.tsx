import { shownScale, type PriceScale } from "../../chart/settings";
import { useCell, useLayoutStore } from "../../stores/layout";
import { AXIS_LOCKED } from "../indicator-dialog/compareForm";
import { Select, type SelectOption } from "../menu/Select";
import type { WindowId } from "../../layout/kinds";

const OPTIONS: readonly SelectOption<PriceScale>[] = [
  { value: "normal", label: "자동", hint: "가격 그대로" },
  { value: "log", label: "로그", hint: "L" },
  { value: "percent", label: "%", hint: "왼쪽 끝 봉 기준" },
];

export function AxisMode({ cellId, corner }: { cellId: WindowId; corner: { width: number; height: number } }) {
  const settings = useCell(cellId).chartSettings;
  const locked = settings.compare.length > 0;
  return <div data-chart-control className="absolute bottom-0 right-0 z-[6] flex items-center justify-center max-md:hidden" style={{ width: corner.width, height: corner.height }}>
    <Select label="가격축 방식" value={shownScale(settings)} options={OPTIONS} placement="top" disabled={locked} title={locked ? AXIS_LOCKED : undefined} className="h-6 rounded-s px-1.5 text-xs text-text-2 hover:bg-hover disabled:opacity-50 disabled:hover:bg-transparent" onChange={(scale) => useLayoutStore.getState().setScale(cellId, scale)} />
  </div>;
}
