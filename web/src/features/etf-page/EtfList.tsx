import type { EtfFundSummary } from "../../api/generated/EtfFundSummary";
import { Select } from "../menu/Select";
import { EmptyState, Skeleton } from "../overlay/State";
import { Badge } from "../ui/Badge";
import { Field } from "../ui/Field";
import { Segmented, type SegmentedOption } from "../ui/Segmented";
import {
  BASKET_LIMIT,
  SORT_CHOICES,
  type FundFilter,
  type FundSort,
  filterFunds,
  flowDirectionOf,
  formatFlowWon,
  formatPercent,
  issuersOf,
  sortFunds,
} from "./etfModel";

const STYLE_CHOICES: readonly SegmentedOption<FundFilter["style"]>[] = [
  { value: "all", label: "전체" },
  { value: "active", label: "액티브" },
  { value: "passive", label: "패시브" },
];

const ALL_ISSUERS = "";

interface EtfListProps {
  funds: readonly EtfFundSummary[] | null;
  selected: string | null;
  filter: FundFilter;
  sort: FundSort;
  onFilter: (filter: FundFilter) => void;
  onSort: (sort: FundSort) => void;
  onSelect: (code: string) => void;
  basket: readonly string[];
  basketNotice: string | null;
  onToggleBasket: (code: string) => void;
  onClearBasket: () => void;
  onShowOverlap: () => void;
}

