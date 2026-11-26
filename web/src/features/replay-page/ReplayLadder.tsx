import { useEffect, useRef } from "react";
import { formatPercent, formatPrice } from "../../lib/format";
import type { ReplayEngine, ReplayEngineFrame } from "./replayEngine";
import { type DeltaMode, formatSignedQty } from "./replayModel";

interface Props {
  readonly engine: ReplayEngine;
  readonly previousClose: number | null;
  readonly deltaMode: DeltaMode;
  readonly onDeltaMode: (mode: DeltaMode) => void;
}

const DAY_TAG_LABEL = {
  open: { short: "시", title: "시가" },
  high: { short: "고", title: "고가" },
  low: { short: "저", title: "저가" },
} as const;

const ROW_INDICES = Array.from({ length: 20 }, (_, i) => i);

interface RowRefs {
  row: HTMLDivElement | null;
  askCell: HTMLDivElement | null;
  askBar: HTMLElement | null;
  askDelta: HTMLSpanElement | null;
  askVal: HTMLSpanElement | null;
  pxCell: HTMLDivElement | null;
  pxTag: HTMLElement | null;
  pxNum: HTMLSpanElement | null;
  pxRate: HTMLSpanElement | null;
  bidCell: HTMLDivElement | null;
  bidBar: HTMLElement | null;
  bidVal: HTMLSpanElement | null;
  bidDelta: HTMLSpanElement | null;
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

export function ReplayLadder({ engine, previousClose, deltaMode, onDeltaMode }: Props) {
  const spreadRef = useRef<HTMLSpanElement>(null);
  const gapBannerRef = useRef<HTMLDivElement>(null);
  const viBannerRef = useRef<HTMLDivElement>(null);
  const totalAskRef = useRef<HTMLElement>(null);
  const totalBidRef = useRef<HTMLElement>(null);
  const totalAskDeltaRef = useRef<HTMLSpanElement>(null);
  const totalBidDeltaRef = useRef<HTMLSpanElement>(null);
  const ratioAskBarRef = useRef<HTMLSpanElement>(null);
  const ratioBidBarRef = useRef<HTMLSpanElement>(null);
  const ratioAskPctRef = useRef<HTMLSpanElement>(null);
  const ratioBidPctRef = useRef<HTMLSpanElement>(null);
  const obiRef = useRef<HTMLElement>(null);

  const rowRefs = useRef<RowRefs[]>(
    ROW_INDICES.map(() => ({
      row: null,
      askCell: null,
      askBar: null,
      askDelta: null,
      askVal: null,
      pxCell: null,
      pxTag: null,
      pxNum: null,
      pxRate: null,
      bidCell: null,
      bidBar: null,
      bidVal: null,
      bidDelta: null,
    })),
  );

  useEffect(() => {
    const apply = (frame: ReplayEngineFrame) => {
      const snapshot = frame.ladder;
      const spreadLabel = snapshot.inGap
        ? "—"
        : snapshot.singlePrice
          ? "단일가 호가"
          : snapshot.spreadTicks !== null && snapshot.spreadWon !== null
            ? `스프레드 ${snapshot.spreadTicks}틱 (${formatPrice(snapshot.spreadWon, false)}원)`
            : "—";
      setText(spreadRef.current, spreadLabel);

      if (gapBannerRef.current) gapBannerRef.current.hidden = !snapshot.inGap;
      if (viBannerRef.current) viBannerRef.current.hidden = snapshot.inGap || !snapshot.singlePrice;

      for (let i = 0; i < 20; i++) {
        const refs = rowRefs.current[i]!;
        const row = snapshot.rows[i]!;
        setAttr(refs.row, "data-side", row.side);
        setAttr(refs.row, "data-dim", row.dimmed ? "true" : null);
        setAttr(refs.row, "data-current", row.current ? "true" : null);
        setAttr(refs.row, "data-last-hit", row.lastHit);

        const priceTone = row.price === null || previousClose === null || previousClose <= 0
          ? ""
          : row.price > previousClose
            ? "rp-up"
            : row.price < previousClose
              ? "rp-down"
              : "";
        if (refs.pxCell) {
          const cls = priceTone ? `rp-px ${priceTone}` : "rp-px";
          if (refs.pxCell.className !== cls) refs.pxCell.className = cls;
        }
        const firstTag = row.tags[0];
        if (refs.pxTag) {
          if (firstTag) {
            refs.pxTag.hidden = false;
            setAttr(refs.pxTag, "data-kind", firstTag);
            setAttr(refs.pxTag, "title", DAY_TAG_LABEL[firstTag].title);
            setText(refs.pxTag, DAY_TAG_LABEL[firstTag].short);
          } else {
            refs.pxTag.hidden = true;
          }
        }
        setText(refs.pxNum, row.price !== null ? formatPrice(row.price, false) : "—");
        setText(refs.pxRate, row.rate !== null ? formatPercent(row.rate) : "");

        const deltaText = row.delta !== 0 ? formatSignedQty(row.delta) : "";
        const deltaSign = row.delta > 0 ? "pos" : row.delta < 0 ? "neg" : null;
        const flashKey = row.price !== null ? `${row.side}:${row.price}` : null;
        const flash = flashKey ? frame.cellFlashes.get(flashKey) : undefined;
        const flashAttr = flash ? (flash.dir > 0 ? "add" : "sub") : null;

        if (row.side === "ask") {
          setAttr(refs.askCell, "data-wall", row.wall ? "true" : null);
          setAttr(refs.askCell, "data-flash", flashAttr);
          if (refs.askBar) {
            const tr = `scaleX(${row.price !== null ? row.ratio.toFixed(3) : 0})`;
            if (refs.askBar.style.transform !== tr) refs.askBar.style.transform = tr;
          }
          setText(refs.askDelta, deltaText);
          setAttr(refs.askDelta, "data-sign", deltaSign);
          setText(refs.askVal, row.price !== null ? formatPrice(row.quantity, false) : "");

          setAttr(refs.bidCell, "data-wall", null);
          setAttr(refs.bidCell, "data-flash", null);
          if (refs.bidBar && refs.bidBar.style.transform !== "scaleX(0)") refs.bidBar.style.transform = "scaleX(0)";
          setText(refs.bidVal, "");
          setText(refs.bidDelta, "");
          setAttr(refs.bidDelta, "data-sign", null);
        } else {
          setAttr(refs.bidCell, "data-wall", row.wall ? "true" : null);
          setAttr(refs.bidCell, "data-flash", flashAttr);
          if (refs.bidBar) {
            const tr = `scaleX(${row.price !== null ? row.ratio.toFixed(3) : 0})`;
            if (refs.bidBar.style.transform !== tr) refs.bidBar.style.transform = tr;
          }
          setText(refs.bidVal, row.price !== null ? formatPrice(row.quantity, false) : "");
          setText(refs.bidDelta, deltaText);
          setAttr(refs.bidDelta, "data-sign", deltaSign);

          setAttr(refs.askCell, "data-wall", null);
          setAttr(refs.askCell, "data-flash", null);
          if (refs.askBar && refs.askBar.style.transform !== "scaleX(0)") refs.askBar.style.transform = "scaleX(0)";
          setText(refs.askVal, "");
          setText(refs.askDelta, "");
          setAttr(refs.askDelta, "data-sign", null);
        }
      }

      setText(totalAskRef.current, formatPrice(snapshot.totalAsk, false));
      setText(totalBidRef.current, formatPrice(snapshot.totalBid, false));

      if (totalAskDeltaRef.current) {
        if (snapshot.totalAskDelta !== 0) {
          totalAskDeltaRef.current.hidden = false;
          totalAskDeltaRef.current.className = snapshot.totalAskDelta > 0 ? "rp-ratio-delta rp-up" : "rp-ratio-delta rp-down";
          setText(totalAskDeltaRef.current, formatSignedQty(snapshot.totalAskDelta));
        } else {
          totalAskDeltaRef.current.hidden = true;
        }
      }
      if (totalBidDeltaRef.current) {
        if (snapshot.totalBidDelta !== 0) {
          totalBidDeltaRef.current.hidden = false;
          totalBidDeltaRef.current.className = snapshot.totalBidDelta > 0 ? "rp-ratio-delta rp-up" : "rp-ratio-delta rp-down";
          setText(totalBidDeltaRef.current, formatSignedQty(snapshot.totalBidDelta));
        } else {
          totalBidDeltaRef.current.hidden = true;
        }
      }

      if (ratioAskBarRef.current) ratioAskBarRef.current.style.width = `${snapshot.askPct}%`;
      if (ratioBidBarRef.current) ratioBidBarRef.current.style.width = `${snapshot.bidPct}%`;
      setText(ratioAskPctRef.current, `매도 ${snapshot.askPct}%`);
      setText(ratioBidPctRef.current, `매수 ${snapshot.bidPct}%`);
      if (obiRef.current) {
        obiRef.current.className = snapshot.obi >= 0 ? "rp-up" : "rp-down";
        setText(obiRef.current, `${snapshot.obi >= 0 ? "+" : ""}${snapshot.obi.toFixed(2)}`);
      }
    };

    return engine.subscribeFrame(apply);
  }, [engine, previousClose]);

  return (
    <section className="rp-col" aria-label="10호가 사다리" data-testid="replay-ladder">
      <div className="rp-pane-head">
        <div className="rp-pane-title">
          <span>10호가 사다리</span>
          <span ref={spreadRef} className="rp-badge-mini" data-testid="replay-spread">—</span>
        </div>
        <div className="rp-seg" role="group" aria-label="델타 표시 기준">
          <button type="button" aria-pressed={deltaMode === "tick"} onClick={() => onDeltaMode("tick")}>직전 틱 델타</button>
          <button type="button" aria-pressed={deltaMode === "min"} onClick={() => onDeltaMode("min")}>1분 누적 델타</button>
          <button type="button" aria-pressed={deltaMode === "off"} onClick={() => onDeltaMode("off")}>끄기</button>
        </div>
      </div>

      <div ref={gapBannerRef} className="rp-banner" data-mode="gap" role="status" data-testid="replay-gap-banner" hidden>
        <span>수집기 연결 끊김 구간 — 이 시각 호가·체결이 비어 있습니다</span>
        <span className="rp-mono">수집 끊김</span>
      </div>
      <div ref={viBannerRef} className="rp-banner" data-mode="vi" role="status" data-testid="replay-vi-banner" hidden>
        <span>단일가 호가 (VI · 동시호가 3단 이하)</span>
        <span className="rp-mono">단일가</span>
      </div>

      <div className="rp-lhead">
        <span>매도잔량 (증감)</span>
        <span>호가 · 등락률</span>
        <span>매수잔량 (증감)</span>
      </div>

      <div className="rp-ladder-body rp-mono">
        {ROW_INDICES.map((idx) => (
          <div
            key={idx}
            ref={(el) => {
              rowRefs.current[idx]!.row = el;
            }}
            className={idx === 9 ? "rp-lrow rp-mid-divider" : "rp-lrow"}
            data-side={idx < 10 ? "ask" : "bid"}
          >
            <div
              ref={(el) => {
                rowRefs.current[idx]!.askCell = el;
              }}
              className="rp-qcell"
              data-side="ask"
            >
              <i
                ref={(el) => {
                  rowRefs.current[idx]!.askBar = el;
                }}
                className="rp-qbar"
                style={{ transform: "scaleX(0)" }}
              />
              <span
                ref={(el) => {
                  rowRefs.current[idx]!.askDelta = el;
                }}
                className="rp-qdelta"
              />
              <span
                ref={(el) => {
                  rowRefs.current[idx]!.askVal = el;
                }}
                className="rp-qval"
              />
            </div>

            <div
              ref={(el) => {
                rowRefs.current[idx]!.pxCell = el;
              }}
              className="rp-px"
            >
              <span className="rp-px-tags">
                <i
                  ref={(el) => {
                    rowRefs.current[idx]!.pxTag = el;
                  }}
                  className="rp-px-tag"
                  hidden
                />
              </span>
              <span
                ref={(el) => {
                  rowRefs.current[idx]!.pxNum = el;
                }}
                className="rp-px-num"
              >
                —
              </span>
              <span
                ref={(el) => {
                  rowRefs.current[idx]!.pxRate = el;
                }}
                className="rp-px-rate"
              />
            </div>

            <div
              ref={(el) => {
                rowRefs.current[idx]!.bidCell = el;
              }}
              className="rp-qcell"
              data-side="bid"
            >
              <i
                ref={(el) => {
                  rowRefs.current[idx]!.bidBar = el;
                }}
                className="rp-qbar"
                style={{ transform: "scaleX(0)" }}
              />
              <span
                ref={(el) => {
                  rowRefs.current[idx]!.bidVal = el;
                }}
                className="rp-qval"
              />
              <span
                ref={(el) => {
                  rowRefs.current[idx]!.bidDelta = el;
                }}
                className="rp-qdelta"
              />
            </div>
          </div>
        ))}
      </div>

      <div className="rp-ladder-foot rp-mono">
        <div className="rp-ratio-nums">
          <div className="rp-ratio-side">
            <span className="rp-muted">매도 총잔량</span>
            <b ref={totalAskRef} className="rp-down" data-testid="replay-total-ask">0</b>
            <span ref={totalAskDeltaRef} className="rp-ratio-delta" hidden />
          </div>
          <div className="rp-ratio-side">
            <span ref={totalBidDeltaRef} className="rp-ratio-delta" hidden />
            <b ref={totalBidRef} className="rp-up" data-testid="replay-total-bid">0</b>
            <span className="rp-muted">매수 총잔량</span>
          </div>
        </div>
        <div className="rp-ratio-bar" aria-label="매도 대 매수 잔량 비율">
          <span ref={ratioAskBarRef} className="rp-ratio-ask" style={{ width: "50%" }} />
          <span ref={ratioBidBarRef} className="rp-ratio-bid" style={{ width: "50%" }} />
        </div>
        <div className="rp-ratio-meta">
          <span>
            <span ref={ratioAskPctRef} className="rp-down">매도 50%</span>
            {" : "}
            <span ref={ratioBidPctRef} className="rp-up">매수 50%</span>
          </span>
          <span data-testid="replay-obi">
            {"불균형(OBI) "}
            <b ref={obiRef} className="rp-up">+0.00</b>
          </span>
        </div>
      </div>
    </section>
  );
}
