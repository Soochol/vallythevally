import type { OrderSide } from "../../api/generated/OrderSide";
import { CheckCircleIcon, CloseIcon, InfoIcon, WarningIcon } from "../icons";
import type { OrderStatus, StatusTone } from "./statusText";

export interface CancelConfirm {
  readonly text: string;
  readonly account: string | null;
  readonly targets: readonly { readonly side: OrderSide; readonly price: number }[];
  readonly signature: string;
  readonly run: () => void;
}

interface Props {
  readonly status: OrderStatus | null;
  readonly queued: number;
  readonly blocked: boolean;
  readonly confirm: CancelConfirm | null;
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

export function OrderStatusBar({ status, queued, blocked, confirm, onUndo, onReconcile, onDismiss }: Props) {
  const unknown = blocked || status?.unknown === true;
  const shown = confirm !== null || status !== null || queued > 0 || unknown;
  const tone: StatusTone = confirm !== null || unknown ? "warn" : status?.tone ?? "info";
  const text = status?.text ?? (unknown ? BLOCKED_TEXT : null);
  return (
    <div className="od-status-slot" data-testid="order-status-slot">
      {shown && (
        <div className="od-status" role="status" data-testid="order-status" data-tone={tone}>
          <span className="od-status-icon" aria-hidden="true"><ToneIcon tone={tone} /></span>
          {confirm !== null
            ? <button type="button" className="od-status-confirm" data-testid="order-cancel-confirm" onClick={confirm.run}>{confirm.text}</button>
            : text !== null && <span className="od-status-text">{text}</span>}
          {queued > 0 && <span className="od-queue" data-testid="order-queue">줄 서는 중 · {queued}건</span>}
          {confirm === null && status?.action && <button type="button" className="od-status-button" data-testid="order-status-action" onClick={status.action.run}>{status.action.label}</button>}
          {confirm === null && status?.undoOrderNo && <button type="button" className="od-status-button" onClick={() => onUndo(status.undoOrderNo!)}>되돌리기</button>}
          {confirm === null && unknown && <button type="button" className="od-status-button" onClick={onReconcile}>조회로 확인</button>}
          {confirm === null && status?.tone === "error" && !unknown && <button type="button" className="od-status-button" onClick={onDismiss}>닫기</button>}
        </div>
      )}
    </div>
  );
}
