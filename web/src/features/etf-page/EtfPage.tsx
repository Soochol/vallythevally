import { useState } from "react";
import { useSearchParams } from "react-router";
import { useEtfFunds } from "../../api/etf";
import type { EtfDataStatus } from "../../api/generated/EtfDataStatus";
import { ErrorState } from "../overlay/State";
import { PageFrame } from "../pages/PageFrame";
import { EtfDetail, tabOf } from "./EtfDetail";
import { EtfList } from "./EtfList";
import { Notice } from "./EtfStates";
import { BASKET_LIMIT, NO_FILTER, type FundFilter, type FundSort, parseBasket } from "./etfModel";
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
  const [sort, setSort] = useState<FundSort>("name");
  const [basketNotice, setBasketNotice] = useState<string | null>(null);
  const code = params.get("code");
  const tab = tabOf(params.get("tab"));
  const basket = parseBasket(params.get("basket"));
  const stock = params.get("stock");
  const pair = params.get("pair");
  const list = funds.data?.funds ?? null;
  const selected = list?.find((fund) => fund.code === code) ?? null;
  const go = (next: { code?: string | null; tab?: typeof tab; basket?: readonly string[]; stock?: string | null; pair?: string | null }) => {
    const target = {
      code: next.code === undefined ? code : next.code,
      tab: next.tab ?? tab,
      basket: next.basket ?? basket,
      stock: next.stock === undefined ? stock : next.stock,
      pair: next.pair === undefined ? (next.code === undefined ? pair : null) : next.pair,
    };
    const query = new URLSearchParams();
    if (target.code !== null) query.set("code", target.code);
    query.set("tab", target.tab);
    if (target.basket.length > 0) query.set("basket", target.basket.join(","));
    if (target.stock !== null) query.set("stock", target.stock);
    if (target.pair !== null) query.set("pair", target.pair);
    setParams(query);
  };
  const toggleBasket = (next: string) => {
    if (basket.includes(next)) {
      setBasketNotice(null);
      go({ basket: basket.filter((entry) => entry !== next) });
    } else if (basket.length >= BASKET_LIMIT) {
      setBasketNotice(`비교 바구니는 ${BASKET_LIMIT}개까지 담을 수 있습니다. 하나를 빼고 담으세요`);
    } else {
      setBasketNotice(null);
      go({ basket: [...basket, next] });
    }
  };
  const standalone = code === null && (tab === "overlap" || tab === "reverse" || tab === "accumulation");
  const detailOpen = code !== null || standalone;
  return (
    <PageFrame title="ETF" fresh={{ failed: (selected ?? list?.[0])?.status.refreshFailed === true }} freshness={<Freshness status={(selected ?? list?.[0])?.status ?? null} />}>
      {funds.isError ? (
        <ErrorState message="ETF 목록을 불러오지 못했습니다" retry={() => void funds.refetch()} />
      ) : (
        <div className="etf-layout" data-view={detailOpen ? "detail" : "list"}>
          <EtfList
            funds={list}
            selected={code}
            filter={filter}
            sort={sort}
            onFilter={setFilter}
            onSort={setSort}
            onSelect={(next) => go({ code: next })}
            basket={basket}
            basketNotice={basketNotice}
            onToggleBasket={toggleBasket}
            onShowOverlap={() => go({ tab: "overlap", code: null })}
            onShowAccumulation={() => go({ tab: "accumulation", code: null })}
          />
          <div className="etf-main">
            {list !== null && (
              <>
                <button type="button" className="btn etf-back" onClick={() => go({ code: null, tab: "holdings" })}>목록</button>
                {selected || standalone ? (
                  <EtfDetail
                    fund={selected}
                    funds={list}
                    tab={tab}
                    basket={basket}
                    stock={stock}
                    pair={pair}
                    onPair={(next) => go({ pair: next })}
                    onTab={(next) => go({ tab: next })}
                    onRemoveFromBasket={toggleBasket}
                    onStock={(next) => go({ stock: next })}
                    onOpenFund={(next) => go({ code: next, tab: "holdings" })}
                  />
                ) : code !== null ? (
                  <Notice title="찾을 수 없음" role="alert" wide={false}>{code} 코드의 ETF가 목록에 없습니다. 왼쪽 목록에서 고르세요.</Notice>
                ) : (
                  <Notice title="ETF를 고르세요" wide={false}>왼쪽 목록에서 ETF를 고르세요</Notice>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </PageFrame>
  );
}
