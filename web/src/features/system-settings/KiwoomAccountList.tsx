import { useQueryClient } from "@tanstack/react-query";
import { memo, useEffect, useState } from "react";
import { KIWOOM_KEYS_QUERY_KEY, useKiwoomKeys, useOrdersStatus, useSystemSettings } from "../../api/system";
import { useKiwoomLinkStore } from "../../stores/kiwoomLink";
import { ErrorState, Skeleton } from "../overlay/State";
import { Notice } from "../ui/Notice";
import { AddKeyPanel } from "./AddKeyPanel";
import { BROKERS } from "./brokers";
import { MOCK_KEY_NOTICE } from "./KiwoomKeyForm";
import { KiwoomKeyRow } from "./KiwoomKeyRow";
import { brokerKeys, brokersShown, KEY_LIST_REFRESH_MS } from "./kiwoomKeys";
import { useWaitingClock } from "./useWaitingClock";

export const KiwoomAccountList = memo(function KiwoomAccountList({ onOpenIpHelp }: { onOpenIpHelp(): void }) {
  const queryClient = useQueryClient();
  const query = useKiwoomKeys(KEY_LIST_REFRESH_MS);
  const status = useKiwoomLinkStore((s) => s.status);
  const [expanded, setExpanded] = useState<string | null>(null);
  const target = useSystemSettings().data?.kiwoomTarget;
  const orders = useOrdersStatus().data?.accounts;
  const list = query.data;
  const now = useWaitingClock(list?.keys.map((key) => key.link.retryAt) ?? []);
  const mock = status?.environment === "mock";

  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: KIWOOM_KEYS_QUERY_KEY });
  }, [status, queryClient]);

  if (!list) return (
    <section aria-label="계좌 목록" className="rounded-m border border-line bg-surface">
      {query.isError ? <ErrorState message="키 목록을 불러오지 못했습니다" retry={() => void query.refetch()} /> : <Skeleton label="키 목록을 불러오는 중입니다" />}
    </section>
  );

  return (
    <section aria-label="계좌 목록" className="flex flex-col gap-3 rounded-m border border-line bg-surface p-4">
      <p className="text-s text-text-2">접속 대상: {target ? `${target.kind === "kiwoom" ? (mock ? "키움 모의투자" : "키움 REST") : "로컬 시험 서버"}${target.host ? ` · ${target.host}` : ""} (고정)` : "—"}</p>
      {list.keyFileProblem && <Notice tone="danger">{list.keyFileProblem}</Notice>}
      {brokersShown(list).map((broker) => {
        const keys = brokerKeys(list, broker);
        return (
          <div key={broker} className="flex flex-col">
            <div className="flex items-baseline gap-2 pb-1">
              <h3 className="text-m font-semibold">{BROKERS[broker].name}</h3>
              <span className="text-s text-text-2" aria-label={`${keys.length}개 / 상한 ${list.limit}개`}>{keys.length} / {list.limit}</span>
            </div>
            <ul className="flex flex-col">
              {keys.map((key) => (
                <KiwoomKeyRow key={key.keyId} entry={key} order={orders?.find((account) => account.keyId === key.keyId)} keys={list.keys} mock={mock} expanded={expanded === key.keyId} now={now} onToggle={() => setExpanded(expanded === key.keyId ? null : key.keyId)} onOpenIpHelp={onOpenIpHelp} />
              ))}
            </ul>
          </div>
        );
      })}
      {mock ? <p className="text-m text-text" data-testid="mock-key-notice">{MOCK_KEY_NOTICE}</p> : <AddKeyPanel list={list} now={now} onOpenIpHelp={onOpenIpHelp} onOpenOrders={setExpanded} />}
    </section>
  );
});
