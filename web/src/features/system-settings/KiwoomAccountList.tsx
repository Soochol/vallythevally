import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { KIWOOM_KEYS_QUERY_KEY, useKiwoomKeys, useOrdersStatus, useSystemSettings } from "../../api/system";
import { useKiwoomLinkStore } from "../../stores/kiwoomLink";
import { useServerTime } from "../status/useServerTime";
import { AddKeyPanel } from "./AddKeyPanel";
import { BROKERS, brokerOrder } from "./brokers";
import { MOCK_KEY_NOTICE } from "./KiwoomKeyForm";
import { KiwoomKeyRow } from "./KiwoomKeyRow";
import { brokerKeys, KEY_LIST_REFRESH_MS } from "./kiwoomKeys";

export function KiwoomAccountList({ onOpenIpHelp }: { onOpenIpHelp(): void }) {
  const queryClient = useQueryClient();
  const query = useKiwoomKeys(KEY_LIST_REFRESH_MS);
  const status = useKiwoomLinkStore((s) => s.status);
  const now = useServerTime();
  const [expanded, setExpanded] = useState<string | null>(null);
  const target = useSystemSettings().data?.kiwoomTarget;
  const orders = useOrdersStatus().data?.accounts;
  const list = query.data;
  const mock = status?.environment === "mock";

  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: KIWOOM_KEYS_QUERY_KEY });
  }, [status, queryClient]);

  if (!list) return <section aria-label="계좌 목록" className="rounded-m border border-line bg-surface p-4 text-m text-text-3">{query.isError ? "키 목록을 불러오지 못했습니다" : "키 목록을 불러오는 중입니다"}</section>;

  return (
    <section aria-label="계좌 목록" className="flex flex-col gap-3 rounded-m border border-line bg-surface p-4">
      <p className="text-s text-text-3">접속 대상: {target ? `${target.kind === "kiwoom" ? (mock ? "키움 모의투자" : "키움 REST") : "로컬 시험 서버"}${target.host ? ` · ${target.host}` : ""} (고정)` : "—"}</p>
      {list.keyFileProblem && <p role="alert" className="text-m text-danger">{list.keyFileProblem}</p>}
      {brokerOrder().map((broker) => {
        const keys = brokerKeys(list, broker);
        return (
          <div key={broker} className="flex flex-col">
            <div className="flex items-center gap-2 pb-1">
              <span className="rounded-s px-2 py-0.5 text-xs font-semibold" style={{ color: BROKERS[broker].chipColor, background: `color-mix(in srgb, ${BROKERS[broker].chipColor} 16%, transparent)` }}>{BROKERS[broker].name}</span>
              <span className="text-s text-text-3" aria-label={`${keys.length}개 / 상한 ${list.limit}개`}>{keys.length} / {list.limit}</span>
            </div>
            <ul className="flex flex-col">
              {keys.map((key) => (
                <KiwoomKeyRow key={key.keyId} entry={key} order={orders?.find((account) => account.keyId === key.keyId)} keys={list.keys} mock={mock} expanded={expanded === key.keyId} now={now} onToggle={() => setExpanded(expanded === key.keyId ? null : key.keyId)} onOpenIpHelp={onOpenIpHelp} />
              ))}
            </ul>
          </div>
        );
      })}
      {mock ? <p className="text-m text-text" data-testid="mock-key-notice">{MOCK_KEY_NOTICE}</p> : <AddKeyPanel list={list} now={now} onOpenIpHelp={onOpenIpHelp} />}
    </section>
  );
}
