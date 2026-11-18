import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { Ranking } from "../../api/generated/Ranking";
import type { RankingRow } from "../../api/generated/RankingRow";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { WindowId } from "../../layout/kinds";
import { useKiwoomLinkStore } from "../../stores/kiwoomLink";
import { useLayoutStore, watchedSymbol } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { EmptyState, Skeleton } from "../overlay/State";
import { dropPendingOpen, openResult } from "../screener/resultActions";
import { RankingConditionRow, RankingPickers } from "./RankingConditions";
import { RankingTable } from "./RankingTable";
import { KIWOOM_TR, VENUE_LABEL } from "./rankingChoices";
import { formatClock } from "../market-window/format";
import { useDocumentVisible, useRankingFeed } from "./useRankingFeed";
import "./ranking.css";

export const UNLISTED_NOTICE = "차트로 열 수 없는 종목입니다";

function useWindowRanking(id: WindowId): Ranking | null {
  return useLayoutStore((s) => {
    const window = s.layout.windows.find((w) => w.id === id);
    return window?.kind === "ranking" ? window.ranking : null;
  });
}

function useWatched(id: WindowId): SymbolCode | null {
  const activeCell = useSelectionStore((s) => s.activeCell);
  return useLayoutStore((s) => watchedSymbol(s.layout, id, activeCell));
}

export function RankingWindow({ id }: { id: WindowId }) {
  const ranking = useWindowRanking(id);
  if (ranking === null) return null;
  return <RankingBody id={id} ranking={ranking} />;
}

function RankingBody({ id, ranking }: { id: WindowId; ranking: Ranking }) {
  const queryClient = useQueryClient();
  const link = useKiwoomLinkStore((s) => s.status);
  const connected = link === null || link.state === "connected";
  const watched = useWatched(id);
  const [cursor, setCursor] = useState<SymbolCode | null>(null);
  const [stopped, setStopped] = useState(false);
  const visible = useDocumentVisible();
  const scroller = useRef<HTMLDivElement>(null);
  const feed = useRankingFeed(ranking, connected, !stopped, () => {
    setCursor(null);
    if (scroller.current) scroller.current.scrollTop = 0;
  });
  useEffect(() => dropPendingOpen, []);
  const change = (next: Ranking) => useLayoutStore.getState().setWindowRanking(id, next);
  const choose = (row: RankingRow) => {
    setCursor(row.code);
    if (row.listed) void openResult(queryClient, row.code, id);
    else useSelectionStore.getState().showToast(UNLISTED_NOTICE);
  };
  const { page } = feed;
  return (
    <div className="rk-window" data-testid="ranking-window" data-ranking={ranking.kind}>
      <RankingPickers ranking={ranking} onChange={change} />
      <RankingConditionRow ranking={ranking} onChange={change}>
        <span className="rk-grow" />
        <LiveStatus fetchedAt={page?.fetchedAt ?? null} failure={feed.failure} live={connected && !stopped && visible} stopped={stopped} onToggle={() => setStopped(!stopped)} />
      </RankingConditionRow>
      <div className="rk-body">
        {!connected ? (
          <EmptyState title="키움 연결 전입니다">{link?.message && <p>{link.message}</p>}</EmptyState>
        ) : page === null && feed.error !== null ? (
          <div role="alert" className="ui-state">
            <p>{feed.error}</p>
            <button type="button" className="tb-btn" onClick={feed.retry}>다시 받기</button>
          </div>
        ) : page === null ? (
          <Skeleton label="순위를 받는 중" />
        ) : page.rows.length === 0 ? (
          <EmptyState title="순위가 비어 있습니다" />
        ) : (
          <RankingTable ranking={ranking} rows={page.rows} cursor={cursor} watched={watched} onChoose={choose} onCursor={setCursor} onNearEnd={feed.more} scroller={scroller} />
        )}
      </div>
      {connected && page !== null && (
        <footer className="rk-foot" data-testid="ranking-foot">
          <span className="rk-source">
            키움 {KIWOOM_TR[ranking.kind]}
            {"venue" in ranking && ` · ${VENUE_LABEL[ranking.venue]}`}
            {` · ${page.rows[page.rows.length - 1]?.rank ?? 0}위까지`}
          </span>
          {page.hidden > 0 && <span className="rk-hidden" data-testid="ranking-hidden">목록에 없거나 뺀 종목 {page.hidden}개</span>}
          {page.end ? (
            <span data-testid="ranking-end">마지막 순위입니다 · 모두 {page.rows.length}종목</span>
          ) : page.limited ? (
            <span data-testid="ranking-limited">한 창에서는 {page.rows.length}위까지만 받습니다</span>
          ) : (
            <button type="button" className="tb-btn" data-testid="ranking-more" disabled={feed.loadingMore} aria-busy={feed.loadingMore} onClick={feed.more}>
              {feed.loadingMore ? "받는 중…" : "더 보기"}
            </button>
          )}
        </footer>
      )}
    </div>
  );
}

function LiveStatus({ fetchedAt, failure, live, stopped, onToggle }: { fetchedAt: number | null; failure: string | null; live: boolean; stopped: boolean; onToggle(): void }) {
  return (
    <span className="rk-status" data-testid="ranking-status">
      <span className="rk-dot" data-testid="ranking-live" data-state={live ? "live" : "idle"} aria-hidden="true" />
      {failure !== null ? <span className="rk-failure" role="status">받지 못했습니다 · {failure}</span> : fetchedAt !== null && <span>받은 시각 {formatClock(fetchedAt)}</span>}
      <button type="button" className="tb-btn" aria-pressed={stopped} onClick={onToggle}>
        {stopped ? "멈춤" : "멈추기"}
      </button>
    </span>
  );
}
