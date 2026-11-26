import { useMemo } from "react";
import type { FeedBroker } from "../../api/generated/FeedBroker";
import type { FeedBrokers } from "../../api/generated/FeedBrokers";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { MINUS } from "../../lib/format";
import { isForeignBroker } from "../brokers/board";
import { snapshotAtOrBefore } from "../brokers/model";
import { formatClock, formatQuantity, withSign } from "../market-window/format";

const TOP_SLOTS = [0, 1, 2, 3, 4] as const;

const signed = (value: number) => withSign(value, formatQuantity(Math.abs(value)).replace("-", MINUS));

function formatDelta(value: number): string {
  if (value === 0) return "-";
  return signed(value);
}

function sumQty(items: readonly FeedBroker[]): number {
  let total = 0;
  for (const item of items) total += item.qty;
  return total;
}

function computeForeignNet(snapshot: FeedBrokers | null): number | null {
  if (snapshot === null) return null;
  let observed = false;
  let total = 0;
  for (const buy of snapshot.buys) {
    if (!isForeignBroker(buy.name)) continue;
    observed = true;
    total += buy.qty;
  }
  for (const sell of snapshot.sells) {
    if (!isForeignBroker(sell.name)) continue;
    observed = true;
    total -= sell.qty;
  }
  return observed ? total : null;
}

interface Props {
  readonly snapshots: readonly FeedBrokers[];
  readonly cursor: UnixSeconds | null;
}

export function ReplayBrokerTable({ snapshots, cursor }: Props) {
  const active = useMemo(() => snapshotAtOrBefore(snapshots, cursor), [snapshots, cursor]);
  const firstTime = snapshots[0]?.t ?? null;

  const { sells, buys, maxQty, sellTotal, buyTotal, netTotal, foreignNet } = useMemo(() => {
    const sellList = active ? active.sells.slice(0, TOP_SLOTS.length) : [];
    const buyList = active ? active.buys.slice(0, TOP_SLOTS.length) : [];
    let peak = 0;
    for (const item of sellList) peak = Math.max(peak, item.qty);
    for (const item of buyList) peak = Math.max(peak, item.qty);
    const sTotal = sumQty(sellList);
    const bTotal = sumQty(buyList);
    return {
      sells: sellList,
      buys: buyList,
      maxQty: peak,
      sellTotal: sTotal,
      buyTotal: bTotal,
      netTotal: bTotal - sTotal,
      foreignNet: computeForeignNet(active),
    };
  }, [active]);

  const netTone = active === null ? "none" : netTotal > 0 ? "up" : netTotal < 0 ? "down" : "none";
  const foreignTone = foreignNet === null ? "none" : foreignNet >= 0 ? "up" : "down";

  return (
    <div className="rp-brt" data-testid="replay-broker-table">
      <div className="rp-brt-head" role="row">
        <span className="rp-brt-side-sell">매도 상위 5</span>
        <span className="rp-brt-num">증감</span>
        <span className="rp-brt-num rp-brt-split">매도량</span>
        <span className="rp-brt-side-buy">매수 상위 5</span>
        <span className="rp-brt-num">증감</span>
        <span className="rp-brt-num">매수량</span>
      </div>

      <div className="rp-brt-body rp-mono">
        {TOP_SLOTS.map((slot) => {
          const sell = sells[slot] ?? null;
          const buy = buys[slot] ?? null;
          const sellRatio = sell !== null && maxQty > 0 ? Math.min(100, (sell.qty / maxQty) * 100) : 0;
          const buyRatio = buy !== null && maxQty > 0 ? Math.min(100, (buy.qty / maxQty) * 100) : 0;

          return (
            <div key={slot} className="rp-brt-row" data-testid="replay-broker-table-row">
              <span className="rp-brt-name" data-testid="replay-broker-sell-name">
                {sell ? (
                  <>
                    <span className="rp-brt-label">{sell.name}</span>
                    {isForeignBroker(sell.name) && <span className="br-fb">외</span>}
                  </>
                ) : (
                  <span className="rp-muted">-</span>
                )}
              </span>
              <span className="rp-brt-chg" data-tone={sell && sell.qtyChange !== 0 ? "down" : "none"}>
                {sell ? formatDelta(sell.qtyChange) : "-"}
              </span>
              <span className="rp-brt-qty rp-brt-split" data-side="sell" data-testid="replay-broker-sell-qty">
                {sellRatio > 0 && <i className="rp-brt-bar" style={{ width: `${sellRatio}%` }} aria-hidden />}
                <span>{sell ? formatQuantity(sell.qty) : "-"}</span>
              </span>

              <span className="rp-brt-name" data-testid="replay-broker-buy-name">
                {buy ? (
                  <>
                    <span className="rp-brt-label">{buy.name}</span>
                    {isForeignBroker(buy.name) && <span className="br-fb">외</span>}
                  </>
                ) : (
                  <span className="rp-muted">-</span>
                )}
              </span>
              <span className="rp-brt-chg" data-tone={buy && buy.qtyChange !== 0 ? "up" : "none"}>
                {buy ? formatDelta(buy.qtyChange) : "-"}
              </span>
              <span className="rp-brt-qty" data-side="buy" data-testid="replay-broker-buy-qty">
                {buyRatio > 0 && <i className="rp-brt-bar" style={{ width: `${buyRatio}%` }} aria-hidden />}
                <span>{buy ? formatQuantity(buy.qty) : "-"}</span>
              </span>
            </div>
          );
        })}

        <div className="rp-brt-totals" data-testid="replay-broker-table-totals">
          <span className="rp-brt-tot-label">매도합계</span>
          <span className="rp-brt-tot-val rp-brt-split" data-tone="down">
            {active ? formatQuantity(sellTotal) : "-"}
          </span>
          <span className="rp-brt-tot-label">매수합계</span>
          <span className="rp-brt-tot-val" data-tone="up">
            {active ? formatQuantity(buyTotal) : "-"}
          </span>
        </div>
      </div>

      <div className="br-foot rp-mono">
        <span data-testid="replay-broker-table-stamp">
          {active !== null
            ? `기준 ${formatClock(active.t)}`
            : firstTime !== null
              ? `첫 스냅샷 ${formatClock(firstTime)}`
              : "스냅샷 없음"}
        </span>
        <span className="rp-brt-foot-net" data-tone={netTone}>
          {`상위5 순매수 ${active ? signed(netTotal) : "-"}`}
        </span>
        <span
          className="br-foot-r"
          data-testid="replay-broker-table-foreign"
          data-tone={foreignTone}
        >
          {`외국계 ${foreignNet === null ? "-" : signed(foreignNet)}`}
        </span>
      </div>
    </div>
  );
}
