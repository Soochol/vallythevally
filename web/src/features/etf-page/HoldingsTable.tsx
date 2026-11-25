import { useState } from "react";
import type { EtfChangeRow } from "../../api/generated/EtfChangeRow";
import type { EtfHolding } from "../../api/generated/EtfHolding";
import type { EtfMaState } from "../../api/generated/EtfMaState";
import type { EtfMaStates } from "../../api/generated/EtfMaStates";
import { Badge } from "../ui/Badge";
import { Chip } from "../ui/Chip";
import { formatPercent, formatRealChange, maAlignedCount, type RankedHolding } from "./etfModel";

const MA_PERIODS = [20, 60, 120] as const;
const STATE_LABEL: Record<EtfMaState, string> = { above: "상회", equal: "일치", below: "하회" };
const STATE_GLYPH: Record<EtfMaState, string> = { above: "▲", equal: "–", below: "▼" };
const VISIBLE_ROWS = 20;

function MaMark({ period, state }: { period: (typeof MA_PERIODS)[number]; state: EtfMaState | null }) {
  if (state === null) return <span className="etf-ma-slot" data-state="none" />;
  return (
    <span
      className="etf-ma-slot etf-ma-dot"
      data-state={state}
      role="img"
      aria-label={`${period}일선 ${STATE_LABEL[state]}`}
      title={`${period}일선 ${STATE_LABEL[state]}`}
    >
      {STATE_GLYPH[state]}
    </span>
  );
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

function FlowBadge({ row }: { row: EtfChangeRow | undefined }) {
  if (row === undefined) return <span className="etf-muted">-</span>;
  if (row.kind === "added") return <Badge tone="accent">편입</Badge>;
  if (row.kind === "removed") return <Badge tone="warning">편출</Badge>;
  if (row.kind === "increased" && row.realChange !== null) {
    return <span className="etf-flow-up">{formatRealChange(row.realChange)}</span>;
  }
  if (row.kind === "decreased" && row.realChange !== null) {
    return <span className="etf-flow-down">{formatRealChange(row.realChange)}</span>;
  }
  return <span className="etf-muted">유지</span>;
}

interface HoldingsTableProps {
  ranked: readonly RankedHolding<EtfHolding>[];
  changesByCode?: ReadonlyMap<string, EtfChangeRow>;
  hoveredCode?: string | null;
  onHover?: (code: string | null) => void;
  onPick: (holding: EtfHolding) => void;
  onReverseStock?: (code: string) => void;
}

export function HoldingsTable({
  ranked,
  changesByCode,
  hoveredCode = null,
  onHover,
  onPick,
  onReverseStock,
}: HoldingsTableProps) {
  const [all, setAll] = useState(false);
  const [query, setQuery] = useState("");
  const [alignedOnly, setAlignedOnly] = useState(false);

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = ranked.filter(({ holding }) => {
    if (alignedOnly && maAlignedCount(holding.ma) !== 3) return false;
    if (normalizedQuery === "") return true;
    return holding.name.toLowerCase().includes(normalizedQuery) || holding.code.toLowerCase().includes(normalizedQuery);
  });
  const isFiltered = alignedOnly || normalizedQuery !== "";
  const shown = all || isFiltered ? filtered : filtered.slice(0, VISIBLE_ROWS);
  const heaviest = Math.max(1, ...ranked.map((item) => item.holding.weightBps));
  const showFlow = changesByCode !== undefined && changesByCode.size > 0;

  return (
    <div className="etf-table-wrap">
      <div className="etf-table-tools">
        <input
          type="search"
          className="ui-field etf-inline-search"
          aria-label="구성 종목 필터"
          placeholder="종목 이름·코드 필터"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Chip pressed={alignedOnly} onPressedChange={setAlignedOnly}>
          정배열 3▲만
        </Chip>
        <MaLegend />
      </div>
      <table className="etf-table" aria-label="구성 종목 표">
        <thead>
          <tr>
            <th scope="col" className="etf-num">순위</th>
            <th scope="col">종목</th>
            <th scope="col" className="etf-num">비중</th>
            <th scope="col" className="etf-num">누적 비중</th>
            {showFlow && <th scope="col" className="etf-num">최근 실질 증감</th>}
            <th scope="col" className="etf-ma-head">이평선 20·60·120</th>
          </tr>
        </thead>
        <tbody>
          {shown.length === 0 ? (
            <tr className="etf-empty-row">
              <td colSpan={showFlow ? 6 : 5}>조건에 맞는 종목이 없습니다</td>
            </tr>
          ) : (
            shown.map(({ holding, rank, cumulativeBps }) => (
              <tr
                key={holding.code}
                data-code={holding.code}
                data-highlighted={hoveredCode === holding.code ? "true" : undefined}
                onMouseEnter={() => onHover?.(holding.code)}
                onMouseLeave={() => onHover?.(null)}
                onFocus={() => onHover?.(holding.code)}
                onBlur={() => onHover?.(null)}
                onClick={() => onPick(holding)}
              >
                <td className="etf-num etf-rank">{rank}</td>
                <td>
                  <span className="etf-stock-cell">
                    <button type="button" className="etf-row-name" aria-label={`${holding.name} 연동 차트로 보내기`}>
                      {holding.name}
                    </button>
                    <span className="etf-row-code">{holding.code}</span>
                    {onReverseStock && (
                      <button
                        type="button"
                        className="etf-mini-btn"
                        aria-label={`${holding.name} 역추적`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onReverseStock(holding.code);
                        }}
                      >
                        역추적
                      </button>
                    )}
                  </span>
                </td>
                <td className="etf-num etf-weight-cell">
                  <span
                    className="etf-weight-bar"
                    style={{ "--weight": holding.weightBps / heaviest } as React.CSSProperties}
                  />
                  <span className="etf-weight-value">{formatPercent(holding.weightBps)}</span>
                </td>
                <td className="etf-num etf-cumulative">{formatPercent(cumulativeBps)}</td>
                {showFlow && (
                  <td className="etf-num">
                    <FlowBadge row={changesByCode.get(holding.code)} />
                  </td>
                )}
                <td className="etf-ma-cell">
                  <MaMarks ma={holding.ma} />
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      {!isFiltered && filtered.length > VISIBLE_ROWS && (
        <button type="button" className="btn etf-show-all" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? `상위 ${VISIBLE_ROWS}개만 보기` : `모두 보기 (${filtered.length}개)`}
        </button>
      )}
    </div>
  );
}
