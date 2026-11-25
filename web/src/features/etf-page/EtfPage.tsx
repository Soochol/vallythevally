import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { etfAccumulationQuery, useEtfFunds } from "../../api/etf";
import type { EtfDataStatus } from "../../api/generated/EtfDataStatus";
import { ErrorState } from "../overlay/State";
import { PageFrame } from "../pages/PageFrame";
import { EtfDetail, tabOf } from "./EtfDetail";
import { EtfList } from "./EtfList";
import { Notice } from "./EtfStates";
import {
  BASKET_LIMIT,
  NO_FILTER,
  type FundFilter,
  type FundSort,
  type TabId,
  isGlobalTab,
  parseBasket,
} from "./etfModel";
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
  const rawTab = params.get("tab");
  const basket = parseBasket(params.get("basket"));
  const stock = params.get("stock");
  const pair = params.get("pair");
  const list = funds.data?.funds ?? null;
  const selected = list?.find((fund) => fund.code === code) ?? null;

  const defaultLanding = code === null && rawTab === null;
  const defaultAcc = useQuery({ ...etfAccumulationQuery(5, "active"), enabled: defaultLanding });
  const fallbackToFirstFund =
    defaultLanding &&
    defaultAcc.data !== undefined &&
    defaultAcc.data.collectedDays < 2 &&
    list !== null &&
    list.length > 0;

  const effectiveTab: TabId =
    rawTab !== null
      ? tabOf(rawTab)
      : code !== null
        ? "holdings"
        : fallbackToFirstFund
          ? "holdings"
          : "accumulation";
  const effectiveFund = selected ?? (fallbackToFirstFund ? list[0]! : null);

  const go = (next: {
    code?: string | null;
    tab?: TabId | null;
    basket?: readonly string[];
    stock?: string | null;
    pair?: string | null;
  }) => {
    const targetCode = next.code === undefined ? code : next.code;
    const targetTab = next.tab === undefined ? rawTab : next.tab;
    const targetBasket = next.basket ?? basket;
    const targetStock = next.stock === undefined ? stock : next.stock;
    const targetPair = next.pair === undefined ? (next.code === undefined ? pair : null) : next.pair;
    const query = new URLSearchParams();
    if (targetCode !== null) query.set("code", targetCode);
    if (targetTab !== null) query.set("tab", targetTab);
    if (targetBasket.length > 0) query.set("basket", targetBasket.join(","));
    if (targetStock !== null) query.set("stock", targetStock);
    if (targetPair !== null) query.set("pair", targetPair);
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

  const clearBasket = () => {
    setBasketNotice(null);
    go({ basket: [] });
  };

  const handleSelectFund = (next: string) => {
    go({ code: next, tab: effectiveTab === "history" ? "history" : "holdings" });
  };

  const handleTab = (next: TabId) => {
    if (!isGlobalTab(next) && selected === null && list !== null && list.length > 0) {
      go({ code: list[0]!.code, tab: next });
      return;
    }
    go({ tab: next });
  };

  const detailOpen = code !== null || rawTab !== null;
  const missingCode = code !== null && selected === null && !isGlobalTab(effectiveTab);
  const freshnessFund = effectiveFund ?? list?.[0] ?? null;

  return (
    <PageFrame
      title="ETF"
      fresh={{ failed: freshnessFund?.status.refreshFailed === true }}
      freshness={<Freshness status={freshnessFund?.status ?? null} />}
    >
      {funds.isError ? (
        <ErrorState message="ETF 목록을 불러오지 못했습니다" retry={() => void funds.refetch()} />
      ) : (
        <div className="etf-layout" data-view={detailOpen ? "detail" : "list"}>
          <EtfList
            funds={list}
            selected={effectiveFund?.code ?? code}
            filter={filter}
            sort={sort}
            onFilter={setFilter}
            onSort={setSort}
            onSelect={handleSelectFund}
            basket={basket}
            basketNotice={basketNotice}
            onToggleBasket={toggleBasket}
            onClearBasket={clearBasket}
            onShowOverlap={() => go({ tab: "overlap", code: null })}
          />
          <div className="etf-main">
            {list !== null && (
              <>
                <button type="button" className="btn etf-back" onClick={() => go({ code: null, tab: null })}>
                  목록
                </button>
                {missingCode ? (
                  <Notice title="찾을 수 없음" role="alert" wide={false}>
                    {code} 코드의 ETF가 목록에 없습니다. 왼쪽 목록에서 고르세요.
                  </Notice>
                ) : (
                  <EtfDetail
                    fund={effectiveFund}
                    funds={list}
                    tab={effectiveTab}
                    basket={basket}
                    basketNotice={basketNotice}
                    stock={stock}
                    pair={pair}
                    onPair={(next) => go({ pair: next })}
                    onTab={handleTab}
                    onToggleBasket={toggleBasket}
                    onStock={(next) => go({ stock: next })}
                    onOpenFund={(next) => go({ code: next, tab: "holdings" })}
                    onOpenReverse={(stockCode) => go({ tab: "reverse", stock: stockCode })}
                  />
                )}
              </>
            )}
          </div>
        </div>
      )}
    </PageFrame>
  );
}
