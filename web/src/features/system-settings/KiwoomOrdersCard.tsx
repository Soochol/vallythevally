import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { OrdersStatus } from "../../api/generated/OrdersStatus";
import { checkOrdersAccount, ORDERS_QUERY_KEY, switchOrders, useOrdersStatus } from "../../api/system";
import { useCommand } from "./useCommand";

function statusLine(status: OrdersStatus): string {
  if (status.state === "off") return "주문 사용 꺼짐";
  if (status.state === "on") return `주문 사용 켜짐 · 계좌 끝 ${status.accountTail ?? "—"}`;
  return status.message;
}

export function KiwoomOrdersCard() {
  const queryClient = useQueryClient();
  const status = useOrdersStatus().data;
  const command = useCommand();
  const [checkedTail, setCheckedTail] = useState<string | null>(null);
  const [accountConfirmed, setAccountConfirmed] = useState(false);

  if (!status) return null;
  const closeConfirmation = () => {
    setCheckedTail(null);
    setAccountConfirmed(false);
  };
  const apply = async (enabled: boolean) => {
    const confirmAccountTail = enabled ? checkedTail : null;
    const saved = await command.run(async () => {
      queryClient.setQueryData(ORDERS_QUERY_KEY, await switchOrders({ enabled, confirmAccountTail }));
    });
    if (saved) closeConfirmation();
  };
  const startEnabling = () => void command.run(async () => setCheckedTail((await checkOrdersAccount()).accountTail));

  return (
    <section aria-label="주문 사용" className="flex flex-col gap-3 rounded-m border border-line bg-surface p-4">
      <h3 className="text-m font-semibold">주문</h3>
      <p className="text-m text-text">{statusLine(status)}</p>
      {checkedTail !== null && (
        <div className="flex flex-col gap-2">
          <p className="text-m text-text-2">키움이 알려 준 계좌 끝 2자리: <span className="font-mono text-text">{checkedTail}</span></p>
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
        <div className="flex gap-2">
          {(status.state === "off" || status.state === "account_changed") && <button type="button" className="tb-btn h-9 px-3" disabled={command.busy} onClick={startEnabling}>주문 사용 켜기</button>}
          {(status.state === "on" || status.state === "account_changed") && <button type="button" className="tb-btn h-9 px-3" disabled={command.busy} onClick={() => void apply(false)}>주문 사용 끄기</button>}
        </div>
      )}
      {command.error && <p role="alert" className="text-m text-danger">{command.error}</p>}
    </section>
  );
}
