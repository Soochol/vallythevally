import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchBarsPage, fetchJumpPage, jumpAsBarsPage } from "../../api/bars";
import type { Bar } from "../../api/generated/Bar";
import type { Venue } from "../../api/generated/Venue";
import { subscribeTheme } from "../../persist/theme";
import {
  clamp,
  dayShortLabel,
  formatMinutes,
  formatPct,
  formatUtcMsToDay,
  formatWon,
  snapTick,
  synthesizeDemoBars,
  todayKstIso,
  toneClass,
  tradePnl,
} from "./journalEngine";
import { TF_TO_PERIOD, type JournalBar, type JournalFill, type JournalTf, type JournalTrade } from "./journalTypes";

interface Props {
  readonly trade: JournalTrade;
  readonly tf: JournalTf;
  readonly isAutoTf: boolean;
  readonly afterCost: boolean;
  readonly highlightFill: JournalFill | null;
  readonly resetTick: number;
}

interface ViewRange {
  from: number;
  to: number;
}

interface HoverPoint {
  x: number;
  y: number;
}

interface LegendState {
  readonly dateLabel: string;
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
  readonly chgPct: number;
  readonly fillNote: string;
}

function toJournalBars(bars: readonly Bar[]): readonly JournalBar[] {
  return bars.map((b) => {
    const kstMs = b.t * 1000 + 9 * 3600_000;
    const dt = new Date(kstMs);
    const day = formatUtcMsToDay(kstMs);
    const minutes = dt.getUTCHours() * 60 + dt.getUTCMinutes();
    return { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, day, minutes };
  });
}

