import { useSymbolInfo } from "../../api/queries";
import { PERIOD_LABEL } from "../../lib/symbol";
import { chartWindows, type ChartWindowState, useLayoutStore, useWindowName, type WindowState } from "../../stores/layout";
import { CloseIcon, ExpandIcon } from "../icons";
import { IntegratedBadge, showsIntegratedBadge } from "../market-window/parts";
import { LinkDot } from "./LinkDot";
import { closeWindow, LAST_CHART_REASON } from "./manage";

function ChartTitle({ window }: { window: ChartWindowState }) {
  const name = useSymbolInfo(window.symbol).data?.name ?? window.symbol;
  return <><span className="window-title">{name}</span><span className="dock-tab-sub">{PERIOD_LABEL[window.period]}</span></>;
}

type HeaderProps = { window: WindowState } & ({ action: { kind: "attach"; run(): void }; maximized?: never; onMaximize?: never } | { action?: never; maximized: boolean; onMaximize(): void });

export function WindowHeader({ window, maximized, onMaximize, action }: HeaderProps) {
  const alone = useLayoutStore((s) => window.kind === "chart" && chartWindows(s.layout).length <= 1);
  const name = useWindowName(window);
  return (
    <>
      {window.kind === "chart" ? <ChartTitle window={window} /> : <span className="window-title">{name}</span>}
      {showsIntegratedBadge(window.kind) && <IntegratedBadge />}
      <span className="window-actions"><LinkDot window={window} selected />
        {action ? <button type="button" className="window-action window-attach" aria-label={`${name} 붙이기`} title="붙이기" onClick={action.run}>붙이기</button> : <button type="button" className="window-action" aria-label={`${name} ${maximized ? "원래 크기로" : "크게 보기"}`} title={maximized ? "원래 크기로" : "크게 보기"} aria-pressed={maximized} onClick={onMaximize}><ExpandIcon size={14} /></button>}
        <button type="button" className="window-action" aria-label={`${name} 닫기`} title={alone ? LAST_CHART_REASON : `${name} 닫기`} disabled={alone} onClick={() => closeWindow(window.id, name)}><CloseIcon size={14} /></button>
      </span>
    </>
  );
}
