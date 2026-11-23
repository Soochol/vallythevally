import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { MarketOverviewPart } from "../../api/generated/MarketOverviewPart";
import type { Broker } from "../../api/generated/Broker";
import { useMarketSource } from "../../stores/kiwoomLink";
import { Skeleton } from "../overlay/State";
import { brokerShortName, FEED_UNAVAILABLE_TEXT, feedMarkOf } from "../status/marketFeed";
import { openSystemSettings } from "../system-settings/open";

export function FeedMark({ received }: { received: Broker | undefined }) {
  const source = useMarketSource();
  const mark = received === undefined ? null : feedMarkOf(source, received);
  return mark === null ? null : <span className="mk-feed-mark" data-testid="feed-source-mark" title={`이 칸은 ${brokerShortName(mark)}에서 받았습니다`}>{brokerShortName(mark)}</span>;
}

export function FeedUnavailable() {
  return (
    <div className="mk-unavailable" data-testid="feed-unavailable">
      <p className="mk-empty">{FEED_UNAVAILABLE_TEXT}</p>
      <button type="button" className="tb-btn" onClick={() => openSystemSettings("kiwoom")}>시스템 설정 이어가기</button>
    </div>
  );
}

export function CardShell({ title, note, source, children }: { title: string; note?: ReactNode; source?: Broker; children: ReactNode }) {
  return (
    <section className="mk-card" aria-label={title}>
      <header className="mk-card-head">
        <h2>{title}</h2>
        <FeedMark received={source} />
        {note !== undefined && <span className="mk-card-note">{note}</span>}
      </header>
      {children}
    </section>
  );
}

export function CardError({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div role="alert" className="mk-error">
      <span>{message}</span>
      {retry !== undefined && <button type="button" className="tb-btn" onClick={retry}>다시 받기</button>}
    </div>
  );
}

export function Loaded<T>({ query, label, children }: { query: UseQueryResult<T>; label: string; children: (data: T) => ReactNode }) {
  if (query.data !== undefined) return <>{children(query.data)}</>;
  if (query.isError) return <CardError message={query.error instanceof Error ? query.error.message : `${label}을 받지 못했습니다`} retry={() => void query.refetch()} />;
  return <Skeleton label={`${label}을 받는 중`} />;
}

export function PartView<T>({ part, children }: { part: MarketOverviewPart<T>; children: (value: T) => ReactNode }) {
  return part.status === "ok" ? <>{children(part.value)}</> : <CardError message={part.error.message} />;
}
