import { useEffect, useMemo, useReducer, useState } from "react";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import type { WindowId } from "../../layout/kinds";
import { type BrokerCards, type BrokerView, useLayoutStore } from "../../stores/layout";
import { marketSocket } from "../../stores/realtime";
import { serverNow, useServerClock } from "../../stores/serverClock";
import { EmptyState, ErrorState } from "../overlay/State";
import { MarketHead } from "../market-window/MarketHead";
import { formatClock } from "../market-window/format";
import { MarketWindowGate } from "../market-window/MarketWindowGate";
import { Segmented, type SegmentOption } from "../market-window/parts";
import { BoardView } from "./BoardView";
import { DetailTable } from "./DetailTable";
import { ListView } from "./ListView";
import { boardAxis, brokerTracks, trackRuns } from "./board";
import { EMPTY_BROKER_STATE, reduceBrokers } from "./model";
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

export function BrokersWindow({ id }: { id: WindowId }) {
  return <MarketWindowGate id={id}>{(code) => <BrokersBody key={code} id={id} code={code} />}</MarketWindowGate>;
}

function BrokersBody({ id, code }: { id: WindowId; code: SymbolCode }) {
  const [state, dispatch] = useReducer(reduceBrokers, EMPTY_BROKER_STATE);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [cursor, setCursor] = useState<UnixSeconds | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

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

  useEffect(() => marketSocket.subscribeFeed({ symbol: code, kind: "brokers" }, (event) => {
    if (event.type === "feed_brokers") dispatch({ type: "snapshot", brokers: event.brokers });
    else if (event.type === "feed_link") dispatch({ type: "link", live: event.live });
    else if (event.type === "resync") dispatch({ type: "resync" });
    else if (event.type === "feed_subscribed") setFailed(false);
    else if (event.type === "sub_error") setFailed(true);
  }), [code, attempt]);

  const retry = () => {
    setFailed(false);
    setAttempt((count) => count + 1);
  };

  const serverTimeOrigin = useServerClock((s) => s.serverTimeOrigin);
  const { grid } = state;
  const tracks = useMemo(() => brokerTracks(grid), [grid]);
  const runsByCode = useMemo(() => trackRuns(grid), [grid]);
  const axis = useMemo(() => boardAxis(grid.times, Math.floor(serverNow(serverTimeOrigin) / 1000)), [grid.times, serverTimeOrigin]);
  const selectedTrack = selected === null ? null : (tracks.find((track) => track.code === selected) ?? null);
  const shownTime = cursor ?? grid.times[grid.times.length - 1] ?? null;

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

  return (
    <div className="br" data-testid="brokers-window" data-symbol={code}>
      <MarketHead code={code} venue="combined" />
      <div className="br-bar">
        <Segmented label="보기" options={VIEW_OPTIONS} value={view} onChange={changeView} />
        {view === "board" && <Segmented label="카드 모양" options={CARD_OPTIONS} value={cards} onChange={changeCards} />}
        <span className="br-time" data-testid="brokers-time">{shownTime === null ? "" : formatClock(shownTime).slice(0, 5)}</span>
      </div>
      {failed && <ErrorState message="거래원을 받지 못했습니다" retry={retry} />}
      {!failed && grid.times.length === 0 && <EmptyState title="거래원 스냅샷을 기다리는 중입니다" />}
      {!failed && grid.times.length > 0 && view === "board" && (
        <>
          <BoardView tracks={tracks} axis={axis} mode={cards} cursor={cursor} selected={selected} onSelect={toggleSelected} onCursor={setCursor} />
          {selectedTrack !== null && <DetailTable track={selectedTrack} />}
          <div className="br-foot">
            <span><i className="br-swatch" data-kind="buy" />순매수</span>
            <span><i className="br-swatch" data-kind="sell" />순매도</span>
          </div>
        </>
      )}
      {!failed && grid.times.length > 0 && view === "list" && (
        <ListView tracks={tracks} runsByCode={runsByCode} axis={axis} cursor={cursor} onCursor={setCursor} />
      )}
    </div>
  );
}
