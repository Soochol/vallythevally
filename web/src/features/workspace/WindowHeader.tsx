import { useSymbolInfo } from "../../api/queries";
import { PERIOD_LABEL } from "../../lib/symbol";
import { chartWindows, type ChartWindowState, useLayoutStore, useWindowName, type WindowState } from "../../stores/layout";
import { CloseIcon, CollapseIcon, DockIcon, ExpandIcon } from "../icons";
import { IntegratedBadge } from "../market-window/parts";
import { ScreenerBadge } from "../screener/ScreenerPanel";
import { ChartSettingsButton } from "./ChartSettingsButton";
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
      {window.kind === "screener" && <ScreenerBadge id={window.id} />}
      <IntegratedBadge id={window.id} kind={window.kind} />
      <span className="window-actions">{window.kind === "chart" && <ChartSettingsButton cellId={window.id} variant="window" />}<LinkDot window={window} selected />
        {action ? <button type="button" className="window-action" aria-label={`${name} 붙이기`} title="붙이기" onClick={action.run}><DockIcon size={14} /></button> : <button type="button" className="window-action" aria-label={`${name} ${maximized ? "원래 크기로" : "크게 보기"}`} title={maximized ? "원래 크기로" : "크게 보기"} aria-pressed={maximized} onClick={onMaximize}>{maximized ? <CollapseIcon size={14} /> : <ExpandIcon size={14} />}</button>}
        <button type="button" className="window-action" aria-label={`${name} 닫기`} title={alone ? LAST_CHART_REASON : `${name} 닫기`} disabled={alone} onClick={() => closeWindow(window.id, name)}><CloseIcon size={14} /></button>
      </span>
    </>
  );
}
