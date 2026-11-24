import { useEffect, useMemo, useReducer, useState } from "react";
import { useBrokerDays } from "../../api/brokers";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import type { WindowId } from "../../layout/kinds";
import { formatPrice } from "../../lib/format";
import { type BrokerCards, type BrokerView, useLayoutStore } from "../../stores/layout";
import { marketSocket } from "../../stores/realtime";
import { serverNow, useServerClock } from "../../stores/serverClock";
import { MarketHead } from "../market-window/MarketHead";
import { MarketWindowGate } from "../market-window/MarketWindowGate";
import { formatClock } from "../market-window/format";
import { Segmented, type SegmentOption } from "../market-window/parts";
import { EmptyState, ErrorState, Skeleton } from "../overlay/State";
import { BoardView } from "./BoardView";
import { DetailTable } from "./DetailTable";
import { ListView } from "./ListView";
import { boardAxis, brokerTracks, trackRuns } from "./board";
import { dayNav, formatMonthDay, kstDateOf, priceAt } from "./history";
import { EMPTY_BROKER_STATE, reduceBrokers } from "./model";
import { useBrokerDay, useBrokerMinuteBars } from "./useBrokerDay";
import "./brokers.css";

const VIEW_OPTIONS: readonly SegmentOption<BrokerView>[] = [
  { value: "board", label: "입체" },
  { value: "list", label: "거래원" },
];

const CARD_OPTIONS: readonly SegmentOption<BrokerCards>[] = [
  { value: "bars", label: "막대" },
  { value: "both", label: "막대+숫자" },
  { value: "numbers", label: "숫자" },
];

const EMPTY_DAYS: readonly string[] = [];
const EMPTY_GAPS: readonly (readonly [UnixSeconds, UnixSeconds])[] = [];
const CLOCK_TICK_MS = 60_000;

export function BrokersWindow({ id }: { id: WindowId }) {
  return <MarketWindowGate id={id}>{(code) => <BrokersBody key={code} id={id} code={code} />}</MarketWindowGate>;
}

