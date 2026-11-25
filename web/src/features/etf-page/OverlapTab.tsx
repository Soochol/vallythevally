import { useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { etfFundQuery } from "../../api/etf";
import type { EtfFundDetail } from "../../api/generated/EtfFundDetail";
import type { EtfFundSummary } from "../../api/generated/EtfFundSummary";
import { useSendSymbol } from "../pages/sendSymbol";
import { Segmented, type SegmentedOption } from "../ui/Segmented";
import { Failure, Loading, Notice } from "./EtfStates";
import { HelpTip } from "./HelpTip";
import {
  BASKET_LIMIT,
  type WeightedHolding,
  commonHoldings,
  formatPercent,
  overlapBps,
  uniqueHoldings,
} from "./etfModel";

const MAX_HEAT_PERCENT = 38;
const FULL_BPS = 10_000;

interface Pair {
  rowCode: string;
  columnCode: string;
}

type CompareView = "three" | "butterfly";

const VIEW_OPTIONS: readonly SegmentedOption<CompareView>[] = [
  { value: "three", label: "3-칼럼 알파 뷰" },
  { value: "butterfly", label: "공통 나비만" },
];

interface OverlapTabProps {
  basket: readonly string[];
  funds: readonly EtfFundSummary[];
  onRemove: (code: string) => void;
  onOpenReverse: (stockCode: string) => void;
}

function UniqueBetColumn({
  fundName,
  items,
  tone,
  onPick,
  onOpenReverse,
}: {
  fundName: string;
  items: readonly WeightedHolding[];
  tone: "a" | "b";
  onPick: (item: WeightedHolding) => void;
  onOpenReverse: (stockCode: string) => void;
}) {
  return (
    <section className="etf-card etf-alpha-side" data-side={tone} aria-label={`${fundName} 고유 베팅`}>
      <h3>
        {fundName} 고유 베팅 · {items.length}종목
      </h3>
      {items.length === 0 ? (
        <p className="etf-alpha-empty">고유 종목이 없습니다</p>
      ) : (
        <ul className="etf-unique-list">
          {items.map((item) => (
            <li key={item.code} className="etf-unique-item" data-code={item.code}>
              <button
                type="button"
                className="etf-unique-pick"
                aria-label={`${item.name} 연동 차트로 보내기`}
                onClick={() => onPick(item)}
              >
                <span className="etf-unique-name">{item.name}</span>
                <span className="etf-num etf-unique-weight">{formatPercent(item.weightBps)}</span>
              </button>
              <button
                type="button"
                className="etf-mini-btn"
                aria-label={`${item.name} 역추적`}
                onClick={() => onOpenReverse(item.code)}
              >
                역추적
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ButterflyCard({
  a,
  b,
  overlap,
  wide,
}: {
  a: EtfFundDetail;
  b: EtfFundDetail;
  overlap: number;
  wide: boolean;
}) {
  const send = useSendSymbol();
  const common = commonHoldings(a.holdings, b.holdings);
  const scale = Math.max(1, ...common.flatMap((holding) => [holding.weightABps, holding.weightBBps]));
  return (
    <section
      className={wide ? "etf-card etf-card-wide" : "etf-card etf-alpha-center"}
      aria-label="공통 종목 나비 막대"
    >
      <h3>
        {a.fund.name} × {b.fund.name} · 겹침 {formatPercent(overlap)} · 공통 {common.length}종목
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
              <span
                className="etf-bar etf-bar-left"
                role="img"
                aria-label={`${a.fund.name} ${holding.name} ${formatPercent(holding.weightABps)}`}
              >
                <span className="etf-bar-value">{formatPercent(holding.weightABps)}</span>
                <i style={{ width: `${(holding.weightABps / scale) * 100}%` }} />
              </span>
              <button
                type="button"
                className="etf-row-name"
                aria-label={`${holding.name} 연동 차트로 보내기`}
                onClick={() => send({ code: holding.code, name: holding.name })}
              >
                {holding.name}
              </button>
              <span
                className="etf-bar etf-bar-right"
                role="img"
                aria-label={`${b.fund.name} ${holding.name} ${formatPercent(holding.weightBBps)}`}
              >
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

function PairComparison({
  a,
  b,
  onOpenReverse,
}: {
  a: EtfFundDetail;
  b: EtfFundDetail;
  onOpenReverse: (stockCode: string) => void;
}) {
  const [view, setView] = useState<CompareView>("three");
  const send = useSendSymbol();
  const overlap = overlapBps(a.holdings, b.holdings);
  const activeShare = Math.max(0, FULL_BPS - overlap);
  const overlapPct = Math.min(100, overlap / 100);
  const activePct = Math.max(0, 100 - overlapPct);
  const { onlyA, onlyB } = uniqueHoldings(a.holdings, b.holdings);

  return (
    <>
      <section className="etf-card etf-card-wide" aria-label="겹침 대비 차별화 요약">
        <div className="etf-card-head">
          <h3>
            {a.fund.name} × {b.fund.name}
          </h3>
          <Segmented
            label="비교 보기 방식"
            mode="pressed"
            size="sm"
            className="etf-acc-seg"
            options={VIEW_OPTIONS}
            value={view}
            onChange={(next) => setView(next)}
          />
        </div>
        <div className="etf-share-meta">
          <span>
            겹침 비중 <strong className="etf-num">{formatPercent(overlap)}</strong>
          </span>
          <span>
            차별화(Active Share) <strong className="etf-num">{formatPercent(activeShare)}</strong>
          </span>
        </div>
        <div className="etf-share-bar" aria-hidden="true">
          <i className="etf-share-overlap" style={{ width: `${overlapPct}%` }} />
          <i className="etf-share-active" style={{ width: `${activePct}%` }} />
        </div>
      </section>
      {view === "three" ? (
        <div className="etf-alpha-grid etf-card-wide">
          <UniqueBetColumn
            fundName={a.fund.name}
            items={onlyA}
            tone="a"
            onPick={(item) => send({ code: item.code, name: item.name })}
            onOpenReverse={onOpenReverse}
          />
          <ButterflyCard a={a} b={b} overlap={overlap} wide={false} />
          <UniqueBetColumn
            fundName={b.fund.name}
            items={onlyB}
            tone="b"
            onPick={(item) => send({ code: item.code, name: item.name })}
            onOpenReverse={onOpenReverse}
          />
        </div>
      ) : (
        <ButterflyCard a={a} b={b} overlap={overlap} wide={true} />
      )}
    </>
  );
}

export function OverlapTab({ basket, funds, onRemove, onOpenReverse }: OverlapTabProps) {
  const [pair, setPair] = useState<Pair | null>(null);
  const details = useQueries({ queries: basket.map((code) => etfFundQuery(code)) });
  const nameOf = (code: string) => funds.find((fund) => fund.code === code)?.name ?? code;

  if (basket.length < 2) {
    return (
      <Notice title="비교할 ETF를 2개 이상 담으세요">
        왼쪽 목록의 "비교"로 최대 {BASKET_LIMIT}개까지 담으면 겹침 행렬이 보입니다. 지금 {basket.length}개 담았습니다.
      </Notice>
    );
  }
  if (details.some((detail) => detail.isError)) {
    return (
      <>
        <Failure what="바구니 ETF의 구성" retry={() => details.forEach((detail) => void detail.refetch())} />
        <section className="etf-card etf-card-wide" aria-label="비교 바구니 관리">
          <ul className="etf-basket-chips">
            {basket.map((code, index) => (
              <li key={code} className="etf-basket-chip">
                <span className="etf-basket-dot" data-slot={index} aria-hidden="true" />
                <span className="etf-basket-chip-name">{nameOf(code)}</span>
                <button
                  type="button"
                  aria-label={`${nameOf(code)} 바구니에서 빼기`}
                  onClick={() => onRemove(code)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </section>
      </>
    );
  }
  if (details.some((detail) => !detail.data)) return <Loading label="구성을 불러오는 중입니다" />;

  const loaded = details.map((detail) => detail.data!);
  const rowFundActive = pair === null ? null : loaded.find((item) => item.fund.code === pair.rowCode) ?? null;
  const columnFundActive = pair === null ? null : loaded.find((item) => item.fund.code === pair.columnCode) ?? null;
  const active =
    rowFundActive !== null && columnFundActive !== null && rowFundActive.fund.code !== columnFundActive.fund.code
      ? { a: rowFundActive, b: columnFundActive }
      : null;
  return (
    <>
      <section className="etf-card etf-card-wide" aria-label="겹침 행렬 카드">
        <h3>
          겹침 비율
          <HelpTip
            label="겹침 비율 설명"
            text="두 ETF가 함께 담은 종목마다 더 작은 비중을 골라 모두 더한 값입니다. Σmin(비중 A, 비중 B)"
          />
        </h3>
        <table className="etf-matrix" aria-label="겹침 행렬">
          <thead>
            <tr>
              <td />
              {loaded.map((detail) => (
                <th key={detail.fund.code} scope="col">
                  {detail.fund.name}
                  <button
                    type="button"
                    className="etf-chip-remove"
                    aria-label={`${nameOf(detail.fund.code)} 바구니에서 빼기`}
                    onClick={() => onRemove(detail.fund.code)}
                  >
                    ×
                  </button>
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
                  const selected =
                    active !== null &&
                    ((active.a.fund.code === rowFund.fund.code && active.b.fund.code === columnFund.fund.code) ||
                      (active.a.fund.code === columnFund.fund.code && active.b.fund.code === rowFund.fund.code));
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
                        style={
                          {
                            "--heat": `${Math.min(MAX_HEAT_PERCENT, (bps / 100) * (MAX_HEAT_PERCENT / 100))}%`,
                          } as React.CSSProperties
                        }
                        disabled={row === column}
                        onClick={() => setPair({ rowCode: rowFund.fund.code, columnCode: columnFund.fund.code })}
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
      {active ? (
        <PairComparison a={active.a} b={active.b} onOpenReverse={onOpenReverse} />
      ) : (
        <Notice title="행렬의 칸을 누르세요">두 ETF의 공통 종목과 고유 베팅이 보입니다</Notice>
      )}
    </>
  );
}
