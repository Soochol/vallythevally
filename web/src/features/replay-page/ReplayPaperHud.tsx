import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatPercent, formatPrice } from "../../lib/format";
import type { BuyRatioPercent } from "../order/orderRules";
import type { ReplayEngine, ReplayEngineFrame } from "./replayEngine";
import { formatSignedQty } from "./replayModel";
import {
  DEFAULT_PAPER_INITIAL_CASH,
  PAPER_CASH_PRESETS_MAN,
  type PaperMarketContext,
  type PaperSummary,
  type ReplayPaperEngine,
  resolvePaperBuyQuantity,
} from "./replayPaperEngine";

const MAN_WON = 10_000;

interface Props {
  readonly engine: ReplayEngine;
  readonly paper: ReplayPaperEngine;
  readonly qtyNum: number;
  readonly buyRatioPercent: BuyRatioPercent | null;
  readonly onFillSellableQty: (sellableQty: number) => void;
  readonly onClearBuyRatio: () => void;
}

function setText(el: HTMLElement | null, value: string): void {
  if (el && el.textContent !== value) el.textContent = value;
}

function setAttr(el: HTMLElement | null, name: string, value: string | null): void {
  if (!el) return;
  if (value === null) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== value) {
    el.setAttribute(name, value);
  }
}

function marketContextOf(frame: ReplayEngineFrame): PaperMarketContext {
  let bestAsk: number | null = null;
  let bestBid: number | null = null;
  for (let i = 9; i >= 0; i--) {
    const p = frame.ladder.rows[i]?.price ?? null;
    if (p !== null) {
      bestAsk = p;
      break;
    }
  }
  for (let i = 10; i < 20; i++) {
    const p = frame.ladder.rows[i]?.price ?? null;
    if (p !== null) {
      bestBid = p;
      break;
    }
  }
  return {
    cursorMs: frame.cursorMs,
    bestAsk,
    bestBid,
    lastPrice: frame.price,
  };
}

function referencePriceOf(frame: ReplayEngineFrame): number | null {
  if (frame.price !== null && frame.price > 0) return frame.price;
  const ctx = marketContextOf(frame);
  return ctx.bestAsk ?? ctx.bestBid ?? null;
}

