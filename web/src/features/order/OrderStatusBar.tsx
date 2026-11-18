import type { OrderStatus } from "./statusText";

interface Props {
  readonly status: OrderStatus;
  readonly queued: number;
  readonly blocked: boolean;
  readonly onUndo: (orderNo: string) => void;
  readonly onReconcile: () => void;
}

export function OrderStatusBar({ status, queued, blocked, onUndo, onReconcile }: Props) {
  const unknown = blocked || status.unknown === true;
  return (
    <div className="od-status" role="status" data-testid="order-status" data-tone={unknown ? "warn" : status.tone}>
      <span className="od-status-text">{status.text}</span>
      {queued > 0 && <span className="od-queue" data-testid="order-queue">줄 서는 중 · {queued}건</span>}
      {status.undoOrderNo && <button type="button" className="od-link" onClick={() => onUndo(status.undoOrderNo!)}>되돌리기</button>}
      {unknown && <button type="button" className="od-link" onClick={onReconcile}>조회로 확인</button>}
    </div>
  );
}
