import type { ReactNode } from "react";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { toChartTime } from "../../chart/time";
import { useVenue } from "../../stores/ui";
import type { ReplayView } from "./replay";
import { useBookReplayEnabled } from "./useBookReplay";

const pad2 = (value: number): string => String(value).padStart(2, "0");

function formatReplayAt(at: UnixSeconds): string {
  const date = new Date(toChartTime(at) * 1000);
  return `${pad2(date.getUTCMonth() + 1)}/${pad2(date.getUTCDate())} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`;
}

function PastReplayStrip({ at, children }: { readonly at: UnixSeconds; readonly children?: ReactNode }) {
  const appVenue = useVenue();
  return (
    <div className="mw-replay-strip" role="status" data-testid="replay-strip" data-kind="past">
      <span>{`수집 호가 · ${formatReplayAt(at)}`}</span>
      {appVenue !== "combined" && (
        <span className="mw-integrated mw-replay-venue" data-testid="replay-venue" title="수집 호가는 통합 시세입니다">
          통합
        </span>
      )}
      {children}
    </div>
  );
}

export function ReplayStrip({ view, children }: { readonly view: ReplayView; readonly children?: ReactNode }) {
  const enabled = useBookReplayEnabled();
  if (!enabled) return null;
  if (view.kind === "past") return <PastReplayStrip at={view.at}>{children}</PastReplayStrip>;
  if (view.kind === "none") {
    return (
      <div className="mw-replay-strip" role="status" data-testid="replay-strip" data-kind="none">
        <span>{view.reason}</span>
      </div>
    );
  }
  return (
    <div className="mw-replay-strip" role="status" data-testid="replay-strip" data-kind="live">
      <span>실시간 · 차트를 가리키면 그 시각 호가</span>
    </div>
  );
}
