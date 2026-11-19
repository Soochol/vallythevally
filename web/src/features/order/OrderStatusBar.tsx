import type { OrderStatus } from "./statusText";

interface Props {
  readonly status: OrderStatus | null;
  readonly queued: number;
  readonly blocked: boolean;
  readonly onUndo: (orderNo: string) => void;
  readonly onReconcile: () => void;
  readonly onDismiss: () => void;
}

const BLOCKED_TEXT = "결과를 확인하지 못한 주문이 있습니다";

export function OrderStatusBar({ status, queued, blocked, onUndo, onReconcile, onDismiss }: Props) {
  const unknown = blocked || status?.unknown === true;
  if (status === null && queued === 0 && !unknown) return null;
  const text = status?.text ?? (unknown ? BLOCKED_TEXT : null);
  return (
    <div className="od-status" role="status" data-testid="order-status" data-tone={unknown ? "warn" : status?.tone ?? "info"}>
      {text !== null && <span className="od-status-text">{text}</span>}
      {queued > 0 && <span className="od-queue" data-testid="order-queue">줄 서는 중 · {queued}건</span>}
      {status?.action && <button type="button" className="od-link" data-testid="order-status-action" onClick={status.action.run}>{status.action.label}</button>}
      {status?.undoOrderNo && <button type="button" className="od-link" onClick={() => onUndo(status.undoOrderNo!)}>되돌리기</button>}
      {unknown && <button type="button" className="od-link" onClick={onReconcile}>조회로 확인</button>}
      {status?.tone === "error" && !unknown && <button type="button" className="od-link" onClick={onDismiss}>닫기</button>}
    </div>
  );
}
