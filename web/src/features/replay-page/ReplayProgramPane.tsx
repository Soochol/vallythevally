import { useEffect, useMemo, useState } from "react";
import { formatPrice, MINUS } from "../../lib/format";
import { priceTone } from "../market-window/PriceLadder";
import { formatQuantity, withSign } from "../market-window/format";
import { eokFromMillionWon, formatEokAmount, sparklinePoints } from "../program/program";
import type { EngineProgramRow, ReplayEngine, ReplayEngineFrame } from "./replayEngine";

interface Props {
  readonly engine: ReplayEngine;
  readonly previousClose: number | null;
  readonly isArchive?: boolean;
  readonly onJumpMs: (ms: number) => void;
}

interface ProgramViewSnapshot {
  readonly buyQty: number | null;
  readonly sellQty: number | null;
  readonly netQty: number | null;
  readonly netAmtMillion: number | null;
  readonly rows: readonly EngineProgramRow[];
  readonly trend: readonly number[];
}

const SPARK_WIDTH = 100;
const SPARK_HEIGHT = 16;
const TOP_SHARE = 0.1;
const quantityFormat = new Intl.NumberFormat("ko-KR");
const TONE_CLASS = { up: "mw-up", down: "mw-down", flat: undefined } as const;

function boldProgramKeys(rows: readonly EngineProgramRow[]): ReadonlySet<string> {
  const magnitudes = rows.map((row) => Math.abs(row.netQtyChange)).sort((a, b) => b - a);
  if (magnitudes.length === 0) return new Set();
  const cutoff = magnitudes[Math.ceil(magnitudes.length * TOP_SHARE) - 1]!;
  if (cutoff === 0) return new Set();
  return new Set(rows.filter((row) => Math.abs(row.netQtyChange) >= cutoff).map((row) => row.key));
}

function sameSnapshot(a: ProgramViewSnapshot, b: ProgramViewSnapshot): boolean {
  return (
    a.netQty === b.netQty
    && a.netAmtMillion === b.netAmtMillion
    && a.buyQty === b.buyQty
    && a.sellQty === b.sellQty
    && a.rows.length === b.rows.length
    && a.rows[0]?.key === b.rows[0]?.key
    && a.trend.length === b.trend.length
    && a.trend.at(-1) === b.trend.at(-1)
  );
}

function extractView(frame: ReplayEngineFrame): ProgramViewSnapshot {
  return {
    buyQty: frame.programBuyQty,
    sellQty: frame.programSellQty,
    netQty: frame.programNetQty,
    netAmtMillion: frame.programNetAmtMillion,
    rows: frame.recentProgramRows,
    trend: frame.programTrend,
  };
}

export function ReplayProgramPane({ engine, previousClose, isArchive = false, onJumpMs }: Props) {
  const [snap, setSnap] = useState<ProgramViewSnapshot>(() => extractView(engine.getFrame()));

  useEffect(() => {
    return engine.subscribeFrame((frame) => {
      const next = extractView(frame);
      setSnap((prev) => (sameSnapshot(prev, next) ? prev : next));
    });
  }, [engine]);

  const net = snap.netQty ?? 0;
  const amount = eokFromMillionWon(snap.netAmtMillion ?? 0);
  const direction = net > 0 ? "up" : net < 0 ? "down" : "flat";
  const points = useMemo(() => sparklinePoints(snap.trend, SPARK_WIDTH, SPARK_HEIGHT), [snap.trend]);
  const bold = useMemo(() => boldProgramKeys(snap.rows), [snap.rows]);
  const hasTotals = snap.buyQty !== null && snap.sellQty !== null;

  return (
    <section className="rp-col" aria-label="프로그램 체결창" data-testid="replay-program-pane">
      <div className="mw-frame pg" data-testid="replay-program">
        <div
          className="mw-head pg-head"
          data-direction={direction}
          title={hasTotals ? `매수 ${formatQuantity(snap.buyQty!)}주 · 매도 ${formatQuantity(snap.sellQty!)}주` : undefined}
        >
          <span className="mw-head-name">프로그램</span>
          <span className="mw-head-div" aria-hidden="true" />
          <span className="pg-net">
            <span className="pg-cap">순매수</span>
            <b data-testid="replay-program-net-qty">{snap.netQty === null ? "—" : withSign(net, formatQuantity(Math.abs(net)))}</b>
            <span className="pg-unit">주</span>
            {snap.netAmtMillion !== null && (
              <span className="pg-amount" data-testid="replay-program-net-amount">
                {withSign(amount, formatEokAmount(Math.abs(amount)))}
              </span>
            )}
          </span>
          {hasTotals && (
            <span className="pg-totals">
              <span>
                매수 <b>{formatQuantity(snap.buyQty!)}</b> · 매도 <b>{formatQuantity(snap.sellQty!)}</b>
              </span>
            </span>
          )}
          <svg
            className="pg-spark"
            viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label="순매수 누적 추이"
            data-testid="replay-program-trend"
          >
            {points && <polyline points={points} fill="none" vectorEffect="non-scaling-stroke" />}
          </svg>
        </div>

        <div className="pg-table rp-mono" role="table" aria-label="프로그램 체결">
          <div className="pg-tr pg-th" role="row">
            <span role="columnheader">시각</span>
            <span role="columnheader" className="pg-num">현재가</span>
            <span role="columnheader" className="pg-num">순매수 증감</span>
          </div>
          <div className="pg-body">
            {snap.rows.length === 0 ? (
              <p className="tr-empty">
                {isArchive
                  ? "KRX 아카이브에는 프로그램 매매 데이터가 없습니다"
                  : snap.netQty === null
                    ? "프로그램 매매 자료가 없습니다"
                    : "이 시점까지 프로그램 체결 변동이 없습니다"}
              </p>
            ) : (
              <div className="pg-rows">
                {snap.rows.map((row) => {
                  const changeText = withSign(row.netQtyChange, quantityFormat.format(Math.abs(row.netQtyChange))).replace("-", MINUS);
                  return (
                    <button
                      key={row.key}
                      type="button"
                      className="pg-tr rp-pg-btn"
                      role="row"
                      data-testid="replay-program-row"
                      data-bold={bold.has(row.key) ? "" : undefined}
                      onClick={() => onJumpMs(row.recvMs)}
                    >
                      <span role="cell" className="pg-time">{row.time}</span>
                      <span
                        role="cell"
                        className={`pg-price pg-num ${row.price === null ? "" : (TONE_CLASS[priceTone(row.price, previousClose)] ?? "")}`}
                      >
                        {row.price === null ? "–" : formatPrice(row.price, false)}
                      </span>
                      <span role="cell" className="pg-change pg-num">
                        <em className={row.netQtyChange > 0 ? "mw-up" : row.netQtyChange < 0 ? "mw-down" : undefined}>
                          {changeText}
                        </em>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
