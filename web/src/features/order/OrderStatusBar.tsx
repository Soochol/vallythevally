import type { ReplayView } from "../book-replay/replay";
import { FeedStatusLine, hasFeedStatusAlert, type LadderFeedStatus, MarketStatusLine, MarketStatusSlot, ReplayStatusLine } from "../market-window/MarketStatusBar";
import type { OrderStatus, StatusTone } from "./statusText";

interface Props {
  readonly status: OrderStatus | null;
  readonly queued: number;
  readonly blocked: boolean;
  readonly feed?: LadderFeedStatus | null;
  readonly replay?: ReplayView | null;
  readonly onUndo: (orderNo: string) => void;
  readonly onReconcile: () => void;
  readonly onDismiss: () => void;
}

const BLOCKED_TEXT = "결과를 확인하지 못한 주문이 있습니다";

export function OrderStatusBar({ status, queued, blocked, feed = null, replay = null, onUndo, onReconcile, onDismiss }: Props) {
  const unknown = blocked || status?.unknown === true;
  const shown = status !== null || queued > 0 || unknown;
  const tone: StatusTone = unknown ? "warn" : status?.tone ?? "info";
  const text = status?.text ?? (unknown ? BLOCKED_TEXT : null);
  const feedAlert = hasFeedStatusAlert(feed, replay?.kind ?? "live");
  return (
    <MarketStatusSlot testId="order-status-slot">
      {shown ? (
        <MarketStatusLine testId="order-status" tone={tone} text={text}>
          {feedAlert && <span className="od-queue" data-testid="order-feed-warn">시세 연결 확인</span>}
          {replay !== null && <span className="od-replay-lock">주문 잠금</span>}
          {queued > 0 && <span className="od-queue" data-testid="order-queue">줄 서는 중 · {queued}건</span>}
          {status?.action && <button type="button" className="mw-status-button" data-testid="order-status-action" onClick={status.action.run}>{status.action.label}</button>}
          {status?.undoOrderNo && <button type="button" className="mw-status-button" onClick={() => onUndo(status.undoOrderNo!)}>되돌리기</button>}
          {unknown && <button type="button" className="mw-status-button" onClick={onReconcile}>조회로 확인</button>}
          {status?.tone === "error" && !unknown && <button type="button" className="mw-status-button" onClick={onDismiss}>닫기</button>}
        </MarketStatusLine>
      ) : feedAlert && feed !== null ? (
        <FeedStatusLine feed={feed} />
      ) : replay !== null ? (
        <ReplayStatusLine view={replay} trailing={<span className="od-replay-lock">주문 잠금</span>} />
      ) : null}
    </MarketStatusSlot>
  );
}
