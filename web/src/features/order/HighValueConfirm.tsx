import { useId, useState } from "react";
import type { OrderSide } from "../../api/generated/OrderSide";
import { DialogFrame } from "../dialog/DialogParts";
import { formatWon } from "../market-window/format";
import { SIDE_LABEL } from "./orderRules";

export interface HighValueRequest {
  readonly name: string;
  readonly code: string;
  readonly side: OrderSide;
  readonly verb: "주문" | "정정";
  readonly detail: string;
  readonly amount: number;
  readonly account: string;
  readonly route: string;
  readonly mock: boolean;
  readonly run: () => void;
}

export function HighValueConfirm({ request, onClose }: { request: HighValueRequest; onClose: () => void }) {
  const [checked, setChecked] = useState(false);
  const titleId = useId();
  return (
    <DialogFrame solid labelledBy={titleId} width="w-[min(420px,calc(100vw-32px))]" onClose={onClose}>
      <div className="od-confirm" data-testid="order-confirm">
        <h2 id={titleId} className="od-confirm-title">고액 주문 확인</h2>
        <p className="od-confirm-symbol" data-testid="order-confirm-symbol"><b>{request.name}</b> <span>{request.code}</span></p>
        <p className="od-confirm-line">
          <span className="od-confirm-side" data-side={request.side}>{SIDE_LABEL[request.side]}{request.verb === "정정" ? " 정정" : ""}</span>
          <span data-testid="order-confirm-detail">{request.detail}</span>
        </p>
        <p className="od-confirm-amount">주문금액 <b data-testid="order-confirm-amount">{formatWon(request.amount)}</b></p>
        <p className="od-confirm-where" data-testid="order-confirm-where">
          <span>계좌 {request.account}</span>
          <span>주문 경로 {request.route}</span>
          <span>{request.mock ? "모의" : "실전"}</span>
        </p>
        <label className="od-confirm-check">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          1억원 이상 주문임을 확인했습니다
        </label>
      </div>
      <div className="od-confirm-actions">
        <button type="button" className="btn" onClick={onClose}>취소</button>
        <button type="button" className="btn-primary" disabled={!checked} onClick={() => { request.run(); onClose(); }}>{SIDE_LABEL[request.side]} {request.verb} 보내기</button>
      </div>
    </DialogFrame>
  );
}
