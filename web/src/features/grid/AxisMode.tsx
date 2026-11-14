import { shownScale } from "../../chart/settings";
import { useCell, useLayoutStore } from "../../stores/layout";
import { AXIS_LOCKED, LOG_LOCKED, pressScale } from "../indicator-dialog/compareForm";
import type { WindowId } from "../../layout/kinds";

export function AxisMode({ cellId }: { cellId: WindowId }) {
  const settings = useCell(cellId).chartSettings;
  const shown = shownScale(settings);
  const locked = settings.compare.length > 0;
  const press = (button: "log" | "percent") => {
    const next = pressScale(settings, button);
    if (next) useLayoutStore.getState().setScale(cellId, next);
  };
  return <div role="group" aria-label="가격축 방식" data-chart-control className="ui-island absolute bottom-9 right-20 z-[6] flex gap-px rounded-m p-0.5 max-md:hidden">
    <button type="button" className="seg-btn !h-6 disabled:cursor-not-allowed disabled:opacity-50" aria-pressed={shown === "normal"} disabled={locked} title={locked ? AXIS_LOCKED : "가격 그대로"} onClick={() => useLayoutStore.getState().setScale(cellId, "normal")}>자동</button>
    <button type="button" className="seg-btn !h-6 disabled:cursor-not-allowed disabled:opacity-50" aria-pressed={shown === "log"} disabled={locked} title={locked ? LOG_LOCKED : "로그 축 (L)"} onClick={() => press("log")}>로그</button>
    <button type="button" className="seg-btn !h-6 disabled:cursor-not-allowed disabled:opacity-50" aria-pressed={shown === "percent"} disabled={locked} title={locked ? AXIS_LOCKED : "가격축을 화면 왼쪽 끝 봉 기준 % 변화로"} onClick={() => press("percent")}>%</button>
  </div>;
}