function findBarIndexForFill(bars: readonly JournalBar[], fill: JournalFill, tf: JournalTf): number {
  if (bars.length === 0) return 0;
  if (tf === "D") {
    const exact = bars.findIndex((b) => b.day === fill.day);
    if (exact >= 0) return exact;
    let best = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < bars.length; i += 1) {
      const diff = Math.abs(bars[i]!.day.localeCompare(fill.day));
      if (diff < bestDiff) {
        bestDiff = diff;
        best = i;
      }
    }
    return best;
  }
  const step = tf === "5" ? 5 : 1;
  const bucketMin = Math.floor(fill.minutes / step) * step;
  const exact = bars.findIndex((b) => b.day === fill.day && b.minutes === bucketMin);
  if (exact >= 0) return exact;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < bars.length; i += 1) {
    const b = bars[i]!;
    const dayPenalty = b.day === fill.day ? 0 : 100000;
    const dist = dayPenalty + Math.abs(b.minutes - fill.minutes);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

export function JournalCandleChart({ trade, tf, isAutoTf, afterCost, highlightFill, resetTick }: Props) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewRef = useRef<ViewRange>({ from: 0, to: 40 });
  const hoverRef = useRef<HoverPoint | null>(null);
  const dragRef = useRef<{ x: number; from: number; to: number } | null>(null);
  const rafRef = useRef<number>(0);

  const [themeRev, setThemeRev] = useState(0);
  const [sizeRev, setSizeRev] = useState(0);
  const [legend, setLegend] = useState<LegendState | null>(null);

  const isDemo = trade.demoSeed !== null;
  const venueParam: Venue = trade.venue === "nxt" ? "nxt" : "krx";
  const period = TF_TO_PERIOD[tf];
  const today = todayKstIso();

  const barsQuery = useQuery({
    queryKey: ["journal", "bars", trade.code, venueParam, period, trade.exitDay],
    enabled: !isDemo,
    staleTime: 60_000,
    retry: false,
    queryFn: async ({ signal }) => {
      if (tf !== "D" && trade.exitDay < today) {
        try {
          const jumped = await fetchJumpPage(
            { symbol: trade.code, venue: venueParam, period, date: trade.exitDay, limit: 300 },
            signal,
          );
          return jumpAsBarsPage(jumped).bars;
        } catch {
          const fallback = await fetchBarsPage(
            { symbol: trade.code, venue: venueParam, period, limit: 300 },
            signal,
          );
          return fallback.bars;
        }
      }
      const page = await fetchBarsPage(
        { symbol: trade.code, venue: venueParam, period, limit: 300 },
        signal,
      );
      return page.bars;
    },
  });

  const bars = useMemo<readonly JournalBar[]>(() => {
    if (isDemo) return synthesizeDemoBars(trade, tf);
    const raw = barsQuery.data ?? [];
    if (raw.length > 0) return toJournalBars(raw);
    return synthesizeDemoBars({ ...trade, demoSeed: 777123 }, tf);
  }, [isDemo, barsQuery.data, trade, tf]);

  const entryIdx = useMemo(
    () => (trade.buys[0] ? findBarIndexForFill(bars, trade.buys[0], tf) : 0),
    [bars, trade.buys, tf],
  );
  const exitIdx = useMemo(() => {
    const lastSell = trade.sells[trade.sells.length - 1];
    return lastSell ? findBarIndexForFill(bars, lastSell, tf) : Math.max(0, bars.length - 1);
  }, [bars, trade.sells, tf]);

  const highlightIdx = useMemo(
    () => (highlightFill ? findBarIndexForFill(bars, highlightFill, tf) : null),
    [bars, highlightFill, tf],
  );

  const computeDefaultRange = useMemo(() => {
    return (): ViewRange => {
      const n = bars.length;
      if (n === 0) return { from: 0, to: 1 };
      if (tf === "D") {
        return { from: Math.max(-1, n - 52), to: n + 4 };
      }
      const lo = Math.min(entryIdx, exitIdx);
      const hi = Math.max(entryIdx, exitIdx);
      const span = hi - lo;
      const padB = Math.max(18, span * 0.55);
      let from = lo - padB;
      let to = hi + padB + 1;
      if (to - from < 56) {
        const mid = (from + to) / 2;
        from = mid - 28;
        to = mid + 28;
      }
      if (to > n + 3) {
        from -= to - (n + 3);
        to = n + 3;
      }
      if (from < -2) {
        to = Math.min(n + 3, to + (-2 - from));
        from = -2;
      }
      return { from, to };
    };
  }, [bars.length, entryIdx, exitIdx, tf]);

  useEffect(() => {
    viewRef.current = computeDefaultRange();
  }, [computeDefaultRange, trade.id, tf, resetTick]);

  useEffect(() => subscribeTheme(() => setThemeRev((v) => v + 1)), []);

  useEffect(() => {
    const box = boxRef.current;
    if (box === null) return;
    const ro = new ResizeObserver(() => setSizeRev((v) => v + 1));
    ro.observe(box);
    return () => ro.disconnect();
  }, []);

  const drawRef = useRef<() => void>(() => {});
  drawRef.current = () => {
    const box = boxRef.current;
    const cv = canvasRef.current;
    if (box === null || cv === null || bars.length === 0) return;
    const w = box.clientWidth;
    const h = box.clientHeight;
    if (w <= 0 || h <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    const targetW = Math.round(w * dpr);
    const targetH = Math.round(h * dpr);
    if (cv.width !== targetW || cv.height !== targetH) {
      cv.width = targetW;
      cv.height = targetH;
    }

    const ctx = cv.getContext("2d");
    if (ctx === null) return;

    const styles = getComputedStyle(document.documentElement);
    const cssVar = (name: string) => styles.getPropertyValue(name).trim();
    const isProfit = tradePnl(trade, afterCost) >= 0;
    const C = {
      up: cssVar("--up"),
      down: cssVar("--down"),
      upVol: cssVar("--up-vol"),
      dnVol: cssVar("--down-vol"),
      t1: cssVar("--text"),
      t2: cssVar("--text-2"),
      t3: cssVar("--text-3"),
      grid: cssVar("--grid-h"),
      surf: cssVar("--surface"),
      raised: cssVar("--raised"),
      hold: isProfit ? cssVar("--cloud-up") : cssVar("--cloud-down"),
      cross: cssVar("--crosshair"),
    };

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const PL = 10;
    const PR = 68;
    const PT = 34;
    const PB = 24;
    const pw = Math.max(10, w - PL - PR);
    const ph = Math.max(10, h - PT - PB);
    const volH = Math.round(ph * 0.14);
    const priceH = Math.max(10, ph - volH - 10);

    const { from, to } = viewRef.current;
    const bw = pw / Math.max(1, to - from);
    const i0 = Math.max(0, Math.floor(from));
    const i1 = Math.min(bars.length - 1, Math.ceil(to));

    let lo = Infinity;
    let hi = -Infinity;
    let vmax = 1;
    for (let i = i0; i <= i1; i += 1) {
      const b = bars[i]!;
      if (b.l < lo) lo = b.l;
      if (b.h > hi) hi = b.h;
      if (b.v > vmax) vmax = b.v;
    }
    if (exitIdx >= i0 && entryIdx <= i1) {
      lo = Math.min(lo, trade.avgBuy);
      hi = Math.max(hi, trade.avgBuy);
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      lo = trade.avgBuy * 0.98;
      hi = trade.avgBuy * 1.02;
    }
    const padP = (hi - lo) * 0.16 || hi * 0.01;
    lo -= padP;
    hi += padP;

    const X = (idx: number) => PL + (idx - from + 0.5) * bw;
    const Y = (price: number) => PT + ((hi - price) / (hi - lo)) * priceH;
    const setFont = (px: number, wt = 500) => {
      ctx.font = `${wt} ${px}px "Pretendard Variable", Pretendard, system-ui, sans-serif`;
    };

    const rawStep = (hi - lo) / 5;
    const pow = Math.pow(10, Math.floor(Math.log10(Math.max(1, rawStep))));
    const stepP = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((m) => m >= rawStep) ?? pow;
    setFont(11, 400);
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    for (let p = Math.ceil(lo / stepP) * stepP; p <= hi; p += stepP) {
      const y = Math.round(Y(p)) + 0.5;
      if (y < PT || y > PT + priceH) continue;
      ctx.strokeStyle = C.grid;
      ctx.beginPath();
      ctx.moveTo(PL, y);
      ctx.lineTo(PL + pw, y);
      ctx.stroke();
      ctx.fillStyle = C.t3;
      ctx.fillText(formatWon(p, false), PL + pw + 8, y);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(PL, PT - 6, pw, ph + 6);
    ctx.clip();

    const hx0 = X(Math.min(entryIdx, exitIdx)) - bw / 2;
    const hx1 = X(Math.max(entryIdx, exitIdx)) + bw / 2;
    ctx.fillStyle = C.hold;
    ctx.fillRect(hx0, PT, Math.max(bw, hx1 - hx0), ph);

    if (highlightIdx !== null && highlightIdx >= i0 && highlightIdx <= i1) {
      ctx.fillStyle = C.raised;
      ctx.globalAlpha = 0.7;
      ctx.fillRect(X(highlightIdx) - Math.max(bw * 0.65, 6), PT, Math.max(bw * 1.3, 12), ph);
      ctx.globalAlpha = 1;
    }

    const bodyW = Math.max(1.5, Math.min(bw * 0.66, 13));
    const vy0 = PT + ph;
    for (let i = i0; i <= i1; i += 1) {
      const b = bars[i]!;
      const x = X(i);
      const upc = b.c >= b.o;
      const cx = Math.round(x) + 0.5;
      ctx.fillStyle = upc ? C.upVol : C.dnVol;
      const vh = (b.v / vmax) * volH;
      ctx.fillRect(x - bodyW / 2, vy0 - vh, bodyW, vh);
      ctx.strokeStyle = ctx.fillStyle = upc ? C.up : C.down;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(cx, Y(b.h));
      ctx.lineTo(cx, Y(b.l));
      ctx.stroke();
      const yo = Y(b.o);
      const yc = Y(b.c);
      ctx.fillRect(x - bodyW / 2, Math.min(yo, yc), bodyW, Math.max(1.5, Math.abs(yc - yo)));
    }

    const ya = Math.round(Y(trade.avgBuy)) + 0.5;
    ctx.strokeStyle = C.t2;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(hx0, ya);
    ctx.lineTo(hx1, ya);
    ctx.stroke();
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.moveTo(hx1, ya);
    ctx.lineTo(PL + pw, ya);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);

    const stackB = new Map<number, number>();
    const stackS = new Map<number, number>();
    const half = Math.max(bodyW / 2 + 4, 6);
    const marks: { x: number; y: number }[] = [];

    const drawFill = (f: JournalFill, isSell: boolean, seq: number, multi: boolean) => {
      const idx = findBarIndexForFill(bars, f, tf);
      const b = bars[idx];
      if (b === undefined) return;
      const x = X(idx);
      const yp = Math.round(Y(f.price)) + 0.5;
      const mp = isSell ? stackS : stackB;
      const k = mp.get(idx) ?? 0;
      mp.set(idx, k + 1);

      ctx.strokeStyle = ctx.fillStyle = isSell ? C.down : C.up;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(x - half, yp);
      ctx.lineTo(x + half, yp);
      ctx.stroke();
      ctx.lineWidth = 1;

      const s = isSell ? -1 : 1;
      const gapY = multi ? 13 : 11;
      const y = isSell ? Y(b.h) - 10 - k * gapY : Y(b.l) + 10 + k * gapY;
      ctx.beginPath();
      ctx.moveTo(x, y - 4.5 * s);
      ctx.lineTo(x - 5, y + 4 * s);
      ctx.lineTo(x + 5, y + 4 * s);
      ctx.closePath();
      ctx.fill();

      if (multi) {
        setFont(11, 700);
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(String(seq), x + 7, y);
      }
      marks.push({ x, y });
    };

    trade.buys.forEach((f, idx) => drawFill(f, false, idx + 1, trade.buys.length > 1));
    trade.sells.forEach((f, idx) => drawFill(f, true, idx + 1, trade.sells.length > 1));

    const holdLo = Math.min(entryIdx, exitIdx);
    const holdHi = Math.max(entryIdx, exitIdx);
    if (holdHi > holdLo) {
      let hiBar = holdLo;
      let loBar = holdLo;
      for (let i = holdLo; i <= holdHi; i += 1) {
        if (bars[i]!.h > bars[hiBar]!.h) hiBar = i;
        if (bars[i]!.l < bars[loBar]!.l) loBar = i;
      }
      const clearY = (x: number, y: number, dir: -1 | 1) => {
        let outY = y;
        for (const m of marks) {
          if (Math.abs(m.x - x) < 48) outY = dir < 0 ? Math.min(outY, m.y - 12) : Math.max(outY, m.y + 12);
        }
        return outY;
      };
      const halo = (txt: string, x: number, y: number, color: string) => {
        ctx.strokeStyle = C.surf;
        ctx.lineWidth = 3.5;
        ctx.lineJoin = "round";
        ctx.strokeText(txt, x, y);
        ctx.fillStyle = color;
        ctx.fillText(txt, x, y);
      };
      setFont(11, 600);
      ctx.textAlign = "center";
      const xH = clamp(X(hiBar), PL + 38, PL + pw - 38);
      const xL = clamp(X(loBar), PL + 38, PL + pw - 38);
      ctx.textBaseline = "bottom";
      halo(`최고 ${formatPct(trade.mfe)}`, xH, clearY(xH, Y(bars[hiBar]!.h) - 6, -1), C.up);
      ctx.textBaseline = "top";
      halo(`최저 ${formatPct(trade.mae)}`, xL, clearY(xL, Y(bars[loBar]!.l) + 6, 1), C.down);
    }

    ctx.restore();

    if (ya >= PT && ya <= PT + priceH) {
      setFont(11, 600);
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillStyle = C.raised;
      ctx.fillRect(PL + pw + 2, ya - 9, PR - 6, 18);
      ctx.fillStyle = C.t1;
      ctx.fillText(formatWon(trade.avgBuy, false), PL + pw + 8, ya);
    }

    setFont(11, 400);
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "center";
    const need = Math.ceil(68 / Math.max(1, bw));
    if (tf === "D") {
      const stepB = [1, 2, 5, 10, 20].find((x) => x >= need) ?? 40;
      ctx.fillStyle = C.t3;
      for (let i = i0; i <= i1; i += 1) {
        if (i % stepB === 0) ctx.fillText(dayShortLabel(bars[i]!.day), X(i), h - 7);
      }
    } else {
      const stepB = Math.max(1, need);
      let prevDay = "";
      for (let i = i0; i <= i1; i += 1) {
        const b = bars[i]!;
        const x = X(i);
        if (x < PL + 20 || x > PL + pw - 20) continue;
        if (b.day !== prevDay) {
          prevDay = b.day;
          ctx.fillStyle = C.t2;
          ctx.fillText(dayShortLabel(b.day), x, h - 7);
        } else if (i % stepB === 0) {
          ctx.fillStyle = C.t3;
          ctx.fillText(formatMinutes(b.minutes), x, h - 7);
        }
      }
    }

    let legendBar = bars[clamp(exitIdx, 0, bars.length - 1)]!;
    let fillNote = "";
    const hv = hoverRef.current;
    if (hv !== null && hv.x >= PL && hv.x <= PL + pw && hv.y >= PT && hv.y <= PT + ph) {
      const idx = clamp(Math.floor((hv.x - PL) / bw + from), 0, bars.length - 1);
      const cx = Math.round(X(idx)) + 0.5;
      const cy = Math.round(hv.y) + 0.5;
      legendBar = bars[idx]!;
      ctx.strokeStyle = C.cross;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(cx, PT);
      ctx.lineTo(cx, PT + ph);
      ctx.moveTo(PL, cy);
      ctx.lineTo(PL + pw, cy);
      ctx.stroke();
      ctx.setLineDash([]);

      if (hv.y <= PT + priceH) {
        const p = hi - ((hv.y - PT) / priceH) * (hi - lo);
        setFont(11, 600);
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        ctx.fillStyle = C.t1;
        ctx.fillRect(PL + pw + 2, cy - 9, PR - 6, 18);
        ctx.fillStyle = C.surf;
        ctx.fillText(formatWon(snapTick(p), false), PL + pw + 8, cy);
      }

      const hereB = trade.buys.filter((f) => findBarIndexForFill(bars, f, tf) === idx);
      const hereS = trade.sells.filter((f) => findBarIndexForFill(bars, f, tf) === idx);
      const notes: string[] = [];
      if (hereB.length > 0) notes.push(`▲ 매수 ${hereB.map((f) => `${formatWon(f.price, false)}×${f.qty}`).join(", ")}`);
      if (hereS.length > 0) notes.push(`▼ 매도 ${hereS.map((f) => `${formatWon(f.price, false)}×${f.qty}`).join(", ")}`);
      fillNote = notes.join("  ");
    }

    const chgPct = legendBar.o > 0 ? ((legendBar.c - legendBar.o) / legendBar.o) * 100 : 0;
    const dateLabel =
      tf === "D" ? dayShortLabel(legendBar.day) : `${dayShortLabel(legendBar.day)} ${formatMinutes(legendBar.minutes)}`;
    setLegend((prev) => {
      if (
        prev !== null &&
        prev.dateLabel === dateLabel &&
        prev.o === legendBar.o &&
        prev.h === legendBar.h &&
        prev.l === legendBar.l &&
        prev.c === legendBar.c &&
        prev.fillNote === fillNote
      ) {
        return prev;
      }
      return { dateLabel, o: legendBar.o, h: legendBar.h, l: legendBar.l, c: legendBar.c, chgPct, fillNote };
    });
  };

  const scheduleDraw = () => {
    if (rafRef.current !== 0) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      drawRef.current();
    });
  };

  useEffect(() => {
    scheduleDraw();
    return () => {
      if (rafRef.current !== 0) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    };
  }, [bars, trade, tf, afterCost, highlightIdx, themeRev, sizeRev, resetTick]);

  useEffect(() => {
    const box = boxRef.current;
    if (box === null) return;
    const clampView = () => {
      const n = bars.length;
      const cur = viewRef.current;
      const span = clamp(cur.to - cur.from, 16, n + 8);
      const from = clamp(cur.from, -4, n + 4 - span);
      viewRef.current = { from, to: from + span };
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = box.getBoundingClientRect();
      const pw = Math.max(1, rect.width - 78);
      const cur = viewRef.current;
      const span = cur.to - cur.from;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const dx = (e.deltaX / pw) * span;
        viewRef.current = { from: cur.from + dx, to: cur.to + dx };
      } else {
        const k = e.deltaY > 0 ? 1.14 : 1 / 1.14;
        const px = e.clientX - rect.left;
        const at = cur.from + (clamp(px - 10, 0, pw) / pw) * span;
        const ns = clamp(span * k, 16, bars.length + 8);
        const from = at - ((at - cur.from) / span) * ns;
        viewRef.current = { from, to: from + ns };
      }
      clampView();
      scheduleDraw();
    };
    const onMouseUp = () => {
      dragRef.current = null;
    };
    box.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      box.removeEventListener("wheel", onWheel);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [bars.length]);

  const tfName = tf === "D" ? "일봉" : tf === "5" ? "5분봉" : "1분봉";

  return (
    <div
      ref={boxRef}
      className="jrn-chart-box"
      data-testid="journal-candle-chart"
      data-tf={tf}
      onMouseDown={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        dragRef.current = { x: e.clientX - rect.left, from: viewRef.current.from, to: viewRef.current.to };
      }}
      onMouseMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const pw = Math.max(1, rect.width - 78);
        if (dragRef.current !== null) {
          const span = dragRef.current.to - dragRef.current.from;
          const dx = ((dragRef.current.x - x) / pw) * span;
          const n = bars.length;
          const nextSpan = clamp(span, 16, n + 8);
          const nextFrom = clamp(dragRef.current.from + dx, -4, n + 4 - nextSpan);
          viewRef.current = { from: nextFrom, to: nextFrom + nextSpan };
        }
        hoverRef.current = { x, y };
        scheduleDraw();
      }}
      onMouseLeave={() => {
        hoverRef.current = null;
        dragRef.current = null;
        scheduleDraw();
      }}
      onDoubleClick={() => {
        viewRef.current = computeDefaultRange();
        scheduleDraw();
      }}
    >
      <canvas ref={canvasRef} />
      {legend !== null && (
        <div className="jrn-chart-legend">
          <span>{`${tfName}${isAutoTf ? " (자동)" : ""}`}</span>
          <span className="jrn-mono">{legend.dateLabel}</span>
          <span>시<b>{formatWon(legend.o, false)}</b></span>
          <span>고<b className="jrn-up">{formatWon(legend.h, false)}</b></span>
          <span>저<b className="jrn-dn">{formatWon(legend.l, false)}</b></span>
          <span>종<b className={toneClass(legend.chgPct) ? `jrn-${toneClass(legend.chgPct)}` : ""}>{formatWon(legend.c, false)}</b></span>
          <span className={toneClass(legend.chgPct) ? `jrn-${toneClass(legend.chgPct)}` : ""}>{formatPct(legend.chgPct)}</span>
          {legend.fillNote !== "" && <span className="jrn-chart-fill-note">{legend.fillNote}</span>}
        </div>
      )}
    </div>
  );
}
