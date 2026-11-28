import type { ReactNode } from "react";
import type { ReplayVenueScope } from "../../api/generated/ReplayVenueScope";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { toChartTime } from "../../chart/time";
import { useVenue } from "../../stores/ui";

const pad2 = (value: number): string => String(value).padStart(2, "0");

export type ReplayStripView =
  | { readonly kind: "live" }
  | { readonly kind: "none"; readonly reason: string }
  | { readonly kind: "past"; readonly at: UnixSeconds; readonly venueScope?: ReplayVenueScope };

export const REPLAY_LIVE_TEXT = "실시간 · 차트를 가리키면 그 시각 호가";
export const REPLAY_VENUE_TITLE = "수집 호가는 통합 시세입니다";
export const REPLAY_ARCHIVE_TITLE = "KRX 단독 아카이브 수집본(비수정주가)입니다. NXT 거래분은 포함되지 않습니다";

export function formatReplayAt(at: UnixSeconds): string {
  const date = new Date(toChartTime(at) * 1000);
  return `${pad2(date.getUTCMonth() + 1)}/${pad2(date.getUTCDate())} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`;
}

function PastReplayStrip({
  at,
  venueScope,
  subject,
  showVenueBadge,
  children,
}: {
  readonly at: UnixSeconds;
  readonly venueScope?: ReplayVenueScope;
  readonly subject: string;
  readonly showVenueBadge: boolean;
  readonly children?: ReactNode;
}) {
  const appVenue = useVenue();
  const isArchive = venueScope === "krx_archive";
  return (
    <div
      className="mw-replay-strip"
      role="status"
      data-testid="replay-strip"
      data-kind="past"
      data-venue-scope={isArchive ? "krx_archive" : undefined}
    >
      <span>{`수집 ${subject} · ${formatReplayAt(at)}`}</span>
      {isArchive ? (
        <span className="mw-replay-archive" data-testid="replay-archive-badge" title={REPLAY_ARCHIVE_TITLE}>
          KRX 단독
        </span>
      ) : showVenueBadge && appVenue !== "combined" ? (
        <span className="mw-integrated mw-replay-venue" data-testid="replay-venue" title={REPLAY_VENUE_TITLE}>
          통합
        </span>
      ) : null}
      {children}
    </div>
  );
}

export function ReplayStrip({
  view,
  subject = "호가",
  showVenueBadge = true,
  children,
}: {
  readonly view: ReplayStripView;
  readonly subject?: string;
  readonly showVenueBadge?: boolean;
  readonly children?: ReactNode;
}) {
  if (view.kind === "past") {
    return (
      <PastReplayStrip at={view.at} venueScope={view.venueScope} subject={subject} showVenueBadge={showVenueBadge}>
        {children}
      </PastReplayStrip>
    );
  }
  if (view.kind === "none") {
    return (
      <div className="mw-replay-strip" role="status" data-testid="replay-strip" data-kind="none">
        <span>{view.reason}</span>
      </div>
    );
  }
  return (
    <div className="mw-replay-strip" role="status" data-testid="replay-strip" data-kind="live">
      <span>{`실시간 · 차트를 가리키면 그 시각 ${subject}`}</span>
    </div>
  );
}
