import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { KiwoomKey } from "../../api/generated/KiwoomKey";
import type { OrdersAccount } from "../../api/generated/OrdersAccount";
import { ApiRequestError } from "../../api/http";
import { checkOrdersAccount, ORDERS_QUERY_KEY, switchOrders } from "../../api/system";
import { digitsOnly, kisCanEnableOrders, kisListingOf, NO_ACCOUNT_ORDER_NOTE } from "./kisAccount";
import { accountNumberOf, canConfirmEnable, enableTail, mergeOrdersStatus, orderCanTurnOff, orderCanTurnOn } from "./orderUse";
import { useCommand } from "./useCommand";

export function KiwoomRowOrders({ entry, order }: { entry: KiwoomKey; order: OrdersAccount }) {
  const queryClient = useQueryClient();
  const command = useCommand();
  const keyId = entry.keyId;
  const kis = entry.broker === "kis";
  const accountMissing = kis && !kisCanEnableOrders(kisListingOf(entry));
  const [checkedTail, setCheckedTail] = useState<string | null>(null);
  const [accountConfirmed, setAccountConfirmed] = useState(false);
  const [typedTail, setTypedTail] = useState("");
  const closeConfirmation = () => {
    setCheckedTail(null);
    setAccountConfirmed(false);
    setTypedTail("");
  };
  const apply = async (enabled: boolean) => {
    const confirmAccountTail = enabled ? enableTail(entry.broker, checkedTail, typedTail) : null;
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
      {!kis && <p className="text-m text-text-2">계좌번호 <span className="font-mono text-text">{accountNumberOf(order.accountTail)}</span></p>}
      {checkedTail !== null && (
        <div className="flex flex-col gap-2">
          {kis ? (
            <>
              <p className="text-m text-text-2">이 계좌로 잔고 조회가 됐습니다</p>
              <label className="flex items-center gap-2 text-m">
                <span className="text-text-2">계좌번호 끝 2자리 입력</span>
                <input className="h-9 w-16 rounded-s border border-line bg-bg px-2 text-center font-mono text-m text-text focus:border-accent focus:outline-none" type="text" inputMode="numeric" name="kis-confirm-tail" aria-label="계좌번호 끝 2자리 입력" autoComplete="off" maxLength={2} disabled={command.busy} value={typedTail} onChange={(e) => setTypedTail(digitsOnly(e.target.value))} />
              </label>
            </>
          ) : (
            <>
              <p className="text-m text-text-2">키움이 알려 준 계좌번호(8자리) 끝 2자리: <span className="font-mono text-text">{checkedTail}</span></p>
              <label className="flex items-start gap-2 text-m">
                <input type="checkbox" className="mt-1" checked={accountConfirmed} onChange={(e) => setAccountConfirmed(e.target.checked)} />
                이 계좌가 맞습니다
              </label>
            </>
          )}
          <div className="flex gap-2">
            <button type="button" className="btn-primary h-9 px-4 disabled:cursor-not-allowed disabled:opacity-50" disabled={!canConfirmEnable(entry.broker, accountConfirmed, typedTail) || command.busy} onClick={() => void apply(true)}>켜기 확인</button>
            <button type="button" className="tb-btn h-9 px-3" disabled={command.busy} onClick={closeConfirmation}>취소</button>
          </div>
        </div>
      )}
      {checkedTail === null && (
        <div className="flex flex-wrap gap-2">
          {orderCanTurnOn(order.state) && <button type="button" className="tb-btn h-9 px-3 disabled:cursor-not-allowed disabled:opacity-50" disabled={command.busy || accountMissing} onClick={startEnabling}>주문 사용 켜기</button>}
          {orderCanTurnOff(order.state) && <button type="button" className="tb-btn h-9 px-3" disabled={command.busy} onClick={() => void apply(false)}>주문 사용 끄기</button>}
        </div>
      )}
      {accountMissing && checkedTail === null && orderCanTurnOn(order.state) && <p className="text-s text-text-3" data-testid="kis-no-account-note">{NO_ACCOUNT_ORDER_NOTE}</p>}
      {command.error && <p role="alert" className="text-m text-danger" data-testid="key-orders-error">{command.error}</p>}
    </section>
  );
}
