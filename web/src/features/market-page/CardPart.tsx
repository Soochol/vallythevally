import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { MarketOverviewPart } from "../../api/generated/MarketOverviewPart";
import { Skeleton } from "../overlay/State";

export function CardShell({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="mk-card" aria-label={title}>
      <header className="mk-card-head">
        <h2>{title}</h2>
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