export function ReplayPaperHud({
  engine,
  paper,
  qtyNum,
  buyRatioPercent,
  onFillSellableQty,
  onClearBuyRatio,
}: Props) {
  const [cashInputMan, setCashInputMan] = useState(String(DEFAULT_PAPER_INITIAL_CASH / MAN_WON));
  const [accountOpen, setAccountOpen] = useState(false);
  const [paperTick, setPaperTick] = useState(0);
  const [refPrice, setRefPrice] = useState<number | null>(() => referencePriceOf(engine.getFrame()));

  const statusPillRef = useRef<HTMLSpanElement>(null);
  const netRef = useRef<HTMLSpanElement>(null);
  const qtyRef = useRef<HTMLElement>(null);
  const sellRemainRef = useRef<HTMLElement>(null);
  const avgRef = useRef<HTMLElement>(null);
  const realCellRef = useRef<HTMLDivElement>(null);
  const realRef = useRef<HTMLElement>(null);
  const availRef = useRef<HTMLElement>(null);
  const equityCellRef = useRef<HTMLSpanElement>(null);
  const equityRef = useRef<HTMLElement>(null);
  const feesRef = useRef<HTMLElement>(null);

  useEffect(() => {
    return paper.subscribe(() => setPaperTick((t) => t + 1));
  }, [paper]);

  const summary: PaperSummary = useMemo(
    () => paper.getSummary(refPrice),
    [paper, refPrice, paperTick],
  );

  const applyHudDom = useCallback(
    (markPrice: number | null) => {
      const s = paper.getSummary(markPrice);
      const uTone = s.unrealizedPnl > 0 ? "up" : s.unrealizedPnl < 0 ? "down" : null;
      setAttr(netRef.current, "data-tone", uTone);
      setText(netRef.current, `${formatSignedQty(s.unrealizedPnl)}원 (${formatPercent(s.unrealizedPct)})`);

      const eqTone = s.totalReturn > 0 ? "up" : s.totalReturn < 0 ? "down" : null;

      if (statusPillRef.current) {
        if (s.quantity > 0) {
          statusPillRef.current.hidden = false;
          setAttr(statusPillRef.current, "data-live", "true");
          setText(statusPillRef.current, `보유 ${formatPrice(s.quantity, false)}주`);
        } else if (s.openOrders.length > 0) {
          statusPillRef.current.hidden = false;
          setAttr(statusPillRef.current, "data-live", null);
          setText(statusPillRef.current, `미체결 ${s.openOrders.length}건`);
        } else {
          statusPillRef.current.hidden = true;
          setAttr(statusPillRef.current, "data-live", null);
        }
      }

      setText(qtyRef.current, `${formatPrice(s.quantity, false)}주`);
      setText(
        sellRemainRef.current,
        s.reservedSellQuantity > 0 ? `가능 ${formatPrice(s.sellableQuantity, false)}` : "",
      );
      setText(avgRef.current, s.quantity > 0 ? `${formatPrice(Math.round(s.avgPrice), false)}원` : "-");

      const rTone = s.realizedPnl > 0 ? "up" : s.realizedPnl < 0 ? "down" : null;
      setAttr(realCellRef.current, "data-tone", rTone);
      setText(realRef.current, `${formatSignedQty(s.realizedPnl)}원`);

      setText(availRef.current, `${formatPrice(s.availableCash, false)}원`);
      setAttr(equityCellRef.current, "data-tone", eqTone);
      setText(equityRef.current, `${formatPrice(Math.round(s.totalEquity), false)}원 (${formatPercent(s.totalReturnPct)})`);
      setText(feesRef.current, `${formatPrice(s.totalFees, false)}원`);
    },
    [paper],
  );

  useEffect(() => {
    const apply = (frame: ReplayEngineFrame) => {
      const mark = referencePriceOf(frame);
      setRefPrice((prev) => (prev === mark ? prev : mark));
      applyHudDom(mark);
    };
    const unsubFrame = engine.subscribeFrame(apply);
    const unsubPaper = paper.subscribe(() => apply(engine.getFrame()));
    return () => {
      unsubFrame();
      unsubPaper();
    };
  }, [engine, paper, applyHudDom]);

  const handleCashPreset = (man: number) => {
    setCashInputMan(String(man));
    onClearBuyRatio();
    paper.reset(man * MAN_WON, engine.getFrame().cursorMs);
  };

  const handleCashInputCommit = () => {
    const parsed = Math.floor(Number(cashInputMan.replace(/[^0-9]/g, "")));
    const clamped = Number.isFinite(parsed) && parsed >= 100
      ? Math.min(1_000_000, parsed)
      : DEFAULT_PAPER_INITIAL_CASH / MAN_WON;
    setCashInputMan(String(clamped));
    onClearBuyRatio();
    paper.reset(clamped * MAN_WON, engine.getFrame().cursorMs);
  };

  const handleMarketBuy = () => {
    const frame = engine.getFrame();
    if (frame.inGap) return;
    const ctx = marketContextOf(frame);
    const targetPrice = ctx.bestAsk ?? ctx.lastPrice;
    if (targetPrice === null || targetPrice <= 0) return;
    const orderQty = resolvePaperBuyQuantity(
      targetPrice,
      paper.getAvailableCash(),
      paper.isFeeEnabled(),
      buyRatioPercent,
      qtyNum,
    );
    if (orderQty <= 0) return;
    const placed = paper.placeOrder("buy", targetPrice, orderQty, ctx);
    if (placed && buyRatioPercent !== null) onClearBuyRatio();
  };

  const handleHalfSell = () => {
    const frame = engine.getFrame();
    if (frame.inGap) return;
    const sellable = paper.getSellableQuantity();
    if (sellable <= 0) return;
    const ctx = marketContextOf(frame);
    const targetPrice = ctx.bestBid ?? ctx.lastPrice;
    if (targetPrice === null || targetPrice <= 0) return;
    const halfQty = Math.max(1, Math.floor(sellable / 2));
    paper.placeOrder("sell", targetPrice, halfQty, ctx);
  };

  const handleFlatten = () => {
    paper.flattenPosition(marketContextOf(engine.getFrame()));
  };

  const handleReset = () => {
    onClearBuyRatio();
    paper.reset(undefined, engine.getFrame().cursorMs);
  };

  return (
    <section className="rp-hud" aria-label="모의 포지션 손익" data-testid="replay-sim-pnl">
      <div className="rp-hud-kicker">
        <span className="rp-hud-title">모의 포지션</span>
        <div className="rp-hud-kicker-right">
          <span ref={statusPillRef} className="rp-hud-status-pill rp-mono" hidden />
          <button
            type="button"
            className="rp-hud-link-btn"
            data-testid="replay-sim-account-toggle"
            aria-expanded={accountOpen}
            onClick={() => setAccountOpen((prev) => !prev)}
          >
            계좌 설정
          </button>
          <button
            type="button"
            className="rp-sim-mini-btn"
            data-danger=""
            data-testid="replay-sim-reset"
            onClick={handleReset}
          >
            초기화
          </button>
        </div>
      </div>

      <div className="rp-hud-net-row rp-mono">
        <span ref={netRef} className="rp-hud-net" data-testid="replay-sim-unreal">0원 (0.00%)</span>
      </div>

      <div className="rp-hud-facts rp-mono">
        <button
          type="button"
          className="rp-hud-fact-btn"
          data-testid="replay-sim-qty-btn"
          disabled={summary.sellableQuantity <= 0}
          title="클릭 시 매도 가능 전량을 수량칸에 채움"
          onClick={() => {
            if (summary.sellableQuantity > 0) onFillSellableQty(summary.sellableQuantity);
          }}
        >
          <small>
            <span>보유수량</span>
            <i ref={sellRemainRef} className="od-remaining" />
          </small>
          <b ref={qtyRef} data-testid="replay-sim-qty">0주</b>
        </button>
        <div className="rp-hud-fact">
          <small>매입평단가</small>
          <b ref={avgRef} data-testid="replay-sim-avg">-</b>
        </div>
        <div ref={realCellRef} className="rp-hud-fact">
          <small>실현손익</small>
          <b ref={realRef} data-testid="replay-sim-real">0원</b>
        </div>
      </div>

      <div className="rp-hud-meta rp-mono">
        <span>
          주문가능 <b ref={availRef} data-testid="replay-sim-avail">{`${formatPrice(summary.availableCash, false)}원`}</b>
        </span>
        <span ref={equityCellRef}>
          총 자산 <b ref={equityRef} data-testid="replay-sim-equity">{`${formatPrice(Math.round(summary.totalEquity), false)}원 (0.00%)`}</b>
        </span>
      </div>

      <div className="rp-hud-actions">
        <button
          type="button"
          className="rp-hud-btn rp-hud-btn-buy"
          data-testid="replay-sim-market-buy"
          title="현재 매도 1호가로 즉시 모의 매수"
          onClick={handleMarketBuy}
        >
          시장가 매수
        </button>
        <button
          type="button"
          className="rp-hud-btn rp-hud-btn-sell"
          data-testid="replay-sim-half-sell"
          disabled={summary.sellableQuantity <= 0}
          title="보유 가능 수량의 50%를 매수 1호가로 즉시 청산"
          onClick={handleHalfSell}
        >
          50% 익절
        </button>
        <button
          type="button"
          className="rp-hud-btn rp-hud-btn-flat"
          data-testid="replay-sim-flatten"
          disabled={summary.quantity <= 0}
          title="현재 매수 1호가로 보유 전량 즉시 청산"
          onClick={handleFlatten}
        >
          전량 청산
        </button>
      </div>

      {accountOpen && (
        <div className="rp-hud-account" data-testid="replay-sim-account">
          <div className="rp-hud-account-row">
            <div className="rp-sim-cap-group">
              <span className="rp-sim-cap-label">초기 예수금</span>
              <input
                className="rp-sim-cap-input rp-mono"
                data-testid="replay-sim-cash-input"
                inputMode="numeric"
                aria-label="초기 예수금(만원)"
                value={cashInputMan}
                onChange={(e) => setCashInputMan(e.target.value.replace(/[^0-9]/g, ""))}
                onBlur={handleCashInputCommit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCashInputCommit();
                }}
              />
              <span className="rp-muted">만원</span>
            </div>
            <button
              type="button"
              className="rp-sim-mini-btn"
              data-testid="replay-sim-fee-toggle"
              aria-pressed={summary.feeEnabled}
              title="수수료 0.015% + 매도 거래세 0.15% 반영 여부"
              onClick={() => paper.setFeeEnabled(!summary.feeEnabled)}
            >
              {summary.feeEnabled ? "수수료·세금 ON" : "수수료·세금 OFF"}
            </button>
          </div>
          <div className="rp-hud-account-row">
            <div className="rp-sim-cap-presets" role="group" aria-label="초기 예수금 프리셋">
              {PAPER_CASH_PRESETS_MAN.map((man) => (
                <button
                  key={man}
                  type="button"
                  className="rp-sim-mini-btn rp-mono"
                  aria-pressed={summary.initialCash === man * MAN_WON}
                  onClick={() => handleCashPreset(man)}
                >
                  {man >= 10_000 ? `${man / 10_000}억` : `${man / 1_000}천만`}
                </button>
              ))}
            </div>
            <span className="rp-muted rp-mono">
              누적 비용 <b ref={feesRef}>{`${formatPrice(summary.totalFees, false)}원`}</b>
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
