import { useMemo } from "react";
import type { FeedBroker } from "../../api/generated/FeedBroker";
import type { FeedBrokers } from "../../api/generated/FeedBrokers";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { MINUS } from "../../lib/format";
import { formatClock, formatQuantity, withSign } from "../market-window/format";
import { isForeignBroker } from "./board";
import { snapshotAtOrBefore } from "./model";

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

interface TableViewProps {
  readonly snapshots: readonly FeedBrokers[];
  readonly cursor: UnixSeconds | null;
  readonly testIdPrefix?: string;
}

export function TableView({ snapshots, cursor, testIdPrefix = "broker" }: TableViewProps) {
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
    <div className="br-tbl" data-testid={`${testIdPrefix}-table`}>
      <div className="br-tbl-head" role="row">
        <span className="br-tbl-side-sell">매도 상위 5</span>
        <span className="br-tbl-num">증감</span>
        <span className="br-tbl-num br-tbl-split">매도량</span>
        <span className="br-tbl-side-buy">매수 상위 5</span>
        <span className="br-tbl-num">증감</span>
        <span className="br-tbl-num">매수량</span>
      </div>

      <div className="br-tbl-body">
        {TOP_SLOTS.map((slot) => {
          const sell = sells[slot] ?? null;
          const buy = buys[slot] ?? null;
          const sellRatio = sell !== null && maxQty > 0 ? Math.min(100, (sell.qty / maxQty) * 100) : 0;
          const buyRatio = buy !== null && maxQty > 0 ? Math.min(100, (buy.qty / maxQty) * 100) : 0;

          return (
            <div key={slot} className="br-tbl-row" data-testid={`${testIdPrefix}-table-row`}>
              <span className="br-tbl-name" data-testid={`${testIdPrefix}-sell-name`}>
                {sell ? (
                  <>
                    <span className="br-tbl-label">{sell.name}</span>
                    {isForeignBroker(sell.name) && <span className="br-fb">외</span>}
                  </>
                ) : (
                  <span className="br-tbl-empty">-</span>
                )}
              </span>
              <span className="br-tbl-chg" data-tone={sell && sell.qtyChange !== 0 ? "down" : "none"}>
                {sell ? formatDelta(sell.qtyChange) : "-"}
              </span>
              <span className="br-tbl-qty br-tbl-split" data-side="sell" data-testid={`${testIdPrefix}-sell-qty`}>
                {sellRatio > 0 && <i className="br-tbl-bar" style={{ width: `${sellRatio}%` }} aria-hidden />}
                <span>{sell ? formatQuantity(sell.qty) : "-"}</span>
              </span>

              <span className="br-tbl-name" data-testid={`${testIdPrefix}-buy-name`}>
                {buy ? (
                  <>
                    <span className="br-tbl-label">{buy.name}</span>
                    {isForeignBroker(buy.name) && <span className="br-fb">외</span>}
                  </>
                ) : (
                  <span className="br-tbl-empty">-</span>
                )}
              </span>
              <span className="br-tbl-chg" data-tone={buy && buy.qtyChange !== 0 ? "up" : "none"}>
                {buy ? formatDelta(buy.qtyChange) : "-"}
              </span>
              <span className="br-tbl-qty" data-side="buy" data-testid={`${testIdPrefix}-buy-qty`}>
                {buyRatio > 0 && <i className="br-tbl-bar" style={{ width: `${buyRatio}%` }} aria-hidden />}
                <span>{buy ? formatQuantity(buy.qty) : "-"}</span>
              </span>
            </div>
          );
        })}

        <div className="br-tbl-totals" data-testid={`${testIdPrefix}-table-totals`}>
          <span className="br-tbl-tot-label">매도합계</span>
          <span className="br-tbl-tot-val br-tbl-split" data-tone="down">
            {active ? formatQuantity(sellTotal) : "-"}
          </span>
          <span className="br-tbl-tot-label">매수합계</span>
          <span className="br-tbl-tot-val" data-tone="up">
            {active ? formatQuantity(buyTotal) : "-"}
          </span>
        </div>
      </div>

      <div className="br-foot">
        <span data-testid={`${testIdPrefix}-table-stamp`}>
          {active !== null
            ? `기준 ${formatClock(active.t)}`
            : firstTime !== null
              ? `첫 스냅샷 ${formatClock(firstTime)}`
              : "스냅샷 없음"}
        </span>
        <span className="br-tbl-foot-net" data-tone={netTone}>
          {`상위5 순매수 ${active ? signed(netTotal) : "-"}`}
        </span>
        <span
          className="br-foot-r"
          data-testid={`${testIdPrefix}-table-foreign`}
          data-tone={foreignTone}
        >
          {`외국계 ${foreignNet === null ? "-" : signed(foreignNet)}`}
        </span>
      </div>
    </div>
  );
}
