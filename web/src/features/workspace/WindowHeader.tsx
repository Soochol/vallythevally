import { useSymbolInfo } from "../../api/queries";
import { WINDOW_KINDS } from "../../layout/kinds";
import { PERIOD_LABEL } from "../../lib/symbol";
import { chartWindows, type ChartWindowState, useLayoutStore, type WindowState } from "../../stores/layout";
import { CloseIcon, ExpandIcon } from "../icons";
import { LinkDot } from "./LinkDot";
import { closeWindow, LAST_CHART_REASON } from "./manage";

function ChartTitle({ window }: { window: ChartWindowState }) {
  const name = useSymbolInfo(window.symbol).data?.name ?? window.symbol;
  return <><span className="window-title">{name}</span><span className="dock-tab-sub">{PERIOD_LABEL[window.period]}</span></>;
}

export function WindowHeader({ window, maximized, onMaximize }: { window: WindowState; maximized: boolean; onMaximize(): void }) {
  const alone = useLayoutStore((s) => window.kind === "chart" && chartWindows(s.layout).length <= 1);
  const name = WINDOW_KINDS[window.kind].name;
  return (
    <>
      {window.kind === "chart" ? <ChartTitle window={window} /> : <span className="window-title">{name}</span>}
      <span className="window-actions"><LinkDot window={window} selected />
        <button type="button" className="window-action" aria-label={`${name} ${maximized ? "원래 크기로" : "크게 보기"}`} title={maximized ? "원래 크기로" : "크게 보기"} aria-pressed={maximized} onClick={onMaximize}><ExpandIcon size={14} /></button>
        <button type="button" className="window-action" aria-label={`${name} 닫기`} title={alone ? LAST_CHART_REASON : `${name} 닫기`} disabled={alone} onClick={() => closeWindow(window.id, name)}><CloseIcon size={14} /></button>
      </span>
    </>
  );
}
