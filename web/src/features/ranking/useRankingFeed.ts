import { useCallback, useEffect, useRef, useState } from "react";
import type { Ranking } from "../../api/generated/Ranking";
import type { RankingPage } from "../../api/generated/RankingPage";
import type { RankingTrigger } from "../../api/generated/RankingTrigger";
import { ApiRequestError } from "../../api/http";
import { fetchRanking } from "../../api/rankings";
import { capRankingPage } from "../../public-mode/rankingPages";

export const REFRESH_MS = 10_000;

interface Feed {
  page: RankingPage | null;
  error: string | null;
  notPrepared: boolean;
  failure: string | null;
  loadingMore: boolean;
  settledAt: number | null;
}

const EMPTY: Feed = { page: null, error: null, notPrepared: false, failure: null, loadingMore: false, settledAt: null };

const NOT_PREPARED_REASON = "미리 만든 조건만 볼 수 있습니다";
const isNotPrepared = (e: unknown) => e instanceof ApiRequestError && e.code === "not_prepared";
const reasonOf = (e: unknown) => (isNotPrepared(e) ? NOT_PREPARED_REASON : e instanceof ApiRequestError ? e.message : "순위를 받지 못했습니다");

export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

export interface RankingFeed extends Feed {
  more(): void;
  retry(): void;
}

export function useRankingFeed(ranking: Ranking, enabled: boolean, refreshing: boolean, onReset: () => void): RankingFeed {
  const [feed, setFeed] = useState<Feed>(EMPTY);
  const latest = useRef(0);
  const current = useRef({ ranking, feed });
  current.current = { ranking, feed };
  const visible = useDocumentVisible();

  const run = useCallback((pages: number, trigger: RankingTrigger) => {
    const mine = ++latest.current;
    const asked = current.current.ranking;
    if (trigger === "user") setFeed((f) => (pages > 1 ? { ...f, loadingMore: true } : f.page === null ? { ...f, error: null } : f));
    fetchRanking(asked, pages, trigger).then(
      (page) => {
        if (mine === latest.current) setFeed({ page: capRankingPage(page), error: null, notPrepared: false, failure: null, loadingMore: false, settledAt: Date.now() });
      },
      (e: unknown) => {
        if (mine !== latest.current) return;
        const message = reasonOf(e);
        setFeed((f) => (f.page === null ? { ...EMPTY, error: message, notPrepared: isNotPrepared(e), settledAt: Date.now() } : { ...f, failure: message, loadingMore: false, settledAt: Date.now() }));
      },
    );
  }, []);

  const key = JSON.stringify(ranking);
  useEffect(() => {
    latest.current++;
    setFeed(EMPTY);
    onReset();
    if (enabled) run(1, "user");
  }, [key, enabled, run]);

  useEffect(() => {
    const { page, loadingMore, settledAt } = feed;
    if (!enabled || !refreshing || !visible || page === null || loadingMore || settledAt === null) return;
    const wait = Math.max(0, REFRESH_MS - (Date.now() - settledAt));
    const timer = setTimeout(() => run(page.pages, "refresh"), wait);
    return () => clearTimeout(timer);
  }, [enabled, refreshing, visible, feed, run]);

  const more = useCallback(() => {
    const { page, loadingMore } = current.current.feed;
    if (page === null || page.end || page.limited || loadingMore) return;
    run(page.pages + 1, "user");
  }, [run]);
  const retry = useCallback(() => run(current.current.feed.page?.pages ?? 1, "user"), [run]);
  return { ...feed, more, retry };
}
