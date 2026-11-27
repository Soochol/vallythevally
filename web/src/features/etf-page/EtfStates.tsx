import type { ReactNode } from "react";
import { endsWithFinalConsonant } from "../../lib/josa";
import { EmptyState, ErrorState, Skeleton, type SkeletonShape } from "../overlay/State";

export function Loading({ label, shape = "card", wide = true }: { label: string; shape?: SkeletonShape; wide?: boolean }) {
  return <div className={wide ? "etf-state etf-card-wide" : "etf-state"}><Skeleton label={label} shape={shape} /></div>;
}

export function Failure({ what, retry, wide = true }: { what: string; retry: () => void; wide?: boolean }) {
  return <div className={wide ? "etf-state etf-card-wide" : "etf-state"}><ErrorState message={`${what}${endsWithFinalConsonant(what) ? "을" : "를"} 불러오지 못했습니다`} retry={retry} /></div>;
}

export function Notice({ title, children, role = "status", wide = true }: { title: string; children?: ReactNode; role?: "status" | "alert"; wide?: boolean }) {
  return <div role={role} className={wide ? "etf-state etf-card-wide" : "etf-state"}><EmptyState title={title}>{children}</EmptyState></div>;
}
