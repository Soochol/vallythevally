import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { Ranking } from "../../api/generated/Ranking";
import type { RankingRow } from "../../api/generated/RankingRow";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { WindowId } from "../../layout/kinds";
import { useKiwoomLinkStore, useMarketSource } from "../../stores/kiwoomLink";
import { useLayoutStore, watchedSymbol } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { EmptyState, ErrorState, Skeleton } from "../overlay/State";
import { PauseIcon, PlayIcon } from "../icons";
import { dropPendingOpen, openResult } from "../screener/resultActions";
import { adaptRanking, brokerShortName, FEED_UNAVAILABLE_TEXT, feedMarkOf, rankingKindOn } from "../status/marketFeed";
import { openSystemSettings } from "../system-settings/open";
import { RankingHead } from "./RankingConditions";
import { RankingTable } from "./RankingTable";
import { choiceLabel, KIWOOM_TR, VENUE_LABEL } from "./rankingChoices";
import { formatClock } from "../market-window/format";
import { DataAgeNote } from "../data-age/DataAgeNote";
import { useDocumentVisible, useRankingFeed } from "./useRankingFeed";
import "./ranking.css";

export const NOT_PREPARED_NOTICE = "미리 만든 조건만 볼 수 있습니다";
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
  const source = useMarketSource();
  const kindOn = rankingKindOn(source, ranking.kind);
  const watched = useWatched(id);
  const [cursor, setCursor] = useState<SymbolCode | null>(null);
  const [stopped, setStopped] = useState(false);
  const visible = useDocumentVisible();
  const scroller = useRef<HTMLDivElement>(null);
  const feed = useRankingFeed(ranking, connected && kindOn, !stopped, () => {
    setCursor(null);
    if (scroller.current) scroller.current.scrollTop = 0;
  });
  useEffect(() => dropPendingOpen, []);
  const change = (next: Ranking) => useLayoutStore.getState().setWindowRanking(id, next);
  useEffect(() => {
    if (!kindOn) return;
    const adapted = adaptRanking(source, ranking, choiceLabel);
    if (adapted.changes.length === 0) return;
    useLayoutStore.getState().setWindowRanking(id, adapted.ranking);
    useSelectionStore.getState().showToast(`한투로 받을 때는 고를 수 없는 값이라 ${adapted.changes.join(", ")}`);
  }, [source, ranking, kindOn, id]);
  const choose = (row: RankingRow) => {
    setCursor(row.code);
    if (row.listed) void openResult(queryClient, row.code, id);
    else useSelectionStore.getState().showToast(UNLISTED_NOTICE);
  };
  const { page } = feed;
  const mark = page === null ? null : feedMarkOf(source, page.source);
  return (
    <div className="rk-window" data-testid="ranking-window" data-ranking={ranking.kind}>
      <RankingHead
        ranking={ranking}
        onChange={change}
        status={<>
          {mark !== null && <span className="rk-mark" data-testid="ranking-source-mark" title={`이 순위는 ${brokerShortName(mark)}에서 받았습니다`}>{brokerShortName(mark)}</span>}
          <LiveStatus fetchedAt={page?.fetchedAt ?? null} failure={feed.failure} loading={connected && kindOn && ((page === null && feed.error === null && !feed.notPrepared) || feed.loadingMore)} live={connected && !stopped && visible} stopped={stopped} onToggle={() => setStopped(!stopped)} />
        </>}
      />
      <div className="rk-body">
        {!connected ? (
          <EmptyState title="키움 연결 전입니다">{link?.message && <p>{link.message}</p>}</EmptyState>
        ) : !kindOn ? (
          <div className="ui-state" data-testid="ranking-unavailable">
            <p>{FEED_UNAVAILABLE_TEXT}</p>
            <button type="button" className="btn" onClick={() => openSystemSettings("kiwoom")}>시스템 설정 이어가기</button>
          </div>
        ) : page === null && feed.notPrepared ? (
          <EmptyState title={NOT_PREPARED_NOTICE} />
        ) : page === null && feed.error !== null ? (
          <ErrorState message={feed.error} retry={feed.retry} />
        ) : page === null ? (
          <Skeleton label="순위를 받는 중" rows={8} />
        ) : page.rows.length === 0 ? (
          <EmptyState title="순위가 비어 있습니다" />
        ) : (
          <RankingTable ranking={ranking} rows={page.rows} cursor={cursor} watched={watched} onChoose={choose} onCursor={setCursor} onNearEnd={feed.more} scroller={scroller} />
        )}
      </div>
      {connected && kindOn && page !== null && (
        <footer className="rk-foot" data-testid="ranking-foot">
          <span className="rk-source" title={`${page.source === "kiwoom" ? `키움 ${KIWOOM_TR[ranking.kind]}` : brokerShortName(page.source)}${"venue" in ranking ? ` · ${VENUE_LABEL[ranking.venue]}` : ""}`}>
            {`${page.rows[page.rows.length - 1]?.rank ?? 0}위까지`}
          </span>
          {page.hidden > 0 && <span className="rk-hidden" data-testid="ranking-hidden" title={`목록에 없거나 뺀 종목 ${page.hidden}개`}>{`뺀 종목 ${page.hidden}`}</span>}
          {feed.failure !== null && <span className="rk-failure" role="status" data-testid="ranking-failure">받지 못했습니다 · {feed.failure}</span>}
          <span className="rk-grow" />
          {page.end ? (
            <span data-testid="ranking-end">마지막 순위입니다 · 모두 {page.rows.length}종목</span>
          ) : page.limited ? (
            <span data-testid="ranking-limited">한 창에서는 {page.rows.length}위까지만 받습니다</span>
          ) : (
            <button type="button" className="btn btn-sm" data-testid="ranking-more" disabled={feed.loadingMore} aria-busy={feed.loadingMore} onClick={feed.more}>
              {feed.loadingMore ? "받는 중…" : "더 보기"}
            </button>
          )}
        </footer>
      )}
    </div>
  );
}

function LiveStatus({ fetchedAt, failure, loading, live, stopped, onToggle }: { fetchedAt: number | null; failure: string | null; loading: boolean; live: boolean; stopped: boolean; onToggle(): void }) {
  const state = failure !== null ? "failed" : loading ? "loading" : live ? "live" : "idle";
  const title = failure !== null ? `받지 못했습니다 · ${failure}` : loading ? "순위를 받는 중" : stopped ? "멈춤" : undefined;
  return (
    <span className="rk-status" data-testid="ranking-status">
      <span className="rk-dot" data-testid="ranking-live" data-state={state} title={title} aria-hidden="true" />
      {fetchedAt !== null && <><span title="받은 시각"><span className="sr-only">받은 시각 </span>{formatClock(fetchedAt)}</span><DataAgeNote recordedAt={fetchedAt} cadence="ranking" /></>}
      <button type="button" className="icon-btn rk-pause" aria-label={stopped ? "이어 받기" : "멈추기"} title={stopped ? "이어 받기" : "멈추기"} onClick={onToggle}>
        {stopped ? <PlayIcon size={12} /> : <PauseIcon size={14} />}
      </button>
    </span>
  );
}
