import { useState } from "react";
import { useEtfAccumulation, useEtfStock } from "../../api/etf";
import type { EtfStockHolder } from "../../api/generated/EtfStockHolder";
import { useSymbolSearch } from "../../api/queries";
import { useSendSymbol } from "../pages/sendSymbol";
import { Badge } from "../ui/Badge";
import { Segmented, type SegmentedOption } from "../ui/Segmented";
import { Failure, Loading, Notice } from "./EtfStates";
import { MaMarks } from "./HoldingsTable";
import { type StyleFilter, formatPercent } from "./etfModel";

const SEARCH_RESULT_LIMIT = 8;
const QUICK_PICK_LIMIT = 6;

const STYLE_CHOICES: readonly SegmentedOption<StyleFilter>[] = [
  { value: "all", label: "전체" },
  { value: "active", label: "액티브" },
  { value: "passive", label: "패시브" },
];

interface ReverseTabProps {
  stock: string | null;
  basket: readonly string[];
  onStock: (code: string | null) => void;
  onOpenFund: (code: string) => void;
  onToggleBasket: (code: string) => void;
}

function Holders({
  code,
  basket,
  onOpenFund,
  onToggleBasket,
}: {
  code: string;
  basket: readonly string[];
  onOpenFund: (code: string) => void;
  onToggleBasket: (code: string) => void;
}) {
  const [styleFilter, setStyleFilter] = useState<StyleFilter>("all");
  const holders = useEtfStock(code);
  const send = useSendSymbol();
  if (holders.isPending) return <Loading label="담은 ETF를 불러오는 중입니다" />;
  if (holders.isError) return <Failure what="담은 ETF" retry={() => void holders.refetch()} />;
  const allRows: EtfStockHolder[] = holders.data.holders.toSorted((a, b) => b.weightBps - a.weightBps);
  const rows =
    styleFilter === "all" ? allRows : allRows.filter((row) => row.fund.style === styleFilter);
  const label = holders.data.name ?? holders.data.code;
  const heaviest = Math.max(1, ...allRows.map((row) => row.weightBps));
  const activeCount = allRows.filter((row) => row.fund.style === "active").length;
  const passiveCount = allRows.length - activeCount;
  const activePct = allRows.length === 0 ? 0 : Math.round((activeCount / allRows.length) * 100);
  const topHolder = allRows[0] ?? null;

  return (
    <>
      <dl className="etf-reverse-kpis etf-card-wide" aria-label="종목 요약">
        <div className="etf-summary-cell">
          <dt>선택 종목</dt>
          <dd className="etf-reverse-stock-head">
            <span>{label}</span>
            <span className="etf-ma-cell">
              <MaMarks ma={holders.data.ma} />
            </span>
          </dd>
          <dd className="etf-summary-sub">
            <button
              type="button"
              className="btn btn-sm"
              aria-label={`${label} 연동 차트로 보내기`}
              onClick={() => send({ code: holders.data.code, name: holders.data.name ?? undefined })}
            >
              차트로 보내기
            </button>
          </dd>
        </div>
        <div className="etf-summary-cell">
          <dt>편입 ETF</dt>
          <dd>{allRows.length}개</dd>
        </div>
        <div className="etf-summary-cell">
          <dt>액티브 / 패시브</dt>
          <dd>
            {activeCount} / {passiveCount}
          </dd>
          <dd className="etf-summary-sub">
            <span className="etf-summary-bar" aria-hidden="true">
              <i style={{ width: `${activePct}%` }} />
            </span>
          </dd>
        </div>
        <div className="etf-summary-cell">
          <dt>최고 비중 ETF</dt>
          <dd className="etf-reverse-top-name">{topHolder ? topHolder.fund.name : "-"}</dd>
          {topHolder && <dd className="etf-summary-sub">{formatPercent(topHolder.weightBps)}</dd>}
        </div>
      </dl>
      <section className="etf-card etf-card-wide" aria-label="담은 ETF">
        <div className="etf-card-head">
          <h3>
            {label}을 담은 ETF {rows.length}개
          </h3>
          {allRows.length > 0 && (
            <Segmented
              label="담은 ETF 유형"
              mode="pressed"
              size="sm"
              className="etf-acc-seg"
              options={STYLE_CHOICES}
              value={styleFilter}
              onChange={(next) => setStyleFilter(next)}
            />
          )}
        </div>
        {allRows.length === 0 ? (
          <Notice title="이 종목을 담은 ETF가 없습니다" wide={false} />
        ) : rows.length === 0 ? (
          <Notice title="선택한 유형의 ETF가 없습니다" wide={false} />
        ) : (
          <div className="etf-table-wrap" data-scroll="">
            <table className="etf-table" aria-label="담은 ETF 표">
              <thead>
                <tr>
                  <th scope="col">ETF</th>
                  <th scope="col">유형</th>
                  <th scope="col" className="etf-num">비중</th>
                  <th scope="col" className="etf-num">비교</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const picked = basket.includes(row.fund.code);
                  return (
                    <tr key={row.fund.code} data-code={row.fund.code} onClick={() => onOpenFund(row.fund.code)}>
                      <td>
                        <button type="button" className="etf-row-name" aria-label={`${row.fund.name} 구성 보기`}>
                          {row.fund.name}
                        </button>
                        <span className="etf-row-code">{row.fund.code}</span>
                      </td>
                      <td>
                        <Badge tone={row.fund.style === "active" ? "accent" : "neutral"}>
                          {row.fund.style === "active" ? "액티브" : "패시브"}
                        </Badge>
                      </td>
                      <td className="etf-num etf-weight-cell">
                        <span
                          className="etf-weight-bar"
                          style={{ "--weight": row.weightBps / heaviest } as React.CSSProperties}
                        />
                        <span className="etf-weight-value">{formatPercent(row.weightBps)}</span>
                      </td>
                      <td className="etf-num">
                        <button
                          type="button"
                          className="etf-compare"
                          aria-pressed={picked}
                          aria-label={`${row.fund.name} 비교 담기`}
                          onClick={(event) => {
                            event.stopPropagation();
                            onToggleBasket(row.fund.code);
                          }}
                        >
                          {picked ? "담김" : "+비교"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

export function ReverseTab({ stock, basket, onStock, onOpenFund, onToggleBasket }: ReverseTabProps) {
  const [query, setQuery] = useState("");
  const search = useSymbolSearch(query.trim());
  const acc = useEtfAccumulation(5, "all");
  const quickPicks = (acc.data?.rows ?? []).slice(0, QUICK_PICK_LIMIT);
  const results = (query.trim() === "" ? [] : search.data?.rows ?? [])
    .filter((row) => row.kind !== "etf" && row.kind !== "index")
    .slice(0, SEARCH_RESULT_LIMIT);

  return (
    <>
      <section className="etf-card etf-card-wide" aria-label="종목 찾기">
        <input
          type="search"
          className="ui-field etf-search"
          aria-label="종목 이름·코드 검색"
          placeholder="종목 이름·코드로 찾기"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {quickPicks.length > 0 && (
          <div className="etf-quick-picks" role="group" aria-label="최근 매집 인기 종목">
            <span className="etf-quick-label">최근 매집</span>
            {quickPicks.map((row) => (
              <button
                key={row.code}
                type="button"
                className="etf-quick-btn"
                data-code={row.code}
                aria-pressed={row.code === stock}
                onClick={() => onStock(row.code)}
              >
                {row.name}
              </button>
            ))}
          </div>
        )}
        {results.length > 0 && (
          <ul className="etf-stock-results" aria-label="종목 검색 결과">
            {results.map((row) => (
              <li key={row.code}>
                <button
                  type="button"
                  data-code={row.code}
                  aria-pressed={row.code === stock}
                  onClick={() => onStock(row.code)}
                >
                  <span>{row.name}</span>
                  <span className="etf-row-code">{row.code}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {stock === null ? (
        <Notice title="종목을 찾아 고르세요">고르면 그 종목을 담은 ETF가 보입니다</Notice>
      ) : (
        <Holders key={stock} code={stock} basket={basket} onOpenFund={onOpenFund} onToggleBasket={onToggleBasket} />
      )}
    </>
  );
}
