import { memo, useMemo } from "react";
import type { Bar } from "../../api/generated/Bar";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { formatPrice, MINUS } from "../../lib/format";
import { formatClock, formatQuantity, withSign } from "../market-window/format";
import { useWindowedRows } from "../market-window/useWindowedRows";
import { eventsUntil, type BrokerTrack } from "./board";
import { priceAt } from "./history";

const signed = (value: number) => withSign(value, formatQuantity(Math.abs(value)).replace("-", MINUS));

export const DetailTable = memo(function DetailTable({ track, bars, cursor }: { track: BrokerTrack; bars: readonly Bar[]; cursor: UnixSeconds | null }) {
  const rows = useMemo(() => eventsUntil(track, cursor, track.events.length), [track, cursor]);
  const windowed = useWindowedRows(rows.length);
  const visible = rows.slice(windowed.range.start, windowed.range.end);

  return (
    <div className="br-det" data-testid="broker-detail">
      <div className="br-det-cap">{track.name}</div>
      <div className="br-det-table" role="table" aria-label={`${track.name} 건별 내역`}>
        <div ref={windowed.scroller} className="br-det-body" onScroll={windowed.onScroll}>
          <div className="br-det-tr br-det-th" role="row">
            <span role="columnheader">시각</span>
            <span role="columnheader" className="br-det-num">순간</span>
            <span role="columnheader" className="br-det-num">누적 순매수</span>
            <span role="columnheader" className="br-det-num">추정가격</span>
          </div>
          <div ref={windowed.list} style={windowed.spacing}>
            {visible.map((event) => {
              const price = priceAt(bars, event.t);
              return (
                <div key={event.t} className="br-det-tr" role="row" data-testid="broker-detail-row">
                  <span role="cell" className="br-det-time">{formatClock(event.t)}</span>
                  <span role="cell" className="br-det-num" data-tone={event.net > 0 ? "up" : event.net < 0 ? "down" : "none"}>{signed(event.net)}</span>
                  <span role="cell" className="br-det-num" data-tone={event.cumulative > 0 ? "up" : event.cumulative < 0 ? "down" : "none"}>{signed(event.cumulative)}</span>
                  <span role="cell" className="br-det-num br-det-price">{price === null ? "-" : formatPrice(price, false)}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
});
