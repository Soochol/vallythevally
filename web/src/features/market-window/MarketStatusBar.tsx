import type { ReactNode } from "react";
import type { SubErrorCode } from "../../api/generated/SubErrorCode";
import { useVenue } from "../../stores/ui";
import type { ReplayView } from "../book-replay/replay";
import { formatReplayAt, REPLAY_LIVE_TEXT, REPLAY_VENUE_TITLE } from "../book-replay/ReplayStrip";
import { CheckCircleIcon, ClockIcon, CloseIcon, InfoIcon, WarningIcon } from "../icons";
import { feedDownText, feedRejectionText } from "./FeedStrip";

export type MarketStatusTone = "info" | "ok" | "error" | "warn" | "replay";

const STATUS_ICON_SIZE = 14;

function StatusToneIcon({ tone }: { readonly tone: MarketStatusTone }) {
  if (tone === "ok") return <CheckCircleIcon size={STATUS_ICON_SIZE} />;
  if (tone === "error") return <CloseIcon size={STATUS_ICON_SIZE} />;
  if (tone === "warn") return <WarningIcon size={STATUS_ICON_SIZE} />;
  if (tone === "replay") return <ClockIcon size={STATUS_ICON_SIZE} />;
  return <InfoIcon size={STATUS_ICON_SIZE} />;
}

export function MarketStatusSlot({ testId, children }: { readonly testId: string; readonly children?: ReactNode }) {
  return (
    <div className="mw-status-slot" data-testid={testId}>
      {children}
    </div>
  );
}

interface StatusLineProps {
  readonly tone: MarketStatusTone;
  readonly text: string | null;
  readonly testId?: string;
  readonly kind?: string;
  readonly children?: ReactNode;
}

export function MarketStatusLine({ tone, text, testId, kind, children }: StatusLineProps) {
  return (
    <div className="mw-status" role="status" data-testid={testId} data-tone={tone} data-kind={kind}>
      <span className="mw-status-icon" aria-hidden="true"><StatusToneIcon tone={tone} /></span>
      {text !== null && <span className="mw-status-text">{text}</span>}
      {children}
    </div>
  );
}

export interface LadderFeedStatus {
  readonly connected: boolean;
  readonly rejected: SubErrorCode | null;
  readonly downSince: number | null;
}

export function hasFeedStatusAlert(feed: LadderFeedStatus | null | undefined, replayKind: ReplayView["kind"]): boolean {
  return feed != null && replayKind === "live" && (feed.rejected !== null || !feed.connected);
}

export function FeedStatusLine({ feed }: { readonly feed: LadderFeedStatus }) {
  if (feed.rejected !== null) {
    return <MarketStatusLine testId="feed-rejected" tone="warn" text={feedRejectionText(feed.rejected)} />;
  }
  if (!feed.connected) {
    return <MarketStatusLine testId="feed-down" tone="warn" text={feedDownText(feed.downSince)} />;
  }
  return null;
}

export function ReplayStatusLine({ view, trailing }: { readonly view: ReplayView; readonly trailing?: ReactNode }) {
  const appVenue = useVenue();
  if (view.kind === "past") {
    return (
      <MarketStatusLine testId="replay-strip" kind="past" tone="replay" text={`수집 호가 · ${formatReplayAt(view.at)}`}>
        {appVenue !== "combined" && (
          <span className="mw-integrated mw-replay-venue" data-testid="replay-venue" title={REPLAY_VENUE_TITLE}>
            통합
          </span>
        )}
        {trailing}
      </MarketStatusLine>
    );
  }
  if (view.kind === "none") {
    return <MarketStatusLine testId="replay-strip" kind="none" tone="warn" text={view.reason} />;
  }
  return <MarketStatusLine testId="replay-strip" kind="live" tone="info" text={REPLAY_LIVE_TEXT} />;
}

interface BookStatusBarProps {
  readonly feed: LadderFeedStatus;
  readonly replay: ReplayView;
  readonly replayEnabled: boolean;
}

export function BookStatusBar({ feed, replay, replayEnabled }: BookStatusBarProps) {
  return (
    <MarketStatusSlot testId="book-status-slot">
      {hasFeedStatusAlert(feed, replay.kind) ? (
        <FeedStatusLine feed={feed} />
      ) : replayEnabled ? (
        <ReplayStatusLine view={replay} />
      ) : null}
    </MarketStatusSlot>
  );
}
