import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { KiwoomKey } from "../../api/generated/KiwoomKey";
import type { OrdersAccount } from "../../api/generated/OrdersAccount";
import { ApiRequestError } from "../../api/http";
import { checkOrdersAccount, ORDERS_QUERY_KEY, switchOrders } from "../../api/system";
import { WarningIcon } from "../icons";
import { digitsOnly, kisCanEnableOrders, kisListingOf, NO_ACCOUNT_ORDER_NOTE } from "./kisAccount";
import { FormActions } from "./KiwoomKeyFields";
import { accountNumberOf, canConfirmEnable, enableTail, enableWarning, mergeOrdersStatus, orderCanTurnOff, orderCanTurnOn, orderStateSentence, orderSwitchOn } from "./orderUse";
import { useCommand } from "./useCommand";

export function KiwoomRowOrders({ entry, order, mock }: { entry: KiwoomKey; order: OrdersAccount; mock: boolean }) {
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
  const checked = orderSwitchOn(order.state);
  const inUse = orderCanTurnOff(order.state);
  const settable = checked || orderCanTurnOn(order.state);
  const offOnly = inUse && !checked;
  const confirming = checkedTail !== null;
  const stateId = `orders-state-${keyId}`;

  return (
    <section aria-label="주문 사용" className="flex flex-col gap-2" data-testid="key-orders">
      <h4 className="text-s font-semibold text-text-2">주문</h4>
      {!kis && <p className="text-m text-text-2">계좌번호 <span className="font-mono text-text">{accountNumberOf(order.accountTail)}</span></p>}
      <button type="button" role="switch" aria-checked={checked} aria-describedby={stateId} aria-label="주문 사용" disabled={command.busy || confirming || !settable || (accountMissing && !checked)} className="ui-switch" onClick={() => (checked ? void apply(false) : startEnabling())}>
        <span aria-hidden="true" className="ui-switch-track"><span /></span>
        <span className="text-m">주문 사용</span>
      </button>
      <p id={stateId} className={`text-s ${inUse && !mock ? "text-warning" : "text-text-2"}`}>{orderStateSentence(order.state, mock)}</p>
      {offOnly && !confirming && <button type="button" className="btn self-start" disabled={command.busy} onClick={() => void apply(false)}>주문 끄기</button>}
      {accountMissing && !confirming && orderCanTurnOn(order.state) && <p className="text-s text-text-2" data-testid="kis-no-account-note">{NO_ACCOUNT_ORDER_NOTE}</p>}
      {confirming && (
        <div role="group" aria-label="주문 켜기 확인" className={`flex flex-col gap-3 rounded-m border p-3 ${mock ? "border-line bg-raised" : "border-warning/40 bg-warning-soft"}`}>
          <p className="flex items-start gap-2 text-m font-semibold text-text"><span className={mock ? "text-text-2" : "text-warning"}><WarningIcon /></span><span className="min-w-0">{enableWarning(mock)}</span></p>
          {kis ? (
            <>
              <p className="text-m text-text-2">이 계좌로 잔고 조회가 됐습니다</p>
              <label className="flex items-center gap-2 text-m">
                <span className="text-text-2">계좌번호 끝 2자리 입력</span>
                <input className="ui-field w-16 text-center font-mono" type="text" inputMode="numeric" name="kis-confirm-tail" aria-label="계좌번호 끝 2자리 입력" autoComplete="off" maxLength={2} disabled={command.busy} value={typedTail} onChange={(e) => setTypedTail(digitsOnly(e.target.value))} />
              </label>
            </>
          ) : (
            <>
              <p className="text-m text-text-2">키움이 알려 준 계좌번호(8자리) 끝 2자리: <span className="font-mono text-text">{checkedTail}</span></p>
              <label className="flex min-h-8 items-center gap-2 text-m">
                <input type="checkbox" className="size-4 accent-accent" checked={accountConfirmed} onChange={(e) => setAccountConfirmed(e.target.checked)} />
                이 계좌가 맞습니다
              </label>
            </>
          )}
          <FormActions>
            <button type="button" className="btn" disabled={command.busy} onClick={closeConfirmation}>취소</button>
            <button type="button" className={mock ? "btn" : "btn-danger"} disabled={!canConfirmEnable(entry.broker, accountConfirmed, typedTail) || command.busy} onClick={() => void apply(true)}>{mock ? "주문 켜기" : "실전 주문 켜기"}</button>
          </FormActions>
        </div>
      )}
      {command.error && <p role="alert" className="text-m text-danger" data-testid="key-orders-error">{command.error}</p>}
    </section>
  );
}

