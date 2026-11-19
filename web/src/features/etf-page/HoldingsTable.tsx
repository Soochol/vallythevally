import type { EtfHolding } from "../../api/generated/EtfHolding";
import type { EtfMaState } from "../../api/generated/EtfMaState";
import { formatPercent } from "./etfModel";

const MA_PERIODS = [20, 60, 120] as const;
const STATE_LABEL: Record<EtfMaState, string> = { above: "상회", equal: "일치", below: "하회" };

function MaDot({ period, state }: { period: (typeof MA_PERIODS)[number]; state: EtfMaState | null }) {
  if (state === null) return <span className="etf-ma-slot" data-state="none" />;
  return <span className="etf-ma-slot etf-ma-dot" data-state={state} role="img" aria-label={`${period}일선 ${STATE_LABEL[state]}`} title={`${period}일선 ${STATE_LABEL[state]}`} />;
}

interface HoldingsTableProps {
  holdings: readonly EtfHolding[];
  onPick: (holding: EtfHolding) => void;
}

export function HoldingsTable({ holdings, onPick }: HoldingsTableProps) {
  return (
    <div className="etf-table-wrap">
      <table className="etf-table" aria-label="구성 종목 표">
        <thead>
          <tr>
            <th scope="col">종목</th>
            <th scope="col" className="etf-num">비중</th>
            <th scope="col" className="etf-ma-head">이평선 20·60·120</th>
          </tr>
        </thead>
        <tbody>
          {holdings.map((holding) => (
            <tr key={holding.code} data-code={holding.code} onClick={() => onPick(holding)}>
              <td>
                <button type="button" className="etf-row-name" aria-label={`${holding.name} 연동 차트로 보내기`}>{holding.name}</button>
                <span className="etf-row-code">{holding.code}</span>
              </td>
              <td className="etf-num">{formatPercent(holding.weightBps)}</td>
              <td className="etf-ma-cell">
                <MaDot period={20} state={holding.ma.ma20} />
                <MaDot period={60} state={holding.ma.ma60} />
                <MaDot period={120} state={holding.ma.ma120} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
