import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { OrdersAccount } from "../../api/generated/OrdersAccount";
import { ApiRequestError } from "../../api/http";
import { checkOrdersAccount, ORDERS_QUERY_KEY, switchOrders } from "../../api/system";
import { accountNumberOf, mergeOrdersStatus, orderCanTurnOff, orderCanTurnOn } from "./orderUse";
import { useCommand } from "./useCommand";

export function KiwoomRowOrders({ keyId, order }: { keyId: string; order: OrdersAccount }) {
  const queryClient = useQueryClient();
  const command = useCommand();
  const [checkedTail, setCheckedTail] = useState<string | null>(null);
  const [accountConfirmed, setAccountConfirmed] = useState(false);
  const closeConfirmation = () => {
    setCheckedTail(null);
    setAccountConfirmed(false);
  };
  const apply = async (enabled: boolean) => {
    const confirmAccountTail = enabled ? checkedTail : null;
    const saved = await command.run(async () => {
      try {
        const result = await switchOrders({ enabled, confirmAccountTail, keyId });
        queryClient.setQueryData(ORDERS_QUERY_KEY, (old: Parameters<typeof mergeOrdersStatus>[0]) => mergeOrdersStatus(old, result, order.market));
      } catch (error) {
        if (error instanceof ApiRequestError && error.code === "conflict") closeConfirmation();
        throw error;
      }
    });
    if (saved) closeConfirmation();
  };
  const startEnabling = () => void command.run(async () => setCheckedTail((await checkOrdersAccount(keyId)).accountTail));

  return (
    <section aria-label="주문 사용" className="flex flex-col gap-2" data-testid="key-orders">
      <p className="text-m text-text-2">계좌번호 <span className="font-mono text-text">{accountNumberOf(order.accountTail)}</span></p>
      {checkedTail !== null && (
        <div className="flex flex-col gap-2">
          <p className="text-m text-text-2">키움이 알려 준 계좌번호(8자리) 끝 2자리: <span className="font-mono text-text">{checkedTail}</span></p>
          <label className="flex items-start gap-2 text-m">
            <input type="checkbox" className="mt-1" checked={accountConfirmed} onChange={(e) => setAccountConfirmed(e.target.checked)} />
            이 계좌가 맞습니다
          </label>
          <div className="flex gap-2">
            <button type="button" className="btn-primary h-9 px-4 disabled:cursor-not-allowed disabled:opacity-50" disabled={!accountConfirmed || command.busy} onClick={() => void apply(true)}>켜기 확인</button>
            <button type="button" className="tb-btn h-9 px-3" disabled={command.busy} onClick={closeConfirmation}>취소</button>
          </div>
        </div>
      )}
      {checkedTail === null && (
        <div className="flex flex-wrap gap-2">
          {orderCanTurnOn(order.state) && <button type="button" className="tb-btn h-9 px-3" disabled={command.busy} onClick={startEnabling}>주문 사용 켜기</button>}
          {orderCanTurnOff(order.state) && <button type="button" className="tb-btn h-9 px-3" disabled={command.busy} onClick={() => void apply(false)}>주문 사용 끄기</button>}
        </div>
      )}
      {command.error && <p role="alert" className="text-m text-danger" data-testid="key-orders-error">{command.error}</p>}
    </section>
  );
}
