import { useEffect, useRef, useState } from "react";
import { direction, formatDecimal, formatPrice } from "../../lib/format";
import { formatQuantity } from "../market-window/format";
import { RatioBar, Segmented } from "../market-window/parts";
import { BIG_TRADE_WON, MIN_AMOUNT_OPTIONS, minAmountWon, type MinAmountKey } from "../trades/tape";
import "../trades/trades.css";
import type { ReplayEngine, ReplayEngineFrame } from "./replayEngine";
import { formatReplayClock, formatWonCompact } from "./replayModel";

interface Props {
  readonly engine: ReplayEngine;
  readonly previousClose: number | null;
  readonly tapeMinWon: number;
  readonly onTapeMinWon: (minWon: number) => void;
  readonly onJumpMs: (ms: number) => void;
}

const TAPE_SLOTS = Array.from({ length: 40 }, (_, i) => i);

interface TradeSlotRefs {
  row: HTMLButtonElement | null;
  time: HTMLSpanElement | null;
  price: HTMLSpanElement | null;
  qty: HTMLSpanElement | null;
}

function setText(el: HTMLElement | null, value: string): void {
  if (el && el.textContent !== value) el.textContent = value;
}

function minKeyOf(won: number): MinAmountKey {
  const matched = MIN_AMOUNT_OPTIONS.find((option) => option.won === won);
  return matched ? matched.value : "all";
}

export function ReplayTradesPane({
  engine,
  previousClose,
  tapeMinWon,
  onTapeMinWon,
  onJumpMs,
}: Props) {
  const [buySell, setBuySell] = useState<{ readonly buy: number; readonly sell: number }>({ buy: 0, sell: 0 });
  const strengthRef = useRef<HTMLElement>(null);
  const cumRef = useRef<HTMLElement>(null);
  const emptyRef = useRef<HTMLParagraphElement>(null);
  const jumpTargetsRef = useRef<number[]>(TAPE_SLOTS.map(() => 0));
  const slotRefs = useRef<TradeSlotRefs[]>(
    TAPE_SLOTS.map(() => ({ row: null, time: null, price: null, qty: null })),
  );

  useEffect(() => {
    const apply = (frame: ReplayEngineFrame) => {
      const perfNow = typeof performance !== "undefined" ? performance.now() : Date.now();
      const trades = frame.recentTrades;
      const withMs = frame.resolution === "tick";

      setText(strengthRef.current, `${formatDecimal(frame.strength)}%`);
      setText(cumRef.current, formatQuantity(frame.cumVol));

      let buy = 0;
      let sell = 0;
      for (const tr of trades) {
        if (tr.side === "buy") buy += tr.quantity;
        else if (tr.side === "sell") sell += tr.quantity;
      }
      setBuySell((prev) => (prev.buy === buy && prev.sell === sell ? prev : { buy, sell }));

      if (emptyRef.current) {
        emptyRef.current.hidden = trades.length > 0;
        if (trades.length === 0) {
          setText(
            emptyRef.current,
            tapeMinWon > 0
              ? `${formatWonCompact(tapeMinWon)} 이상의 체결이 아직 없습니다`
              : "이 시점까지 기록된 체결이 없습니다",
          );
        }
      }

      for (let i = 0; i < TAPE_SLOTS.length; i++) {
        const refs = slotRefs.current[i]!;
        const tr = trades[i];
        if (!refs.row) continue;
        if (!tr) {
          refs.row.hidden = true;
          refs.row.removeAttribute("data-testid");
          continue;
        }
        refs.row.hidden = false;
        refs.row.setAttribute("data-testid", "replay-tape-row");
        refs.row.setAttribute("data-side", tr.side);
        if (tr.value >= BIG_TRADE_WON) refs.row.setAttribute("data-big", "");
        else refs.row.removeAttribute("data-big");
        if (perfNow < tr.freshUntilMs) refs.row.setAttribute("data-fresh", "");
        else refs.row.removeAttribute("data-fresh");
        jumpTargetsRef.current[i] = tr.recvMs;

        setText(refs.time, formatReplayClock(tr.recvMs / 1000, withMs));
        if (refs.price) {
          const dir = previousClose !== null && previousClose > 0
            ? direction(tr.price - previousClose)
            : tr.side === "buy"
              ? "up"
              : tr.side === "sell"
                ? "down"
                : "flat";
          refs.price.setAttribute("data-dir", dir);
          setText(refs.price, formatPrice(tr.price, false));
        }
        setText(refs.qty, formatPrice(tr.quantity, false));
      }
    };

    return engine.subscribeFrame(apply);
  }, [engine, previousClose, tapeMinWon]);

  const minKey = minKeyOf(tapeMinWon);

  return (
    <section className="rp-col" aria-label="체결창" data-testid="replay-trades-pane">
      <div className="tr-window">
        <div className="mw-head tr-strips">
          <span className="mw-head-name">체결</span>
          <span className="mw-head-div" aria-hidden="true" />
          <div className="tr-strip-metrics">
            <span className="tr-figure" data-figure="strength" title="체결강도">
              <span className="tr-name">강도</span>
              <b ref={strengthRef} data-testid="replay-trade-strength">100.0%</b>
            </span>
            <RatioBar buy={buySell.buy} sell={buySell.sell} label="최근 체결의 매수·매도 비율" />
            <span className="tr-figure" data-figure="cumulative" title="누적">
              <span className="tr-name">누적</span>
              <b ref={cumRef} data-testid="replay-trade-cumulative">0</b>
            </span>
          </div>
          <div className="tr-strip-controls">
            <span className="tr-name tr-min-label">최소 금액</span>
            <Segmented<MinAmountKey>
              label="체결 금액 필터"
              options={MIN_AMOUNT_OPTIONS}
              value={minKey}
              onChange={(next) => onTapeMinWon(minAmountWon(next))}
            />
          </div>
        </div>

        <div className="tr-body">
          <div className="tr-tape rp-mono" data-testid="replay-tape" role="table" aria-label="체결 내역">
            <div role="row" className="tr-head">
              <span role="columnheader">시각</span>
              <span role="columnheader">체결가</span>
              <span role="columnheader">체결량</span>
            </div>
            <div className="tr-rows">
              {TAPE_SLOTS.map((idx) => (
                <button
                  key={idx}
                  ref={(el) => {
                    slotRefs.current[idx]!.row = el;
                  }}
                  type="button"
                  role="row"
                  className="tr-row rp-tr-btn"
                  hidden
                  onClick={() => onJumpMs(jumpTargetsRef.current[idx] ?? 0)}
                >
                  <span
                    ref={(el) => {
                      slotRefs.current[idx]!.time = el;
                    }}
                    role="cell"
                    className="tr-time"
                  />
                  <span
                    ref={(el) => {
                      slotRefs.current[idx]!.price = el;
                    }}
                    role="cell"
                    className="tr-price"
                  />
                  <span
                    ref={(el) => {
                      slotRefs.current[idx]!.qty = el;
                    }}
                    role="cell"
                    className="tr-qty"
                  />
                </button>
              ))}
            </div>
            <p ref={emptyRef} className="tr-empty">이 시점까지 기록된 체결이 없습니다</p>
          </div>
        </div>
      </div>
    </section>
  );
}
