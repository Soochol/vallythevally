import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { useSymbolInfo } from "../../api/queries";
import { MINUS } from "../../lib/format";
import type { WindowId } from "../../layout/kinds";
import { marketSocket } from "../../stores/realtime";
import { EmptyState } from "../overlay/State";
import { formatClock, formatShares, withSign } from "../market-window/format";
import { MarketWindowGate } from "../market-window/MarketWindowGate";
import { Strip } from "../market-window/parts";
import { EMPTY_BROKER_STATE, cumulativeAt, lineSegments, reduceBrokers, sortedRows, startedAt, type BrokerGrid, type BrokerRow } from "./model";
import "./brokers.css";

const ROW_HEIGHT = 24;
const MIN_COLUMN_WIDTH = 6;

export function BrokersWindow({ id }: { id: WindowId }) {
  return <MarketWindowGate id={id}>{(code) => <BrokersBody key={code} code={code} />}</MarketWindowGate>;
}

function BrokersBody({ code }: { code: SymbolCode }) {
  const name = useSymbolInfo(code).data?.name ?? code;
  const [state, dispatch] = useReducer(reduceBrokers, EMPTY_BROKER_STATE);
  const [failed, setFailed] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => marketSocket.subscribeFeed({ symbol: code, kind: "brokers" }, (event) => {
    if (event.type === "feed_brokers") dispatch({ type: "snapshot", brokers: event.brokers });
    else if (event.type === "feed_link") dispatch({ type: "link", live: event.live });
    else if (event.type === "resync") dispatch({ type: "resync" });
    else if (event.type === "feed_subscribed") setFailed(false);
    else if (event.type === "sub_error") setFailed(true);
  }), [code]);

  const { grid } = state;
  const columns = grid.times.length;
  const index = picked === null ? columns - 1 : Math.min(picked, columns - 1);
  const rows = useMemo(() => sortedRows(grid), [grid]);
  const since = startedAt(grid);
  const selectedRow = rows.find((row) => row.code === selected) ?? null;

  return (
    <div className="br" data-testid="brokers-window" data-symbol={code}>
      <Strip>
        <b>{name}</b>
        <span data-testid="brokers-since">{since === null ? "스냅샷을 기다리는 중" : `${formatClock(since)}부터 받은 스냅샷만 쌓입니다`}</span>
      </Strip>
      {failed && <EmptyState title="거래원을 받지 못했습니다" />}
      {!failed && columns === 0 && <EmptyState title="거래원 스냅샷을 기다리는 중입니다" />}
      {!failed && columns > 0 && (
        <>
          <div className="br-scrub">
            <label htmlFor="br-time">기준 시각</label>
            <input id="br-time" type="range" min={0} max={columns - 1} step={1} value={index} disabled={columns < 2} onChange={(e) => setPicked(Number(e.target.value))} />
            <output data-testid="brokers-time">{grid.times[index] === undefined ? "" : formatClock(grid.times[index])}</output>
          </div>
          <Heatmap grid={grid} rows={rows} index={index} selected={selected} onSelect={(code) => setSelected((current) => (current === code ? null : code))} />
          <Legend />
          {selectedRow && <CumulativeLine row={selectedRow} grid={grid} index={index} />}
        </>
      )}
    </div>
  );
}

function Legend() {
  return (
    <div className="br-legend" aria-label="범례">
      <span><i className="br-swatch" data-kind="buy" />순매수</span>
      <span><i className="br-swatch" data-kind="sell" />순매도</span>
      <span><i className="br-swatch" data-kind="out" />상위 5위 밖</span>
    </div>
  );
}

const signed = (value: number) => withSign(value, formatShares(Math.abs(value)).replace("-", MINUS));

