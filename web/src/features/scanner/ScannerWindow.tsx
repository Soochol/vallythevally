import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { Ranking } from "../../api/generated/Ranking";
import type { RankingRow } from "../../api/generated/RankingRow";
import type { WindowId } from "../../layout/kinds";
import { useFeedLink } from "../../stores/kiwoomLink";
import { EmptyState, ErrorState, Skeleton } from "../overlay/State";
import { useRankingFeed } from "../ranking/useRankingFeed";
import { dropPendingOpen, openResult } from "../screener/resultActions";
import { symbolDragProps } from "../../stores/symbolDrag";
import "./scanner.css";

type SignalKind = "ALL" | "VOL" | "HIGH" | "VI" | "PROG" | "BOOK";
type SortKey = "score" | "rate" | "value";

interface ScannerEvent {
  readonly code: string;
  readonly name: string;
  readonly listed: boolean;
  readonly price: number;
  readonly changeRate: number;
  readonly tradeValue: number;
  readonly signal: Exclude<SignalKind, "ALL">;
  readonly signalLabel: string;
  readonly detail: string;
}

const FILTERS: readonly { readonly id: SignalKind; readonly label: string }[] = [
  { id: "ALL", label: "전체" },
  { id: "VOL", label: "거래급증" },
  { id: "HIGH", label: "신고가" },
  { id: "VI", label: "VI근접" },
  { id: "PROG", label: "프로그램" },
  { id: "BOOK", label: "호가급변" },
];

const SCANNER_RANKING: Ranking = {
  kind: "turnover",
  market: "all",
  venue: "combined",
  excludes: { etfEtn: false, preferred: false },
  excludeManaged: false,
};

function classifyRow(row: RankingRow): ScannerEvent {
  const rate = row.changeRate ?? 0;
  const value = "tradeAmount" in row.figures && typeof row.figures.tradeAmount === "number"
    ? row.figures.tradeAmount
    : "volume" in row.figures && typeof row.figures.volume === "number"
      ? row.figures.volume
      : 0;
  if (rate >= 8) {
    return {
      code: row.code,
      name: row.name,
      listed: row.listed,
      price: row.price ?? 0,
      changeRate: rate,
      tradeValue: value,
      signal: "VI",
      signalLabel: "VI근접",
      detail: `등락률 +${rate.toFixed(2)}% · VI 경계 구간`,
    };
  }
  if (rate >= 5) {
    return {
      code: row.code,
      name: row.name,
      listed: row.listed,
      price: row.price ?? 0,
      changeRate: rate,
      tradeValue: value,
      signal: "HIGH",
      signalLabel: "신고가",
      detail: "당일 상단 돌파 모멘텀",
    };
  }
  if (value >= 100_000) {
    return {
      code: row.code,
      name: row.name,
      listed: row.listed,
      price: row.price ?? 0,
      changeRate: rate,
      tradeValue: value,
      signal: "VOL",
      signalLabel: "거래급증",
      detail: "거래대금 상위 급증 유입",
    };
  }
  if (rate >= 2) {
    return {
      code: row.code,
      name: row.name,
      listed: row.listed,
      price: row.price ?? 0,
      changeRate: rate,
      tradeValue: value,
      signal: "PROG",
      signalLabel: "프로그램",
      detail: "강세 수급 유입 구간",
    };
  }
  return {
    code: row.code,
    name: row.name,
    listed: row.listed,
    price: row.price ?? 0,
    changeRate: rate,
    tradeValue: value,
    signal: "BOOK",
    signalLabel: "호가급변",
    detail: "호가 잔량 변동 감지",
  };
}

function formatBillion(value: number): string {
  if (value >= 1000) return `${(value / 100).toFixed(0)}억`;
  if (value > 0) return `${value.toLocaleString()}`;
  return "-";
}

export function ScannerWindow({ id }: { id: WindowId }) {
  const queryClient = useQueryClient();
  const link = useFeedLink();
  const connected = link === null || link.state === "connected";
  const [filter, setFilter] = useState<SignalKind>("ALL");
  const [sort, setSort] = useState<SortKey>("score");
  const [paused, setPaused] = useState(false);

  const feed = useRankingFeed(SCANNER_RANKING, connected, !paused, () => {});
  useEffect(() => dropPendingOpen, []);

  const events = useMemo(() => {
    const raw = feed.page?.rows ?? [];
    const mapped = raw.map(classifyRow);
    const filtered = filter === "ALL" ? mapped : mapped.filter((item) => item.signal === filter);
    return [...filtered].sort((a, b) => {
      if (sort === "rate") return b.changeRate - a.changeRate;
      if (sort === "value") return b.tradeValue - a.tradeValue;
      return b.changeRate * 10 + Math.log10(Math.max(b.tradeValue, 1)) - (a.changeRate * 10 + Math.log10(Math.max(a.tradeValue, 1)));
    });
  }, [feed.page, filter, sort]);

  return (
    <div className="scn-window" data-testid="scanner-window">
      <div className="scn-head">
        <div className="scn-seg" role="group" aria-label="스캐너 신호 필터">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              className="scn-seg-btn"
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="scn-seg" role="group" aria-label="스캐너 정렬">
          <button type="button" className="scn-seg-btn" aria-pressed={sort === "score"} onClick={() => setSort("score")}>강도순</button>
          <button type="button" className="scn-seg-btn" aria-pressed={sort === "rate"} onClick={() => setSort("rate")}>등락순</button>
          <button type="button" className="scn-seg-btn" aria-pressed={sort === "value"} onClick={() => setSort("value")}>대금순</button>
        </div>
        <span className="scn-spacer" />
        <button type="button" className="scn-ctrl" onClick={() => setPaused((v) => !v)}>
          {paused ? "재개" : "일시정지"}
        </button>
      </div>
      <div className="scn-body">
        {!connected ? (
          <EmptyState title="키움 연결 전입니다" />
        ) : feed.page === null && feed.error !== null ? (
          <ErrorState message={feed.error} retry={feed.retry} />
        ) : feed.page === null ? (
          <Skeleton label="실시간 스캐너 데이터를 받는 중" rows={8} />
        ) : events.length === 0 ? (
          <EmptyState title="조건에 맞는 실시간 신호가 없습니다" />
        ) : (
          <>
            <div className="scn-colhead">
              <span>신호</span>
              <span>종목</span>
              <span className="scn-num">현재가</span>
              <span className="scn-num">등락률</span>
              <span className="scn-num">규모</span>
              <span>트리거</span>
            </div>
            {events.map((ev) => (
              <button
                key={ev.code}
                type="button"
                className="scn-row"
                data-testid={`scanner-row-${ev.code}`}
                {...symbolDragProps({ code: ev.code, name: ev.name, sourceWindow: id })}
                onClick={() => {
                  if (ev.listed) void openResult(queryClient, ev.code, id);
                }}
              >
                <span><span className="scn-badge" data-tone={ev.signal.toLowerCase()}>{ev.signalLabel}</span></span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  <strong>{ev.name}</strong>
                </span>
                <span className="scn-num">{ev.price.toLocaleString()}</span>
                <span className={`scn-num ${ev.changeRate > 0 ? "scn-up" : ev.changeRate < 0 ? "scn-down" : ""}`}>
                  {ev.changeRate > 0 ? "+" : ""}{ev.changeRate.toFixed(2)}%
                </span>
                <span className="scn-num">{formatBillion(ev.tradeValue)}</span>
                <span className="scn-muted">{ev.detail}</span>
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
