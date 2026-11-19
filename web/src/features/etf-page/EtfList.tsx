import type { EtfFundSummary } from "../../api/generated/EtfFundSummary";
import { type FundFilter, type StyleFilter, filterFunds, formatPercent, issuersOf } from "./etfModel";

const STYLE_CHOICES: readonly { id: StyleFilter; label: string }[] = [
  { id: "all", label: "전체" },
  { id: "active", label: "액티브" },
  { id: "passive", label: "패시브" },
];

interface EtfListProps {
  funds: readonly EtfFundSummary[];
  selected: string | null;
  filter: FundFilter;
  onFilter: (filter: FundFilter) => void;
  onSelect: (code: string) => void;
}

export function EtfList({ funds, selected, filter, onFilter, onSelect }: EtfListProps) {
  const shown = filterFunds(funds, filter);
  return (
    <aside className="etf-rail" aria-label="ETF 목록">
      <div className="etf-rail-top">
        <input
          type="search"
          className="etf-search"
          aria-label="ETF 이름·코드 검색"
          placeholder="이름·코드 검색"
          value={filter.query}
          onChange={(event) => onFilter({ ...filter, query: event.target.value })}
        />
        <div className="etf-seg" role="group" aria-label="운용 방식">
          {STYLE_CHOICES.map((choice) => (
            <button key={choice.id} type="button" aria-pressed={filter.style === choice.id} onClick={() => onFilter({ ...filter, style: choice.id })}>
              {choice.label}
            </button>
          ))}
        </div>
        <select className="etf-issuer" aria-label="운용사" value={filter.issuer ?? ""} onChange={(event) => onFilter({ ...filter, issuer: event.target.value === "" ? null : event.target.value })}>
          <option value="">운용사 전체</option>
          {issuersOf(funds).map((issuer) => <option key={issuer} value={issuer}>{issuer}</option>)}
        </select>
      </div>
      <ul className="etf-list" aria-label="ETF">
        {shown.map((fund) => (
          <li key={fund.code}>
            <button type="button" className="etf-fund" data-code={fund.code} aria-pressed={fund.code === selected} onClick={() => onSelect(fund.code)}>
              <span className="etf-fund-name">{fund.name}</span>
              <span className="etf-fund-code">{fund.code}</span>
              <span className="etf-fund-meta">
                <span className="etf-badge" data-style={fund.style}>{fund.style === "active" ? "액티브" : "패시브"}</span>
                <span className="etf-fund-issuer">{fund.issuer}</span>
                <span className="etf-conc" role="img" aria-label={`상위 5 비중 ${formatPercent(fund.top5WeightBps)}`} title={`상위 5 비중 ${formatPercent(fund.top5WeightBps)}`}>
                  <i style={{ width: `${Math.min(100, fund.top5WeightBps / 100)}%` }} />
                </span>
              </span>
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="etf-empty">조건에 맞는 ETF가 없습니다</li>}
      </ul>
      <div className="etf-rail-foot" role="status">{shown.length}개 / 전체 {funds.length}개</div>
    </aside>
  );
}
