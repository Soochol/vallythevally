import { useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { etfFundQuery } from "../../api/etf";
import type { EtfFundDetail } from "../../api/generated/EtfFundDetail";
import type { EtfFundSummary } from "../../api/generated/EtfFundSummary";
import { useSendSymbol } from "../pages/sendSymbol";
import { Failure, Loading, Notice } from "./EtfStates";
import { HelpTip } from "./HelpTip";
import { BASKET_LIMIT, commonHoldings, formatPercent, overlapBps } from "./etfModel";

const MAX_HEAT_PERCENT = 38;

interface Pair {
  row: number;
  column: number;
}

interface OverlapTabProps {
  basket: readonly string[];
  funds: readonly EtfFundSummary[];
  onRemove: (code: string) => void;
}

function Butterfly({ a, b }: { a: EtfFundDetail; b: EtfFundDetail }) {
  const send = useSendSymbol();
  const common = commonHoldings(a.holdings, b.holdings);
  const scale = Math.max(1, ...common.flatMap((holding) => [holding.weightABps, holding.weightBBps]));
  return (
    <section className="etf-card etf-card-wide" aria-label="공통 종목 나비 막대">
      <h3>
        {a.fund.name} × {b.fund.name} · 겹침 {formatPercent(overlapBps(a.holdings, b.holdings))} · 공통 {common.length}종목
      </h3>
      {common.length === 0 ? (
        <Notice title="공통 종목이 없습니다" wide={false} />
      ) : (
        <ul className="etf-butterfly">
          <li className="etf-butterfly-head" aria-hidden="true">
            <span>{a.fund.name}</span>
            <span />
            <span>{b.fund.name}</span>
          </li>
          {common.map((holding) => (
            <li key={holding.code} className="etf-butterfly-row" data-code={holding.code}>
              <span className="etf-bar etf-bar-left" role="img" aria-label={`${a.fund.name} ${holding.name} ${formatPercent(holding.weightABps)}`}>
                <span className="etf-bar-value">{formatPercent(holding.weightABps)}</span>
                <i style={{ width: `${(holding.weightABps / scale) * 100}%` }} />
              </span>
              <button type="button" className="etf-row-name" aria-label={`${holding.name} 연동 차트로 보내기`} onClick={() => send({ code: holding.code, name: holding.name })}>
                {holding.name}
              </button>
              <span className="etf-bar etf-bar-right" role="img" aria-label={`${b.fund.name} ${holding.name} ${formatPercent(holding.weightBBps)}`}>
                <i style={{ width: `${(holding.weightBBps / scale) * 100}%` }} />
                <span className="etf-bar-value">{formatPercent(holding.weightBBps)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function OverlapTab({ basket, funds, onRemove }: OverlapTabProps) {
  const [pair, setPair] = useState<Pair | null>(null);
  const details = useQueries({ queries: basket.map((code) => etfFundQuery(code)) });
  const nameOf = (code: string) => funds.find((fund) => fund.code === code)?.name ?? code;

  if (basket.length < 2) {
    return <Notice title="비교할 ETF를 2개 이상 담으세요">왼쪽 목록의 "비교"로 최대 {BASKET_LIMIT}개까지 담으면 겹침 행렬이 보입니다. 지금 {basket.length}개 담았습니다.</Notice>;
  }
  if (details.some((detail) => detail.isError)) return <Failure what="바구니 ETF의 구성" retry={() => details.forEach((detail) => void detail.refetch())} />;
  if (details.some((detail) => !detail.data)) return <Loading label="구성을 불러오는 중입니다" />;

  const loaded = details.map((detail) => detail.data!);
  const active = pair !== null && pair.row < loaded.length && pair.column < loaded.length ? pair : null;
  return (
    <>
      <section className="etf-card etf-card-wide" aria-label="겹침 행렬 카드">
        <h3>겹침 비율<HelpTip label="겹침 비율 설명" text="두 ETF가 함께 담은 종목마다 더 작은 비중을 골라 모두 더한 값입니다. Σmin(비중 A, 비중 B)" /></h3>
        <table className="etf-matrix" aria-label="겹침 행렬">
          <thead>
            <tr>
              <td />
              {loaded.map((detail) => (
                <th key={detail.fund.code} scope="col">
                  {detail.fund.name}
                  <button type="button" className="etf-chip-remove" aria-label={`${nameOf(detail.fund.code)} 바구니에서 빼기`} onClick={() => onRemove(detail.fund.code)}>×</button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loaded.map((rowFund, row) => (
              <tr key={rowFund.fund.code}>
                <th scope="row">{rowFund.fund.name}</th>
                {loaded.map((columnFund, column) => {
                  const bps = overlapBps(rowFund.holdings, columnFund.holdings);
                  const selected = active !== null && ((active.row === row && active.column === column) || (active.row === column && active.column === row));
                  return (
                    <td key={columnFund.fund.code}>
                      <button
                        type="button"
                        className="etf-matrix-cell"
                        data-row={rowFund.fund.code}
                        data-column={columnFund.fund.code}
                        data-bps={bps}
                        aria-pressed={selected}
                        aria-label={`${rowFund.fund.name}와 ${columnFund.fund.name} 겹침 ${formatPercent(bps)}`}
                        style={{ "--heat": `${Math.min(MAX_HEAT_PERCENT, (bps / 100) * (MAX_HEAT_PERCENT / 100))}%` } as React.CSSProperties}
                        disabled={row === column}
                        onClick={() => setPair({ row, column })}
                      >
                        {row === column ? "—" : formatPercent(bps)}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {active ? <Butterfly a={loaded[active.row]!} b={loaded[active.column]!} /> : <Notice title="행렬의 칸을 누르세요">두 ETF의 공통 종목이 보입니다</Notice>}
    </>
  );
}
