import { useEffect, useMemo, useRef, useState } from "react";
import type { PreMarketSnapshotRow } from "../../api/generated/PreMarketSnapshotRow";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { usePreMarketCompare, usePreMarketDays, usePreMarketSnapshot } from "../../api/premarket";
import { useSymbolInfo } from "../../api/queries";
import type { WindowId } from "../../layout/kinds";
import { isIndexCode } from "../../lib/symbol";
import { useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { useLinkedSymbol } from "../market-window/MarketWindowGate";
import { defaultSelectedDates, toggleDateSelection, WIDE_BREAKPOINT_PX } from "./logic";
import { OverlayChart } from "./OverlayChart";
import { SnapshotPane } from "./SnapshotPane";
import "./premarket.css";

type NarrowTab = "compare" | "snapshot";

export function PreMarketWindow({ id }: { id: WindowId }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(true);
  const [narrowTab, setNarrowTab] = useState<NarrowTab>("compare");
  const [snapshotDate, setSnapshotDate] = useState<string | undefined>(undefined);
  const linkedSymbol = useLinkedSymbol(id);
  const [override, setOverride] = useState<{ readonly base: SymbolCode | null; readonly code: SymbolCode } | null>(null);
  const activeSymbol = override !== null && override.base === linkedSymbol ? override.code : linkedSymbol;
  const stockSymbol = activeSymbol !== null && !isIndexCode(activeSymbol) ? activeSymbol : null;
  const symbolInfo = useSymbolInfo(stockSymbol ?? "");
  const [selectedBySymbol, setSelectedBySymbol] = useState<{ readonly symbol: SymbolCode; readonly days: readonly string[] } | null>(null);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const update = (width: number) => {
      if (width > 0) setWide(width >= WIDE_BREAKPOINT_PX);
    };
    update(el.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      update(width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const daysQuery = usePreMarketDays(stockSymbol);
  const availableDays = daysQuery.data?.days ?? [];

  const selectedDays = useMemo(() => {
    if (stockSymbol === null) return [];
    if (selectedBySymbol !== null && selectedBySymbol.symbol === stockSymbol) {
      const valid = selectedBySymbol.days.filter((d) => availableDays.includes(d));
      if (valid.length > 0) return valid;
    }
    return defaultSelectedDates(availableDays);
  }, [stockSymbol, selectedBySymbol, availableDays]);

  const compareQuery = usePreMarketCompare(stockSymbol, selectedDays);
  const snapshotQuery = usePreMarketSnapshot(snapshotDate);

  const handleToggleDay = (date: string) => {
    if (stockSymbol === null) return;
    setSelectedBySymbol({ symbol: stockSymbol, days: toggleDateSelection(selectedDays, date) });
  };

  const handleSelectStock = (row: PreMarketSnapshotRow) => {
    const activeCell = useSelectionStore.getState().activeCell;
    const layoutStore = useLayoutStore.getState();
    const currentWin = layoutStore.layout.windows.find((w) => w.id === id);
    if (currentWin && currentWin.kind === "premarket" && currentWin.symbol !== undefined) {
      layoutStore.pinSymbol(id, row.code);
    }
    layoutStore.sendSymbol(id, activeCell, { code: row.code, name: row.name });
    setOverride({ base: linkedSymbol, code: row.code });
    if (!wide) setNarrowTab("compare");
  };

  const compareError = daysQuery.error?.message ?? compareQuery.error?.message ?? null;
  const snapshotError = snapshotQuery.error?.message ?? null;

  const comparePane =
    stockSymbol === null ? (
      <div className="pm-pane" data-testid="premarket-compare-pane">
        <div className="pm-toolbar">
          <span className="pm-toolbar-title">08:30–09:00 날짜 비교</span>
        </div>
        <div className="pm-empty">주식을 선택하면 장전 예상체결 날짜 비교를 볼 수 있습니다</div>
      </div>
    ) : (
      <OverlayChart
        availableDays={availableDays}
        selectedDays={selectedDays}
        onToggleDay={handleToggleDay}
        series={compareQuery.data?.series ?? []}
        loading={daysQuery.isLoading || compareQuery.isLoading}
        error={compareError}
      />
    );

  const snapshotPane = (
    <SnapshotPane
      snapshot={snapshotQuery.data}
      selectedDate={snapshotDate}
      onChangeDate={(next) => setSnapshotDate(next || undefined)}
      activeSymbol={stockSymbol}
      onSelectStock={handleSelectStock}
      loading={snapshotQuery.isLoading}
      error={snapshotError}
    />
  );

  return (
    <div
      ref={rootRef}
      className="pm"
      data-testid="premarket-window"
      data-symbol={stockSymbol ?? ""}
      data-layout={wide ? "wide" : "narrow"}
    >
      <div className="pm-head">
        <div className="pm-sym">
          <span className="pm-sym-name">
            {stockSymbol !== null ? (symbolInfo.data?.name ?? stockSymbol) : "종목 미선택"}
          </span>
          {stockSymbol !== null && <span className="pm-sym-code">{stockSymbol}</span>}
        </div>
      </div>

      {!wide && (
        <div className="pm-tabs" role="tablist" aria-label="장전 동시호가 보기">
          <button
            type="button"
            role="tab"
            className="pm-tab"
            aria-selected={narrowTab === "compare"}
            onClick={() => setNarrowTab("compare")}
          >
            날짜 비교
          </button>
          <button
            type="button"
            role="tab"
            className="pm-tab"
            aria-selected={narrowTab === "snapshot"}
            onClick={() => setNarrowTab("snapshot")}
          >
            전 종목 스냅샷
          </button>
        </div>
      )}

      <div className="pm-split">
        {wide ? (
          <>
            {comparePane}
            {snapshotPane}
          </>
        ) : narrowTab === "compare" ? (
          comparePane
        ) : (
          snapshotPane
        )}
      </div>
    </div>
  );
}
