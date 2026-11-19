import { useState } from "react";
import { useSearchParams } from "react-router";
import { useEtfFunds } from "../../api/etf";
import type { EtfDataStatus } from "../../api/generated/EtfDataStatus";
import { PageFrame } from "../pages/PageFrame";
import { EtfDetail, tabOf } from "./EtfDetail";
import { EtfList } from "./EtfList";
import { NO_FILTER, type FundFilter } from "./etfModel";
import "./etfPage.css";

const SOURCE_LABEL: Record<EtfDataStatus["source"], string> = { snapshot: "스냅샷", collected: "수집" };

function Freshness({ status }: { status: EtfDataStatus | null }) {
  if (status === null) return null;
  if (status.refreshFailed) return <span data-tone="failed">갱신 실패 · 마지막 성공 기준일 {status.holdingsAsOf}</span>;
  return <span>자료 출처 {SOURCE_LABEL[status.source]} · 기준일 {status.holdingsAsOf}</span>;
}

export function EtfPage() {
  const funds = useEtfFunds();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<FundFilter>(NO_FILTER);
  const code = params.get("code");
  const tab = tabOf(params.get("tab"));
  const list = funds.data?.funds ?? null;
  const selected = list?.find((fund) => fund.code === code) ?? null;
  const select = (next: string) => setParams({ code: next, tab });
  const pickTab = (next: typeof tab) => setParams(code === null ? { tab: next } : { code, tab: next });
  return (
    <PageFrame title="ETF" freshness={<Freshness status={(selected ?? list?.[0])?.status ?? null} />}>
      {funds.isPending && <div className="etf-empty" role="status">ETF 목록을 불러오는 중입니다</div>}
      {funds.isError && (
        <div className="etf-empty" role="alert">
          ETF 목록을 불러오지 못했습니다
          <button type="button" className="etf-retry" onClick={() => void funds.refetch()}>다시 시도</button>
        </div>
      )}
      {list && (
        <div className="etf-layout">
          <EtfList funds={list} selected={code} filter={filter} onFilter={setFilter} onSelect={select} />
          <div className="etf-main">
            {selected ? (
              <EtfDetail fund={selected} tab={tab} onTab={pickTab} />
            ) : code !== null ? (
              <div className="etf-empty" role="alert">
                <strong>찾을 수 없음</strong>
                <span>{code} 코드의 ETF가 목록에 없습니다. 왼쪽 목록에서 고르세요.</span>
              </div>
            ) : (
              <div className="etf-empty" role="status">왼쪽 목록에서 ETF를 고르세요</div>
            )}
          </div>
        </div>
      )}
    </PageFrame>
  );
}
