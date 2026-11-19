import { useState } from "react";
import { useEtfStock } from "../../api/etf";
import type { EtfStockHolder } from "../../api/generated/EtfStockHolder";
import { useSymbolSearch } from "../../api/queries";
import { useSendSymbol } from "../pages/sendSymbol";
import { formatPercent } from "./etfModel";

const SEARCH_RESULT_LIMIT = 8;

interface ReverseTabProps {
  stock: string | null;
  onStock: (code: string | null) => void;
  onOpenFund: (code: string) => void;
}

function Holders({ code, onOpenFund }: { code: string; onOpenFund: (code: string) => void }) {
  const holders = useEtfStock(code);
  const send = useSendSymbol();
  if (holders.isPending) return <div className="etf-empty" role="status">담은 ETF를 불러오는 중입니다</div>;
  if (holders.isError) {
    return (
      <div className="etf-empty" role="alert">
        담은 ETF를 불러오지 못했습니다
        <button type="button" className="etf-retry" onClick={() => void holders.refetch()}>다시 시도</button>
      </div>
    );
  }
  const rows: EtfStockHolder[] = holders.data.holders.toSorted((a, b) => b.weightBps - a.weightBps);
  const label = holders.data.name ?? holders.data.code;
  return (
    <section className="etf-card etf-card-wide" aria-label="담은 ETF">
      <h3>
        {label}을 담은 ETF {rows.length}개
        <button type="button" className="etf-row-name" aria-label={`${label} 연동 차트로 보내기`} onClick={() => send({ code: holders.data.code, name: holders.data.name ?? undefined })}>차트로 보내기</button>
      </h3>
      {rows.length === 0 ? (
        <div className="etf-empty" role="status">이 종목을 담은 ETF가 없습니다</div>
      ) : (
        <div className="etf-table-wrap">
          <table className="etf-table" aria-label="담은 ETF 표">
            <thead>
              <tr>
                <th scope="col">ETF</th>
                <th scope="col" className="etf-num">비중</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.fund.code} data-code={row.fund.code} onClick={() => onOpenFund(row.fund.code)}>
                  <td>
                    <button type="button" className="etf-row-name" aria-label={`${row.fund.name} 구성 보기`}>{row.fund.name}</button>
                    <span className="etf-row-code">{row.fund.code}</span>
                  </td>
                  <td className="etf-num">{formatPercent(row.weightBps)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function ReverseTab({ stock, onStock, onOpenFund }: ReverseTabProps) {
  const [query, setQuery] = useState("");
  const search = useSymbolSearch(query.trim());
  const results = (query.trim() === "" ? [] : search.data?.rows ?? []).filter((row) => row.kind !== "etf").slice(0, SEARCH_RESULT_LIMIT);
  return (
    <>
      <section className="etf-card etf-card-wide" aria-label="종목 찾기">
        <input type="search" className="etf-search" aria-label="종목 이름·코드 검색" placeholder="종목 이름·코드로 찾기" value={query} onChange={(event) => setQuery(event.target.value)} />
        {results.length > 0 && (
          <ul className="etf-stock-results" aria-label="종목 검색 결과">
            {results.map((row) => (
              <li key={row.code}>
                <button type="button" data-code={row.code} aria-pressed={row.code === stock} onClick={() => onStock(row.code)}>
                  <span>{row.name}</span>
                  <span className="etf-row-code">{row.code}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {stock === null ? <div className="etf-empty etf-card-wide" role="status">종목을 찾아 고르면 그 종목을 담은 ETF가 보입니다</div> : <Holders code={stock} onOpenFund={onOpenFund} />}
    </>
  );
}
