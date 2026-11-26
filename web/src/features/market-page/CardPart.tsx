import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { ApiErrorCode } from "../../api/generated/ApiErrorCode";
import type { Broker } from "../../api/generated/Broker";
import type { MarketOverviewPart } from "../../api/generated/MarketOverviewPart";
import { ApiRequestError } from "../../api/http";
import { useMarketSource } from "../../stores/kiwoomLink";
import { EmptyState, Skeleton, type SkeletonShape } from "../overlay/State";
import { brokerShortName, FEED_UNAVAILABLE_TEXT, feedMarkOf } from "../status/marketFeed";
import { openSystemSettings } from "../system-settings/open";

const NOT_PREPARED_HINT = "수집기가 장중(평일 08:00–20:00)에 자료를 채우면 1분마다 자동으로 갱신됩니다";

export function FeedMark({ received }: { received: Broker | undefined }) {
  const source = useMarketSource();
  const mark = received === undefined ? null : feedMarkOf(source, received);
  return mark === null ? null : <span className="mk-feed-mark" data-testid="feed-source-mark" title={`이 칸은 ${brokerShortName(mark)}에서 받았습니다`}>{brokerShortName(mark)}</span>;
}

export function FeedUnavailable() {
  return (
    <div className="mk-unavailable" data-testid="feed-unavailable">
      <p className="mk-empty">{FEED_UNAVAILABLE_TEXT}</p>
      <button type="button" className="btn btn-sm" onClick={() => openSystemSettings("kiwoom")}>시스템 설정 이어가기</button>
    </div>
  );
}

export function CardShell({ title, note, source, card, children }: { title: string; note?: ReactNode; source?: Broker; card: string; children: ReactNode }) {
  return (
    <section className="mk-card" aria-label={title} data-card={card}>
      <header className="mk-card-head">
        <h2>{title}</h2>
        <FeedMark received={source} />
        {note !== undefined && <span className="mk-card-note">{note}</span>}
      </header>
      {children}
    </section>
  );
}

export function CardError({ message, retry, code }: { message: string; retry?: () => void; code?: ApiErrorCode | "network" }) {
  if (code === "not_prepared") {
    return (
      <div role="alert" className="mk-pending" data-kind="not-prepared">
        <div className="mk-pending-head">
          <span className="mk-pending-title">
            <i className="mk-pending-dot" aria-hidden="true" />
            <span>{message}</span>
          </span>
          {retry !== undefined && <button type="button" className="btn btn-sm" onClick={retry}>다시 확인</button>}
        </div>
        <p className="mk-pending-hint">{NOT_PREPARED_HINT}</p>
      </div>
    );
  }
  return (
    <div role="alert" className="mk-error">
      <span>{message}</span>
      {retry !== undefined && <button type="button" className="btn btn-sm" onClick={retry}>다시 시도</button>}
    </div>
  );
}

export interface SkeletonSpec {
  shape: SkeletonShape;
  minHeight: string;
  placeholder?: ReactNode;
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return <div className="mk-empty-state"><EmptyState title={String(children)} /></div>;
}

export function Loaded<T>({ query, label, skeleton, children }: { query: UseQueryResult<T>; label: string; skeleton: SkeletonSpec; children: (data: T) => ReactNode }) {
  if (query.data !== undefined) return <>{children(query.data)}</>;
  if (query.isError) {
    const code = query.error instanceof ApiRequestError ? query.error.code : undefined;
    const message = query.error instanceof Error ? query.error.message : `${label}을 받지 못했습니다`;
    return <CardError message={message} code={code} retry={() => void query.refetch()} />;
  }
  if (skeleton.placeholder !== undefined) return <div role="status" aria-label={`${label}을 받는 중`} className="mk-placeholder">{skeleton.placeholder}</div>;
  return <Skeleton label={`${label}을 받는 중`} shape={skeleton.shape} minHeight={skeleton.minHeight} />;
}

export function PartView<T>({ part, onRetry, children }: { part: MarketOverviewPart<T>; onRetry?: () => void; children: (value: T) => ReactNode }) {
  return part.status === "ok" ? <>{children(part.value)}</> : <CardError message={part.error.message} code={part.error.code} retry={onRetry} />;
}