function BrokersBody({ id, code }: { id: WindowId; code: SymbolCode }) {
  const [liveState, dispatchLive] = useReducer(reduceBrokers, EMPTY_BROKER_STATE);
  const [liveFailed, setLiveFailed] = useState(false);
  const [liveAttempt, setLiveAttempt] = useState(0);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [cursor, setCursor] = useState<UnixSeconds | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [clockTick, setClockTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setClockTick((tick) => tick + 1), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const serverTimeOrigin = useServerClock((s) => s.serverTimeOrigin);
  const nowMs = serverNow(serverTimeOrigin);
  const today = kstDateOf(nowMs);

  const daysQuery = useBrokerDays(code);
  const nav = useMemo(
    () => dayNav(daysQuery.data?.days ?? EMPTY_DAYS, today, selectedDate ?? today),
    [daysQuery.data?.days, today, selectedDate],
  );

  const day = useBrokerDay(code, nav.date, nav.isToday);
  const bars = useBrokerMinuteBars(code, nav.date, nav.isToday);

  const view = useLayoutStore((s) => {
    const win = s.layout.windows.find((w) => w.id === id);
    return win?.kind === "brokers" ? (win.view ?? "board") : "board";
  });
  const cards = useLayoutStore((s) => {
    const win = s.layout.windows.find((w) => w.id === id);
    return win?.kind === "brokers" ? (win.cards ?? "both") : "both";
  });
  const setBrokersView = useLayoutStore((s) => s.setBrokersView);
  const setBrokersCards = useLayoutStore((s) => s.setBrokersCards);

  useEffect(() => {
    if (day.mode !== "live") return;
    return marketSocket.subscribeFeed({ symbol: code, kind: "brokers" }, (event) => {
      if (event.type === "feed_brokers") dispatchLive({ type: "snapshot", brokers: event.brokers });
      else if (event.type === "feed_link") dispatchLive({ type: "link", live: event.live });
      else if (event.type === "resync") dispatchLive({ type: "resync" });
      else if (event.type === "feed_subscribed") setLiveFailed(false);
      else if (event.type === "sub_error") setLiveFailed(true);
    });
  }, [code, day.mode, liveAttempt]);

  const retryLive = () => {
    setLiveFailed(false);
    setLiveAttempt((count) => count + 1);
  };

  const grid = day.mode === "live" ? liveState.grid : day.state.grid;
  const gaps = day.mode === "collected" ? day.gaps : EMPTY_GAPS;
  const tracks = useMemo(() => brokerTracks(grid), [grid]);
  const runsByCode = useMemo(() => trackRuns(grid), [grid]);
  const axis = useMemo(
    () => boardAxis(grid.times, Math.floor(serverNow(serverTimeOrigin) / 1000)),
    [grid.times, serverTimeOrigin, clockTick],
  );
  const selectedTrack = selected === null ? null : (tracks.find((track) => track.code === selected) ?? null);
  const shownTime = cursor ?? grid.times[grid.times.length - 1] ?? null;
  const shownPrice = shownTime === null ? null : priceAt(bars, shownTime);

  const changeView = (next: BrokerView) => {
    setCursor(null);
    setBrokersView(id, next);
  };

  const changeCards = (next: BrokerCards) => {
    setCursor(null);
    setBrokersCards(id, next);
  };

  const toggleSelected = (brokerCode: string) => {
    setSelected((current) => (current === brokerCode ? null : brokerCode));
  };

  const moveDay = (target: string | null) => {
    if (target === null) return;
    setSelectedDate(target === today ? null : target);
    setCursor(null);
    setSelected(null);
  };

  const failed = day.mode === "live" ? liveFailed : day.failed;
  const retry = day.mode === "live" ? retryLive : day.retry;
  const showEmpty = !failed && day.mode !== "loading" && grid.times.length === 0;
  const showContent = !failed && grid.times.length > 0;

  return (
    <div className="br" data-testid="brokers-window" data-symbol={code}>
      <MarketHead code={code} venue="combined" />
      <div className="br-bar">
        <Segmented label="보기" options={VIEW_OPTIONS} value={view} onChange={changeView} />
        <span className="br-day">
          <button type="button" className="br-day-btn" aria-label="이전 관측일" disabled={nav.previous === null} onClick={() => moveDay(nav.previous)}>‹</button>
          <span className="br-day-label" data-testid="brokers-date">{formatMonthDay(nav.date)}{nav.isToday ? " 오늘" : ""}</span>
          <button type="button" className="br-day-btn" aria-label="다음 관측일" disabled={nav.next === null} onClick={() => moveDay(nav.next)}>›</button>
        </span>
        {view === "board" && <Segmented label="카드 모양" options={CARD_OPTIONS} value={cards} onChange={changeCards} />}
        <span className="br-now">
          <span className="br-time" data-testid="brokers-time">{shownTime === null ? "" : formatClock(shownTime).slice(0, 5)}</span>
          <span className="br-price" data-testid="brokers-price">{shownPrice === null ? "-" : formatPrice(shownPrice, false)}</span>
        </span>
      </div>
      {failed && <ErrorState message="거래원을 받지 못했습니다" retry={retry} />}
      {!failed && day.mode === "loading" && <Skeleton label="거래원 불러오는 중" />}
      {showEmpty && <EmptyState title={nav.isToday ? "거래원 스냅샷을 기다리는 중입니다" : "이 날의 거래원 자료가 없습니다"} />}
      {showContent && view === "board" && (
        <>
          <BoardView tracks={tracks} axis={axis} gaps={gaps} mode={cards} cursor={cursor} selected={selected} onSelect={toggleSelected} onCursor={setCursor} />
          {selectedTrack !== null && <DetailTable track={selectedTrack} bars={bars} />}
          <div className="br-foot">
            <span><i className="br-swatch" data-kind="buy" />순매수</span>
            <span><i className="br-swatch" data-kind="sell" />순매도</span>
          </div>
        </>
      )}
      {showContent && view === "list" && (
        <ListView tracks={tracks} runsByCode={runsByCode} axis={axis} cursor={cursor} onCursor={setCursor} />
      )}
    </div>
  );
}
