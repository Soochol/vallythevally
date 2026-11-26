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
import type { OverlapPair } from "./OverlapTab";
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
  const [overlapPair, setOverlapPair] = useState<OverlapPair | null>(null);
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
      if (overlapPair !== null && (overlapPair.rowCode === next || overlapPair.columnCode === next)) {
        setOverlapPair(null);
      }
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
    setOverlapPair(null);
    go({ basket: [] });
  };

  const handleSelectFund = (next: string) => {
    setOverlapPair(null);
    const nextTab: TabId =
      effectiveTab === "flows"
        ? "shares"
        : effectiveTab === "history" || effectiveTab === "similar" || effectiveTab === "shares"
          ? effectiveTab
          : "holdings";
    go({ code: next, tab: nextTab });
  };

  const handleComparePair = (codeA: string, codeB: string) => {
    setBasketNotice(null);
    setOverlapPair({ rowCode: codeA, columnCode: codeB });
    go({ code: null, tab: "overlap", basket: [codeA, codeB] });
  };

  const handleTab = (next: TabId) => {
    if (next !== "overlap") setOverlapPair(null);
    if (!isGlobalTab(next) && selected === null && list !== null && list.length > 0) {
      if (next === "shares" && code !== null) {
        go({ code, tab: next });
        return;
      }
      go({ code: list[0]!.code, tab: next });
      return;
    }
    go({ tab: next });
  };

  const detailOpen = code !== null || rawTab !== null;
  const missingCode = code !== null && selected === null && !isGlobalTab(effectiveTab) && effectiveTab !== "shares";
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
            onShowOverlap={() => {
              setOverlapPair(null);
              go({ tab: "overlap", code: null });
            }}
          />
          <div className="etf-main">
            {list !== null && (
              <>
                <button
                  type="button"
                  className="btn etf-back"
                  onClick={() => {
                    setOverlapPair(null);
                    go({ code: null, tab: null });
                  }}
                >
                  목록
                </button>
                {missingCode ? (
                  <Notice title="찾을 수 없음" role="alert" wide={false}>
                    {code} 코드의 ETF가 목록에 없습니다. 왼쪽 목록에서 고르세요.
                  </Notice>
                ) : (
                  <EtfDetail
                    fund={effectiveFund}
                    requestedCode={code}
                    funds={list}
                    tab={effectiveTab}
                    basket={basket}
                    basketNotice={basketNotice}
                    stock={stock}
                    pair={pair}
                    overlapPair={overlapPair}
                    onPair={(next) => go({ pair: next })}
                    onTab={handleTab}
                    onToggleBasket={toggleBasket}
                    onStock={(next) => go({ stock: next })}
                    onOpenFund={(next) => {
                      setOverlapPair(null);
                      go({ code: next, tab: "holdings" });
                    }}
                    onOpenShares={(next) => {
                      setOverlapPair(null);
                      go({ code: next, tab: "shares" });
                    }}
                    onOpenReverse={(stockCode) => {
                      setOverlapPair(null);
                      go({ tab: "reverse", stock: stockCode });
                    }}
                    onComparePair={handleComparePair}
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