function CompareDock({
  funds,
  basket,
  basketNotice,
  onToggleBasket,
  onClearBasket,
  onShowOverlap,
}: Pick<EtfListProps, "basket" | "basketNotice" | "onToggleBasket" | "onClearBasket" | "onShowOverlap"> & {
  funds: readonly EtfFundSummary[];
}) {
  const nameOf = (code: string) => funds.find((fund) => fund.code === code)?.name ?? code;
  return (
    <div className="etf-basket">
      <div className="etf-basket-head">
        <div className="etf-basket-count" role="status">
          비교 바구니 {basket.length}/{BASKET_LIMIT}
        </div>
        {basket.length > 0 && (
          <button type="button" className="etf-basket-clear" onClick={onClearBasket}>
            비우기
          </button>
        )}
      </div>
      {basketNotice !== null && (
        <div className="etf-basket-notice" role="alert">
          {basketNotice}
        </div>
      )}
      {basket.length > 0 && (
        <ul className="etf-basket-chips" aria-label="비교 바구니">
          {basket.map((code, index) => (
            <li key={code} className="etf-basket-chip">
              <span className="etf-basket-dot" data-slot={index} aria-hidden="true" />
              <span className="etf-basket-chip-name">{nameOf(code)}</span>
              <button type="button" aria-label={`${nameOf(code)} 비교에서 빼기`} onClick={() => onToggleBasket(code)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="btn etf-overlap-link" disabled={basket.length < 2} onClick={onShowOverlap}>
        겹침 보기
      </button>
    </div>
  );
}

export function EtfList({
  funds,
  selected,
  filter,
  sort,
  onFilter,
  onSort,
  onSelect,
  basket,
  basketNotice,
  onToggleBasket,
  onClearBasket,
  onShowOverlap,
}: EtfListProps) {
  const shown = funds === null ? [] : sortFunds(filterFunds(funds, filter), sort);
  const issuerChoices = [
    { value: ALL_ISSUERS, label: "운용사 전체" },
    ...(funds === null ? [] : issuersOf(funds)).map((issuer) => ({ value: issuer, label: issuer })),
  ];
  return (
    <aside className="etf-rail" aria-label="ETF 목록">
      <div className="etf-rail-top">
        <Field
          type="search"
          label="검색"
          aria-label="ETF 이름·코드 검색"
          className="etf-search"
          placeholder="이름·코드 검색"
          value={filter.query}
          onChange={(event) => onFilter({ ...filter, query: event.target.value })}
        />
        <Segmented
          label="운용 방식"
          mode="pressed"
          size="sm"
          className="etf-seg"
          options={STYLE_CHOICES}
          value={filter.style}
          onChange={(style) => onFilter({ ...filter, style })}
        />
        <div className="etf-selects">
          <Select
            label="운용사"
            className="etf-select"
            value={filter.issuer ?? ALL_ISSUERS}
            options={issuerChoices}
            onChange={(value) => onFilter({ ...filter, issuer: value === ALL_ISSUERS ? null : value })}
          />
          <Select label="정렬" className="etf-select" value={sort} options={SORT_CHOICES} onChange={onSort} />
        </div>
      </div>
      {funds === null ? (
        <div className="etf-list-loading">
          <Skeleton label="ETF 목록을 불러오는 중입니다" rows={8} />
        </div>
      ) : (
        <ul className="etf-list" aria-label="ETF">
          {shown.map((fund) => {
            const picked = basket.includes(fund.code);
            const activity = fund.recentActivity;
            const buys = activity === null ? 0 : activity.added + activity.increased;
            const sells = activity === null ? 0 : activity.removed + activity.decreased;
            const hasActivity = buys > 0 || sells > 0;
            return (
              <li key={fund.code} className="etf-item">
                <button
                  type="button"
                  className="etf-fund"
                  data-code={fund.code}
                  aria-pressed={fund.code === selected}
                  onClick={() => onSelect(fund.code)}
                >
                  <span className="etf-fund-name">{fund.name}</span>
                  <span className="etf-fund-right">
                    {fund.netFlow5dWon !== null && (
                      <span
                        className="etf-fund-flow"
                        data-direction={flowDirectionOf(fund.netFlow5dWon)}
                        aria-label={`5일 순유입 ${formatFlowWon(fund.netFlow5dWon, true)}`}
                      >
                        {formatFlowWon(fund.netFlow5dWon, true)}
                      </span>
                    )}
                    <span className="etf-fund-code">{fund.code}</span>
                  </span>
                  <span className="etf-fund-meta">
                    <Badge tone={fund.style === "active" ? "accent" : "neutral"}>
                      {fund.style === "active" ? "액티브" : "패시브"}
                    </Badge>
                    <span className="etf-fund-issuer">{fund.issuer}</span>
                    {hasActivity && (
                      <span
                        className="etf-fund-activity"
                        aria-label={`최근 리밸런싱${buys > 0 ? ` 매수 ${buys}건` : ""}${sells > 0 ? ` 매도 ${sells}건` : ""}`}
                      >
                        {buys > 0 && <span className="etf-act-up">▲{buys}</span>}
                        {sells > 0 && <span className="etf-act-down">▼{sells}</span>}
                      </span>
                    )}
                    <span
                      className="etf-conc"
                      role="img"
                      aria-label={`상위 5 비중 ${formatPercent(fund.top5WeightBps)}`}
                      title={`상위 5 비중 ${formatPercent(fund.top5WeightBps)}`}
                    >
                      <i style={{ width: `${Math.min(100, fund.top5WeightBps / 100)}%` }} />
                    </span>
                    <span className="etf-conc-value">{formatPercent(fund.top5WeightBps)}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="etf-compare"
                  aria-pressed={picked}
                  aria-label={`${fund.name} 비교`}
                  data-basket-code={fund.code}
                  onClick={() => onToggleBasket(fund.code)}
                >
                  비교
                </button>
              </li>
            );
          })}
          {shown.length === 0 && (
            <li>
              <EmptyState title="조건에 맞는 ETF가 없습니다" />
            </li>
          )}
        </ul>
      )}
      <div className="etf-rail-foot" role="status">
        {funds === null ? "" : `${shown.length}개 / 전체 ${funds.length}개`}
      </div>
      {funds !== null && (
        <CompareDock
          funds={funds}
          basket={basket}
          basketNotice={basketNotice}
          onToggleBasket={onToggleBasket}
          onClearBasket={onClearBasket}
          onShowOverlap={onShowOverlap}
        />
      )}
    </aside>
  );
}
