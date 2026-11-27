import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { WindowId } from "../../layout/kinds";
import { formatPrice } from "../../lib/format";
import { useSymbolInfos } from "../../api/queries";
import { useFeedLink } from "../../stores/kiwoomLink";
import { useLayoutStore, watchedSymbol } from "../../stores/layout";
import { whaleBook } from "../../stores/realtime";
import { useSelectionStore } from "../../stores/selection";
import { FeedConnectGate } from "../market-window/MarketWindowGate";
import { dropPendingOpen, openResult } from "../screener/resultActions";
import { symbolDragProps } from "../../stores/symbolDrag";
import {
  aggregateWhaleRows,
  DEFAULT_WHALE_MIN_WON,
  filterWhaleEvents,
  formatWhaleTime,
  formatWhaleWon,
  parseCustomWon,
  WHALE_MIN_PRESETS,
  type WhaleRankSort,
  type WhaleSideFilter,
  type WhaleViewMode,
} from "./whaleModel";
import "./whale.css";

function useWatched(id: WindowId): SymbolCode | null {
  const activeCell = useSelectionStore((s) => s.activeCell);
  return useLayoutStore((s) => watchedSymbol(s.layout, id, activeCell));
}

export function WhaleWindow({ id }: { id: WindowId }) {
  const queryClient = useQueryClient();
  const link = useFeedLink();
  const connected = link === null || link.state === "connected";
  const watched = useWatched(id);
  const liveSnapshot = useSyncExternalStore(
    (onStoreChange) => whaleBook.subscribe(onStoreChange),
    () => whaleBook.getSnapshot(),
  );

  const [paused, setPaused] = useState(false);
  const [frozenSnapshot, setFrozenSnapshot] = useState(liveSnapshot);
  const [minWon, setMinWon] = useState<number>(DEFAULT_WHALE_MIN_WON);
  const [customInput, setCustomInput] = useState("");
  const [side, setSide] = useState<WhaleSideFilter>("all");
  const [view, setView] = useState<WhaleViewMode>("stream");
  const [query, setQuery] = useState("");
  const [rankSort, setRankSort] = useState<WhaleRankSort>("count");

  useEffect(() => dropPendingOpen, []);

  const snapshot = paused ? frozenSnapshot : liveSnapshot;

  const seenCodes = useMemo(() => {
    const set = new Set<SymbolCode>();
    for (const ev of snapshot.events) set.add(ev.symbol);
    return Array.from(set);
  }, [snapshot.events]);
  const symbolInfos = useSymbolInfos(seenCodes);

  const nameByCode = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of symbolInfos) map.set(item.code, item.name);
    return map;
  }, [symbolInfos]);

  const nameOf = (code: SymbolCode): string => nameByCode.get(code) ?? code;

  const filtered = useMemo(
    () => filterWhaleEvents(snapshot.events, minWon, side, query, nameOf),
    [snapshot.events, minWon, side, query, nameByCode],
  );

  const rankRows = useMemo(
    () => (view === "rank" ? aggregateWhaleRows(filtered, rankSort, nameOf) : []),
    [view, filtered, rankSort, nameByCode],
  );

  const totals = useMemo(() => {
    let buyWon = 0;
    let sellWon = 0;
    for (const ev of filtered) {
      if (ev.side === "buy") buyWon += ev.amountWon;
      else sellWon += ev.amountWon;
    }
    return { buyWon, sellWon, netWon: buyWon - sellWon };
  }, [filtered]);

  const togglePause = () => {
    if (!paused) setFrozenSnapshot(liveSnapshot);
    setPaused((p) => !p);
  };

  const handleClear = () => {
    whaleBook.clear();
    if (paused) setFrozenSnapshot(whaleBook.getSnapshot());
  };

  const applyCustomAmount = (raw: string) => {
    setCustomInput(raw);
    const parsed = parseCustomWon(raw);
    if (parsed !== null) setMinWon(parsed);
  };

  const selectSymbol = (code: SymbolCode) => {
    void openResult(queryClient, code, id);
  };

  const maxAmount = useMemo(() => {
    let max = 300_000_000;
    for (let i = 0; i < Math.min(filtered.length, 60); i++) {
      if (filtered[i]!.amountWon > max) max = filtered[i]!.amountWon;
    }
    return max;
  }, [filtered]);

  return (
    <div className="wh-window" data-testid="whale-window">
      <div className="wh-head">
        <div className="wh-head-bar">
          <div className="wh-seg" role="group" aria-label="뷰 모드">
            <button type="button" aria-pressed={view === "stream"} onClick={() => setView("stream")} data-testid="whale-view-stream">실시간</button>
            <button type="button" aria-pressed={view === "rank"} onClick={() => setView("rank")} data-testid="whale-view-rank">종목집계</button>
          </div>
          <div className="wh-seg" role="group" aria-label="방향">
            <button type="button" aria-pressed={side === "all"} onClick={() => setSide("all")} data-testid="whale-side-all">전체</button>
            <button type="button" data-tone="buy" aria-pressed={side === "buy"} onClick={() => setSide("buy")} data-testid="whale-side-buy">매수</button>
            <button type="button" data-tone="sell" aria-pressed={side === "sell"} onClick={() => setSide("sell")} data-testid="whale-side-sell">매도</button>
          </div>
          <span className="wh-scope" data-testid="whale-watched-count">감시 {snapshot.watchedCount}종목</span>
          <span className="wh-spacer" />
          <button type="button" className="wh-action-btn" aria-pressed={paused} onClick={togglePause} data-testid="whale-pause">
            {paused ? "재생" : "일시정지"}
          </button>
          <button type="button" className="wh-action-btn" onClick={handleClear} data-testid="whale-clear">클리어</button>
        </div>
      </div>

      <div className="wh-filter-bar">
        <div className="wh-seg" role="group" aria-label="최소 금액">
          {WHALE_MIN_PRESETS.map((preset) => (
            <button
              key={preset.key}
              type="button"
              aria-pressed={customInput.trim() === "" && minWon === preset.minWon}
              onClick={() => {
                setCustomInput("");
                setMinWon(preset.minWon);
              }}
              data-testid={`whale-preset-${preset.key}`}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <input
          type="text"
          className="wh-custom-input"
          value={customInput}
          onChange={(e) => applyCustomAmount(e.target.value)}
          placeholder="직접(예:2억)"
          aria-label="사용자 정의 최소 금액"
          data-testid="whale-custom-min"
        />
        <input
          type="text"
          className="wh-search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="종목·코드 검색"
          aria-label="종목 검색"
          data-testid="whale-search"
        />
      </div>

      <div className="wh-body">
        {!connected ? (
          <FeedConnectGate message={link?.message} />
        ) : view === "stream" ? (
          filtered.length === 0 ? (
            <p className="wh-empty" data-testid="whale-empty">조건에 맞는 고래 체결이 없습니다</p>
          ) : (
            <table className="wh-table" data-testid="whale-stream-table">
              <colgroup>
                <col style={{ width: "68px" }} />
                <col />
                <col style={{ width: "48px" }} />
                <col style={{ width: "92px" }} />
                <col style={{ width: "78px" }} />
                <col className="wh-col-count" style={{ width: "64px" }} />
                <col style={{ width: "84px" }} />
              </colgroup>
              <thead>
                <tr>
                  <th>시각</th>
                  <th>종목</th>
                  <th className="wh-center">구분</th>
                  <th className="wh-num">체결금액</th>
                  <th className="wh-num">체결가</th>
                  <th className="wh-center wh-col-count">횟수</th>
                  <th className="wh-num">순매수</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 200).map((ev) => {
                  const summary = snapshot.summaries.get(ev.symbol);
                  const netWon = summary?.netWon ?? 0;
                  const barPct = Math.min(100, Math.round((ev.amountWon / maxAmount) * 100));
                  return (
                    <tr
                      key={ev.id}
                      tabIndex={0}
                      data-symbol={ev.symbol}
                      data-selected={watched === ev.symbol ? "" : undefined}
                      {...symbolDragProps({ code: ev.symbol, name: nameOf(ev.symbol), sourceWindow: id })}
                      onClick={() => selectSymbol(ev.symbol)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          selectSymbol(ev.symbol);
                        }
                      }}
                    >
                      <td>{formatWhaleTime(ev.at)}</td>
                      <td>
                        <div className="wh-stock">
                          <span className="wh-stock-name">{nameOf(ev.symbol)}</span>
                          <span className="wh-stock-code wh-col-code">{ev.symbol}</span>
                        </div>
                      </td>
                      <td className="wh-center">
                        <span className="wh-side" data-side={ev.side}>{ev.side === "buy" ? "매수" : "매도"}</span>
                      </td>
                      <td className="wh-num wh-amt-cell">
                        <div className="wh-amt-bar" data-side={ev.side} style={{ width: `${barPct}%` }} />
                        <span className={`wh-amt-val ${ev.side === "buy" ? "wh-up" : "wh-down"}`}>{formatWhaleWon(ev.amountWon)}</span>
                      </td>
                      <td className="wh-num">{formatPrice(ev.price, false)}</td>
                      <td className="wh-center wh-col-count">
                        <span className="wh-up">{summary?.buyCount ?? 0}</span>/<span className="wh-down">{summary?.sellCount ?? 0}</span>
                      </td>
                      <td className={`wh-num ${netWon > 0 ? "wh-up" : netWon < 0 ? "wh-down" : ""}`}>{formatWhaleWon(netWon, true)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        ) : rankRows.length === 0 ? (
          <p className="wh-empty" data-testid="whale-empty">집계할 고래 체결이 없습니다</p>
        ) : (
          <table className="wh-table" data-testid="whale-rank-table">
            <colgroup>
              <col style={{ width: "36px" }} />
              <col />
              <col style={{ width: "78px" }} />
              <col style={{ width: "86px" }} />
              <col style={{ width: "92px" }} />
              <col style={{ width: "92px" }} />
            </colgroup>
            <thead>
              <tr>
                <th className="wh-center">#</th>
                <th>종목</th>
                <th className="wh-num">체결가</th>
                <th
                  className="wh-center"
                  data-sortable=""
                  data-sort-active={rankSort === "count" ? "" : undefined}
                  aria-sort={rankSort === "count" ? "descending" : "none"}
                >
                  <button
                    type="button"
                    className="wh-sort-btn"
                    onClick={() => setRankSort("count")}
                    data-testid="whale-sort-count"
                  >
                    횟수{rankSort === "count" ? " ▼" : ""}
                  </button>
                </th>
                <th
                  className="wh-num"
                  data-sortable=""
                  data-sort-active={rankSort === "net" ? "" : undefined}
                  aria-sort={rankSort === "net" ? "descending" : "none"}
                >
                  <button
                    type="button"
                    className="wh-sort-btn"
                    onClick={() => setRankSort("net")}
                    data-testid="whale-sort-net"
                  >
                    순매수{rankSort === "net" ? " ▼" : ""}
                  </button>
                </th>
                <th
                  className="wh-num"
                  data-sortable=""
                  data-sort-active={rankSort === "total" ? "" : undefined}
                  aria-sort={rankSort === "total" ? "descending" : "none"}
                >
                  <button
                    type="button"
                    className="wh-sort-btn"
                    onClick={() => setRankSort("total")}
                    data-testid="whale-sort-total"
                  >
                    총대금{rankSort === "total" ? " ▼" : ""}
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {rankRows.map((row, idx) => (
                <tr
                  key={row.symbol}
                  tabIndex={0}
                  data-symbol={row.symbol}
                  data-selected={watched === row.symbol ? "" : undefined}
                  {...symbolDragProps({ code: row.symbol, name: row.name, sourceWindow: id })}
                  onClick={() => selectSymbol(row.symbol)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      selectSymbol(row.symbol);
                    }
                  }}
                >
                  <td className="wh-center">{idx + 1}</td>
                  <td>
                    <div className="wh-stock">
                      <span className="wh-stock-name">{row.name}</span>
                      <span className="wh-stock-code wh-col-code">{row.symbol}</span>
                    </div>
                  </td>
                  <td className="wh-num">{formatPrice(row.lastPrice, false)}</td>
                  <td className="wh-center">
                    {row.totalCount} (<span className="wh-up">{row.buyCount}</span>/<span className="wh-down">{row.sellCount}</span>)
                  </td>
                  <td className={`wh-num ${row.netWon > 0 ? "wh-up" : row.netWon < 0 ? "wh-down" : ""}`}>{formatWhaleWon(row.netWon, true)}</td>
                  <td className="wh-num">{formatWhaleWon(row.totalWon)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="wh-foot">
        <span data-testid="whale-stat-count">{filtered.length}건</span>
        <span>매수 <b className="wh-up">{formatWhaleWon(totals.buyWon)}</b></span>
        <span>매도 <b className="wh-down">{formatWhaleWon(totals.sellWon)}</b></span>
        <span>순매수 <b className={totals.netWon > 0 ? "wh-up" : totals.netWon < 0 ? "wh-down" : ""}>{formatWhaleWon(totals.netWon, true)}</b></span>
      </div>
    </div>
  );
}
