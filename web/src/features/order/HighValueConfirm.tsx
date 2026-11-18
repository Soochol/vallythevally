import { useId, useState } from "react";
import { DialogFrame } from "../dialog/DialogParts";
import { formatWon } from "../market-window/format";

export interface HighValueRequest {
  readonly title: string;
  readonly amount: number;
  readonly run: () => void;
}

export function HighValueConfirm({ request, onClose }: { request: HighValueRequest; onClose: () => void }) {
  const [checked, setChecked] = useState(false);
  const titleId = useId();
  return (
    <DialogFrame labelledBy={titleId} width="w-[min(420px,calc(100vw-32px))]" onClose={onClose}>
      <div className="px-5 pb-2 pt-5" data-testid="order-confirm">
        <h2 id={titleId} className="text-m font-semibold leading-snug">고액 주문 확인</h2>
        <p className="mt-2 text-s text-text-2">{request.title}</p>
        <p className="mt-1 text-s">주문금액 <b data-testid="order-confirm-amount">{formatWon(request.amount)}</b></p>
        <label className="mt-3 flex items-center gap-2 text-s">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          1억원 이상 주문임을 확인했습니다
        </label>
      </div>
      <div className="flex justify-end gap-2 px-5 pb-4 pt-3">
        <button type="button" className="tb-btn h-8" onClick={onClose}>취소</button>
        <button type="button" className="btn-primary h-8" disabled={!checked} onClick={() => { request.run(); onClose(); }}>주문 보내기</button>
      </div>
    </DialogFrame>
  );
}
