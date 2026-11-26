import { formatPercent, formatPrice } from "../../lib/format";
import {
  type DeltaMode,
  formatSignedQty,
  type ReplayLadderSnapshot,
} from "./replayModel";

interface Props {
  readonly snapshot: ReplayLadderSnapshot;
  readonly previousClose: number | null;
  readonly deltaMode: DeltaMode;
  readonly onDeltaMode: (mode: DeltaMode) => void;
}

const DAY_TAG_LABEL = {
  open: { short: "시", title: "시가" },
  high: { short: "고", title: "고가" },
  low: { short: "저", title: "저가" },
} as const;

export function ReplayLadder({ snapshot, previousClose, deltaMode, onDeltaMode }: Props) {
  const spreadLabel = snapshot.inGap
    ? "—"
    : snapshot.singlePrice
      ? "단일가 호가"
      : snapshot.spreadTicks !== null && snapshot.spreadWon !== null
        ? `스프레드 ${snapshot.spreadTicks}틱 (${formatPrice(snapshot.spreadWon, false)}원)`
        : "—";

  return (
    <section className="rp-col" aria-label="10호가 사다리" data-testid="replay-ladder">
      <div className="rp-pane-head">
        <div className="rp-pane-title">
          <span>10호가 사다리</span>
          <span className="rp-badge-mini" data-testid="replay-spread">{spreadLabel}</span>
        </div>
        <div className="rp-seg" role="group" aria-label="델타 표시 기준">
          <button type="button" aria-pressed={deltaMode === "tick"} onClick={() => onDeltaMode("tick")}>직전 델타</button>
          <button type="button" aria-pressed={deltaMode === "min"} onClick={() => onDeltaMode("min")}>1분 누적 델타</button>
          <button type="button" aria-pressed={deltaMode === "off"} onClick={() => onDeltaMode("off")}>끄기</button>
        </div>
      </div>

      {snapshot.inGap && (
        <div className="rp-banner" data-mode="gap" role="status" data-testid="replay-gap-banner">
          <span>수집기 연결 끊김 구간 — 이 시각 호가·체결이 비어 있습니다</span>
          <span className="rp-mono">수집 끊김</span>
        </div>
      )}
      {!snapshot.inGap && snapshot.singlePrice && (
        <div className="rp-banner" data-mode="vi" role="status" data-testid="replay-vi-banner">
          <span>단일가 호가 (VI · 동시호가 3단 이하)</span>
          <span className="rp-mono">단일가</span>
        </div>
      )}

      <div className="rp-lhead">
        <span>매도잔량 (증감)</span>
        <span>호가 · 등락률</span>
        <span>매수잔량 (증감)</span>
      </div>

      <div className="rp-ladder-body rp-mono">
        {snapshot.rows.map((row, idx) => {
          const priceTone = row.price === null || previousClose === null || previousClose <= 0
            ? ""
            : row.price > previousClose
              ? "rp-up"
              : row.price < previousClose
                ? "rp-down"
                : "";
          const deltaText = row.delta !== 0 ? formatSignedQty(row.delta) : "";
          const deltaSign = row.delta > 0 ? "pos" : row.delta < 0 ? "neg" : undefined;

          return (
            <div
              key={idx}
              className={idx === 9 ? "rp-lrow rp-mid-divider" : "rp-lrow"}
              data-side={row.side}
              data-dim={row.dimmed ? "true" : undefined}
              data-current={row.current ? "true" : undefined}
              data-last-hit={row.lastHit ?? undefined}
            >
              <div className="rp-qcell" data-side="ask" data-wall={row.side === "ask" && row.wall ? "true" : undefined}>
                <i className="rp-qbar" style={{ transform: `scaleX(${row.side === "ask" && row.price !== null ? row.ratio.toFixed(3) : 0})` }} />
                {row.side === "ask" && deltaText !== "" && <span className="rp-qdelta" data-sign={deltaSign}>{deltaText}</span>}
                {row.side === "ask" && row.price !== null && <span className="rp-qval">{formatPrice(row.quantity, false)}</span>}
              </div>

              <div className={`rp-px ${priceTone}`}>
                <span className="rp-px-tags">
                  {row.tags.slice(0, 1).map((tag) => (
                    <i key={tag} className="rp-px-tag" data-kind={tag} title={DAY_TAG_LABEL[tag].title}>{DAY_TAG_LABEL[tag].short}</i>
                  ))}
                </span>
                <span className="rp-px-num">{row.price !== null ? formatPrice(row.price, false) : "—"}</span>
                <span className="rp-px-rate">{row.rate !== null ? formatPercent(row.rate) : ""}</span>
              </div>

              <div className="rp-qcell" data-side="bid" data-wall={row.side === "bid" && row.wall ? "true" : undefined}>
                <i className="rp-qbar" style={{ transform: `scaleX(${row.side === "bid" && row.price !== null ? row.ratio.toFixed(3) : 0})` }} />
                {row.side === "bid" && row.price !== null && <span className="rp-qval">{formatPrice(row.quantity, false)}</span>}
                {row.side === "bid" && deltaText !== "" && <span className="rp-qdelta" data-sign={deltaSign}>{deltaText}</span>}
              </div>
            </div>
          );
        })}
      </div>

      <div className="rp-ladder-foot rp-mono">
        <div className="rp-ratio-nums">
          <div className="rp-ratio-side">
            <span className="rp-muted">매도 총잔량</span>
            <b className="rp-down" data-testid="replay-total-ask">{formatPrice(snapshot.totalAsk, false)}</b>
            {snapshot.totalAskDelta !== 0 && (
              <span className={snapshot.totalAskDelta > 0 ? "rp-ratio-delta rp-up" : "rp-ratio-delta rp-down"}>
                {formatSignedQty(snapshot.totalAskDelta)}
              </span>
            )}
          </div>
          <div className="rp-ratio-side">
            {snapshot.totalBidDelta !== 0 && (
              <span className={snapshot.totalBidDelta > 0 ? "rp-ratio-delta rp-up" : "rp-ratio-delta rp-down"}>
                {formatSignedQty(snapshot.totalBidDelta)}
              </span>
            )}
            <b className="rp-up" data-testid="replay-total-bid">{formatPrice(snapshot.totalBid, false)}</b>
            <span className="rp-muted">매수 총잔량</span>
          </div>
        </div>
        <div className="rp-ratio-bar" aria-label="매도 대 매수 잔량 비율">
          <span className="rp-ratio-ask" style={{ width: `${snapshot.askPct}%` }} />
          <span className="rp-ratio-bid" style={{ width: `${snapshot.bidPct}%` }} />
        </div>
        <div className="rp-ratio-meta">
          <span>
            <span className="rp-down">{`매도 ${snapshot.askPct}%`}</span>
            {" : "}
            <span className="rp-up">{`매수 ${snapshot.bidPct}%`}</span>
          </span>
          <span data-testid="replay-obi">
            {"불균형(OBI) "}
            <b className={snapshot.obi >= 0 ? "rp-up" : "rp-down"}>
              {`${snapshot.obi >= 0 ? "+" : ""}${snapshot.obi.toFixed(2)}`}
            </b>
          </span>
        </div>
      </div>
    </section>
  );
}
