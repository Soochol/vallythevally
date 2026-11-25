import { useVenue } from "../../stores/ui";
import { formatReplayAt, REPLAY_LIVE_TEXT, REPLAY_VENUE_TITLE } from "../book-replay/ReplayStrip";
import type { ReplayView } from "../book-replay/replay";
import { CheckCircleIcon, ClockIcon, CloseIcon, InfoIcon, WarningIcon } from "../icons";
import type { OrderStatus, StatusTone } from "./statusText";

interface Props {
  readonly status: OrderStatus | null;
  readonly queued: number;
  readonly blocked: boolean;
  readonly replay?: ReplayView | null;
  readonly onUndo: (orderNo: string) => void;
  readonly onReconcile: () => void;
  readonly onDismiss: () => void;
}

const BLOCKED_TEXT = "결과를 확인하지 못한 주문이 있습니다";

const ICON_SIZE = 14;

function ToneIcon({ tone }: { tone: StatusTone }) {
  if (tone === "ok") return <CheckCircleIcon size={ICON_SIZE} />;
  if (tone === "error") return <CloseIcon size={ICON_SIZE} />;
  if (tone === "warn") return <WarningIcon size={ICON_SIZE} />;
  return <InfoIcon size={ICON_SIZE} />;
}

function ReplayStatus({ view }: { readonly view: ReplayView }) {
  const appVenue = useVenue();
  if (view.kind === "past") {
    return (
      <div className="od-status" role="status" data-testid="replay-strip" data-kind="past" data-tone="replay">
        <span className="od-status-icon" aria-hidden="true"><ClockIcon size={ICON_SIZE} /></span>
        <span className="od-status-text">{`수집 호가 · ${formatReplayAt(view.at)}`}</span>
        {appVenue !== "combined" && (
          <span className="mw-integrated mw-replay-venue" data-testid="replay-venue" title={REPLAY_VENUE_TITLE}>
            통합
          </span>
        )}
        <span className="od-replay-lock">주문 잠금</span>
      </div>
    );
  }
  if (view.kind === "none") {
    return (
      <div className="od-status" role="status" data-testid="replay-strip" data-kind="none" data-tone="warn">
        <span className="od-status-icon" aria-hidden="true"><WarningIcon size={ICON_SIZE} /></span>
        <span className="od-status-text">{view.reason}</span>
      </div>
    );
  }
  return (
    <div className="od-status" role="status" data-testid="replay-strip" data-kind="live" data-tone="info">
      <span className="od-status-icon" aria-hidden="true"><InfoIcon size={ICON_SIZE} /></span>
      <span className="od-status-text">{REPLAY_LIVE_TEXT}</span>
    </div>
  );
}

export function OrderStatusBar({ status, queued, blocked, replay = null, onUndo, onReconcile, onDismiss }: Props) {
  const unknown = blocked || status?.unknown === true;
  const shown = status !== null || queued > 0 || unknown;
  const tone: StatusTone = unknown ? "warn" : status?.tone ?? "info";
  const text = status?.text ?? (unknown ? BLOCKED_TEXT : null);
  return (
    <div className="od-status-slot" data-testid="order-status-slot">
      {shown ? (
        <div className="od-status" role="status" data-testid="order-status" data-tone={tone}>
          <span className="od-status-icon" aria-hidden="true"><ToneIcon tone={tone} /></span>
          {text !== null && <span className="od-status-text">{text}</span>}
          {queued > 0 && <span className="od-queue" data-testid="order-queue">줄 서는 중 · {queued}건</span>}
          {status?.action && <button type="button" className="od-status-button" data-testid="order-status-action" onClick={status.action.run}>{status.action.label}</button>}
          {status?.undoOrderNo && <button type="button" className="od-status-button" onClick={() => onUndo(status.undoOrderNo!)}>되돌리기</button>}
          {unknown && <button type="button" className="od-status-button" onClick={onReconcile}>조회로 확인</button>}
          {status?.tone === "error" && !unknown && <button type="button" className="od-status-button" onClick={onDismiss}>닫기</button>}
        </div>
      ) : replay !== null && (
        <ReplayStatus view={replay} />
      )}
    </div>
  );
}
