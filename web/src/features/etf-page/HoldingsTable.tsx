import { useState } from "react";
import type { EtfHolding } from "../../api/generated/EtfHolding";
import type { EtfMaState } from "../../api/generated/EtfMaState";
import type { EtfMaStates } from "../../api/generated/EtfMaStates";
import { formatPercent, type RankedHolding } from "./etfModel";

const MA_PERIODS = [20, 60, 120] as const;
const STATE_LABEL: Record<EtfMaState, string> = { above: "상회", equal: "일치", below: "하회" };
const STATE_GLYPH: Record<EtfMaState, string> = { above: "▲", equal: "–", below: "▼" };
const VISIBLE_ROWS = 20;

function MaMark({ period, state }: { period: (typeof MA_PERIODS)[number]; state: EtfMaState | null }) {
  if (state === null) return <span className="etf-ma-slot" data-state="none" />;
  return <span className="etf-ma-slot etf-ma-dot" data-state={state} role="img" aria-label={`${period}일선 ${STATE_LABEL[state]}`} title={`${period}일선 ${STATE_LABEL[state]}`}>{STATE_GLYPH[state]}</span>;
}

export function MaLegend() {
  return (
    <p className="etf-ma-legend">
      <span>이평선 20·60·120일선</span>
      <span data-state="above">▲ 위</span>
      <span data-state="below">▼ 아래</span>
      <span data-state="equal">– 같음</span>
    </p>
  );
}

export function MaMarks({ ma }: { ma: EtfMaStates }) {
  return (
    <>
      <MaMark period={20} state={ma.ma20} />
      <MaMark period={60} state={ma.ma60} />
      <MaMark period={120} state={ma.ma120} />
    </>
  );
}

interface HoldingsTableProps {
  ranked: readonly RankedHolding<EtfHolding>[];
  onPick: (holding: EtfHolding) => void;
}

export function HoldingsTable({ ranked, onPick }: HoldingsTableProps) {
  const [all, setAll] = useState(false);
  const shown = all ? ranked : ranked.slice(0, VISIBLE_ROWS);
  return (
    <div className="etf-table-wrap">
      <MaLegend />
      <table className="etf-table" aria-label="구성 종목 표">
        <thead>
          <tr>
            <th scope="col" className="etf-num">순위</th>
            <th scope="col">종목</th>
            <th scope="col" className="etf-num">비중</th>
            <th scope="col" className="etf-num">누적 비중</th>
            <th scope="col" className="etf-ma-head">이평선 20·60·120</th>
          </tr>
        </thead>
        <tbody>
          {shown.map(({ holding, rank, cumulativeBps }) => (
            <tr key={holding.code} data-code={holding.code} onClick={() => onPick(holding)}>
              <td className="etf-num etf-rank">{rank}</td>
              <td>
                <button type="button" className="etf-row-name" aria-label={`${holding.name} 연동 차트로 보내기`}>{holding.name}</button>
                <span className="etf-row-code">{holding.code}</span>
              </td>
              <td className="etf-num">{formatPercent(holding.weightBps)}</td>
              <td className="etf-num etf-cumulative">{formatPercent(cumulativeBps)}</td>
              <td className="etf-ma-cell">
                <MaMarks ma={holding.ma} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {ranked.length > VISIBLE_ROWS && (
        <button type="button" className="btn etf-show-all" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? `상위 ${VISIBLE_ROWS}개만 보기` : `모두 보기 (${ranked.length}개)`}
        </button>
      )}
    </div>
  );
}
