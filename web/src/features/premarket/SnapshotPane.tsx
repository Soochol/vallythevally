import { useMemo, useState } from "react";
import type { PreMarketSnapshot } from "../../api/generated/PreMarketSnapshot";
import type { PreMarketSnapshotRow } from "../../api/generated/PreMarketSnapshotRow";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import {
  filterSnapshotRows,
  formatFullDate,
  formatSignedPct,
  formatTurnover,
  signalMeta,
  type SnapshotFilter,
  valueTone,
} from "./logic";

const FILTERS: readonly { readonly value: SnapshotFilter; readonly label: string }[] = [
  { value: "all", label: "전체" },
  { value: "genuineGap", label: "진성 갭" },
  { value: "spoofWarning", label: "허수 주의" },
  { value: "extended", label: "임의연장" },
];

interface SnapshotPaneProps {
  readonly snapshot: PreMarketSnapshot | undefined;
  readonly selectedDate: string | undefined;
  readonly onChangeDate: (date: string) => void;
  readonly activeSymbol: SymbolCode | null;
  readonly onSelectStock: (row: PreMarketSnapshotRow) => void;
  readonly loading: boolean;
  readonly error: string | null;
}

export function SnapshotPane({
  snapshot,
  selectedDate,
  onChangeDate,
  activeSymbol,
  onSelectStock,
  loading,
  error,
}: SnapshotPaneProps) {
  const [filter, setFilter] = useState<SnapshotFilter>("all");
  const rows = useMemo(
    () => filterSnapshotRows(snapshot?.rows ?? [], filter),
    [snapshot?.rows, filter],
  );
  const dates = useMemo(() => {
    const list = snapshot?.availableDates ?? [];
    if (snapshot?.date && !list.includes(snapshot.date)) {
      return [...list, snapshot.date].sort();
    }
    return list;
  }, [snapshot?.availableDates, snapshot?.date]);
  const shownDate = selectedDate ?? snapshot?.date ?? dates[dates.length - 1] ?? "";
  const isClosed = snapshot?.source === "store";

  return (
    <div className="pm-pane" data-testid="premarket-snapshot-pane">
      <div className="pm-toolbar">
        <span className="pm-toolbar-title">전 종목 스냅샷</span>
        <select
          className="pm-select"
          aria-label="스냅샷 날짜"
          data-testid="premarket-snapshot-date"
          value={shownDate}
          onChange={(e) => onChangeDate(e.target.value)}
          disabled={dates.length === 0}
        >
          {dates.length === 0 ? (
            <option value="">날짜 없음</option>
          ) : (
            [...dates].reverse().map((d) => (
              <option key={d} value={d}>
                {formatFullDate(d)}
              </option>
            ))
          )}
        </select>
      </div>

      <div className="pm-toolbar">
        <div className="pm-chips" role="group" aria-label="스냅샷 필터">
          {FILTERS.map((item) => (
            <button
              key={item.value}
              type="button"
              className="pm-chip"
              data-testid={`premarket-filter-${item.value}`}
              aria-pressed={filter === item.value}
              onClick={() => setFilter(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="pm-table-wrap">
        {error !== null ? (
          <div className="pm-empty" role="alert">{error}</div>
        ) : loading && snapshot === undefined ? (
          <div className="pm-empty">스냅샷을 불러오는 중입니다</div>
        ) : rows.length === 0 ? (
          <div className="pm-empty">조건에 맞는 장전 종목이 없습니다</div>
        ) : (
          <table className="pm-table" data-testid="premarket-snapshot-table">
            <thead>
              <tr>
                <th>종목</th>
                <th>예상 등락</th>
                <th>막판 변동</th>
                <th>예상 대금</th>
                <th>신호</th>
                {isClosed && <th>09:10</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const sig = signalMeta(row.signal);
                return (
                  <tr
                    key={row.code}
                    className="pm-row"
                    data-testid={`premarket-row-${row.code}`}
                    data-symbol={row.code}
                    data-active={activeSymbol === row.code}
                    onClick={() => onSelectStock(row)}
                  >
                    <td>
                      <div className="pm-stock-cell">
                        <span className="pm-stock-name">{row.name}</span>
                        <span className="pm-stock-code">{row.code}</span>
                      </div>
                    </td>
                    <td className="pm-val" data-tone={valueTone(row.expectedReturnPct)}>
                      {formatSignedPct(row.expectedReturnPct)}
                    </td>
                    <td className="pm-val" data-tone={valueTone(row.lateDropPct)}>
                      {formatSignedPct(row.lateDropPct)}
                    </td>
                    <td>{formatTurnover(row.expectedTurnoverMillionWon)}</td>
                    <td>
                      <span className="pm-badges-cell">
                        <span className="pm-badge" data-tone={sig.tone}>{sig.label}</span>
                        {row.preMarketExtended && (
                          <span className="pm-badge" data-tone="ext">임의연장</span>
                        )}
                      </span>
                    </td>
                    {isClosed && (
                      <td className="pm-val" data-tone={valueTone(row.actual0910Pct)}>
                        {formatSignedPct(row.actual0910Pct)}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