function Heatmap({ grid, rows, index, selected, onSelect }: { grid: BrokerGrid; rows: readonly BrokerRow[]; index: number; selected: string | null; onSelect(code: string): void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const reach = Math.max(1, ...rows.map((row) => Math.abs(cumulativeAt(row, index) ?? 0)));

  useEffect(() => {
    const element = canvas.current;
    if (element === null) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = canvas.current;
    if (element === null || width === 0) return;
    paintHeatmap(element, grid, rows, index, selected, width);
  }, [grid, rows, index, selected, width]);

  return (
    <div className="br-scroll">
      <div className="br-body" style={{ ["--br-row" as string]: `${ROW_HEIGHT}px` }}>
        <div className="br-names">
          {rows.map((row) => <button key={row.code} type="button" className="br-name" aria-pressed={row.code === selected} data-testid="broker-row" onClick={() => onSelect(row.code)}>{row.name}</button>)}
        </div>
        <canvas ref={canvas} className="br-canvas" data-testid="brokers-canvas" style={{ height: rows.length * ROW_HEIGHT, minWidth: grid.times.length * MIN_COLUMN_WIDTH }} aria-label="거래원 시간별 순매수 히트맵" role="img" />
        <div className="br-values">
          {rows.map((row) => {
            const value = cumulativeAt(row, index);
            const share = value === null ? 0 : (Math.abs(value) / reach) * 100;
            return (
              <div key={row.code} className="br-value" data-kind={value === null ? "none" : value >= 0 ? "buy" : "sell"}>
                <i style={{ width: `${share}%` }} />
                <span data-testid="broker-cumulative">{value === null ? "-" : signed(value)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function cssColor(element: Element, name: string, fallback: string): string {
  return getComputedStyle(element).getPropertyValue(name).trim() || fallback;
}

function paintHeatmap(element: HTMLCanvasElement, grid: BrokerGrid, rows: readonly BrokerRow[], index: number, selected: string | null, width: number) {
  const ratio = window.devicePixelRatio || 1;
  const height = rows.length * ROW_HEIGHT;
  element.width = Math.round(width * ratio);
  element.height = Math.round(height * ratio);
  const ctx = element.getContext("2d");
  if (ctx === null) return;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const up = cssColor(element, "--up", "#ff6b78");
  const down = cssColor(element, "--down", "#5b9bff");
  const faint = cssColor(element, "--text-3", "#888");
  const accent = cssColor(element, "--accent", "#fff");
  const columns = grid.times.length;
  const cell = width / columns;
  const peak = Math.max(1, ...rows.flatMap((row) => row.cells.map((c) => Math.abs(c.net ?? 0))));
  rows.forEach((row, r) => {
    const y = r * ROW_HEIGHT;
    row.cells.forEach((c, x) => {
      const left = x * cell;
      if (!c.present || c.net === null) {
        ctx.setLineDash([2, 2]);
        ctx.strokeStyle = faint;
        ctx.globalAlpha = 0.35;
        ctx.strokeRect(left + 1.5, y + 1.5, Math.max(cell - 3, 1), ROW_HEIGHT - 3);
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        return;
      }
      ctx.fillStyle = c.net >= 0 ? up : down;
      ctx.globalAlpha = 0.12 + 0.88 * Math.sqrt(Math.abs(c.net) / peak);
      ctx.fillRect(left + 1, y + 1, Math.max(cell - 2, 1), ROW_HEIGHT - 2);
      ctx.globalAlpha = 1;
      if (c.first) {
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.arc(left + 4, y + 4, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    });
    if (row.code === selected) {
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, y + 0.5, width - 1, ROW_HEIGHT - 1);
    }
  });
  ctx.strokeStyle = faint;
  ctx.setLineDash([3, 3]);
  grid.gapBefore.forEach((gap, x) => {
    if (!gap) return;
    ctx.beginPath();
    ctx.moveTo(x * cell, 0);
    ctx.lineTo(x * cell, height);
    ctx.stroke();
  });
  ctx.setLineDash([]);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.strokeRect(index * cell + 1, 0, Math.max(cell - 2, 1), height);
}

const LINE_WIDTH = 320;
const LINE_HEIGHT = 80;

function CumulativeLine({ row, grid, index }: { row: BrokerRow; grid: BrokerGrid; index: number }) {
  const segments = lineSegments(row);
  const all = segments.flatMap((segment) => segment.values);
  const low = Math.min(0, ...all);
  const high = Math.max(0, ...all);
  const span = Math.max(high - low, 1);
  const columns = Math.max(grid.times.length - 1, 1);
  const x = (column: number) => (column / columns) * LINE_WIDTH;
  const y = (value: number) => LINE_HEIGHT - ((value - low) / span) * LINE_HEIGHT;
  return (
    <figure className="br-line" data-testid="broker-line" data-broker={row.code}>
      <figcaption>{row.name} 누적 순매수</figcaption>
      <svg viewBox={`0 0 ${LINE_WIDTH} ${LINE_HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={`${row.name} 누적 순매수 선`}>
        <line className="br-zero" x1={0} x2={LINE_WIDTH} y1={y(0)} y2={y(0)} />
        <line className="br-now" x1={x(index)} x2={x(index)} y1={0} y2={LINE_HEIGHT} />
        {segments.map((segment) => (
          <polyline key={segment.from} className="br-path" points={segment.values.map((value, i) => `${x(segment.from + i)},${y(value)}`).join(" ")} />
        ))}
      </svg>
    </figure>
  );
}
