import { useQuery } from "@tanstack/react-query";
import { financialsQuery } from "../../api/financials";
import { financialStatus, financialSummary } from "../../chart/financials";
import { financialRequest } from "../../chart/indicators/shown";
import { useShownSettings } from "../indicator-command/preview";
import { useCell } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";

export function FinancialStatus() {
  const cellId = useSelectionStore((s) => s.activeCell);
  const cell = useCell(cellId);
  const { settings } = useShownSettings(cellId, cell.chartSettings);
  const request = financialRequest(cell.period, settings);
  const query = useQuery({ ...financialsQuery({ symbol: cell.symbol, period: request.period }), enabled: false });
  if (!request.enabled) return null;
  const data = query.data;
  if (query.error) return <span aria-label="재무 수집 상태" className="truncate text-warning" title={String(query.error)}>재무자료 조회 실패</span>;
  if (!data) return <span aria-label="재무 수집 상태" className="truncate">재무자료 조회 중</span>;
  const { completed, total, failed } = data.progress;
  return <span aria-label="재무 수집 상태" className="flex min-w-0 items-center gap-2" title={financialSummary(data)}>
    <span className="truncate">{financialStatus(data.status)}</span>
    {data.status === "collecting" && <>
      <progress aria-label="재무 수집 진행률" className="h-1 w-16 flex-none accent-warning" value={completed} max={Math.max(1, total)} />
      <span>{completed}/{total}</span>
    </>}
    <span className={failed > 0 ? "text-warning" : "text-text-3"}>실패 {failed}</span>
  </span>;
}
