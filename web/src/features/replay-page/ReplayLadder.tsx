import {
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { formatPercent, formatPrice } from "../../lib/format";
import { replayGlow } from "../market-window/flash";
import { PRESET_MODES, type PresetMode } from "../order/orderSettings";
import { maxBuyQuantity, quantityForAmount, quantityForRatio, RATIO_PRESETS } from "../order/orderRules";
import type { ReplayEngine, ReplayEngineFrame } from "./replayEngine";
import { type DeltaMode, formatSignedQty, formatWonCompact } from "./replayModel";
import {
  DEFAULT_PAPER_INITIAL_CASH,
  PAPER_AMOUNT_PRESETS_MAN,
  PAPER_CASH_PRESETS_MAN,
  type PaperMarketContext,
  type PaperOrderSide,
  type PaperSummary,
  type ReplayPaperEngine,
} from "./replayPaperEngine";

type OrderClickMode = "single" | "double";

interface Props {
  readonly engine: ReplayEngine;
  readonly paper: ReplayPaperEngine;
  readonly previousClose: number | null;
  readonly tickStepOf: (price: number) => number;
  readonly deltaMode: DeltaMode;
  readonly onDeltaMode: (mode: DeltaMode) => void;
  readonly onUndoRewind: () => void;
}

const DAY_TAG_LABEL = {
  open: { short: "시", title: "시가" },
  high: { short: "고", title: "고가" },
  low: { short: "저", title: "저가" },
} as const;

const ROW_INDICES = Array.from({ length: 20 }, (_, i) => i);
const DEFAULT_SIM_QTY = 50;
const MAN_WON = 10_000;

interface DragView {
  readonly side: PaperOrderSide;
  readonly fromPrice: number;
  readonly quantity: number;
  readonly x: number;
  readonly y: number;
  readonly targetPrice: number | null;
  readonly outside: boolean;
}

interface ContextMenuState {
  readonly x: number;
  readonly y: number;
  readonly side: PaperOrderSide | null;
  readonly price: number | null;
}

interface RowRefs {
  row: HTMLDivElement | null;
  sellCell: HTMLDivElement | null;
  sellPreview: HTMLSpanElement | null;
  askCell: HTMLDivElement | null;
  askBar: HTMLElement | null;
  askGlow: HTMLElement | null;
  askDelta: HTMLSpanElement | null;
  askVal: HTMLSpanElement | null;
  pxCell: HTMLDivElement | null;
  pxTag: HTMLElement | null;
  pxMark: HTMLElement | null;
  pxNum: HTMLSpanElement | null;
  pxRate: HTMLSpanElement | null;
  bidCell: HTMLDivElement | null;
  bidBar: HTMLElement | null;
  bidGlow: HTMLElement | null;
  bidVal: HTMLSpanElement | null;
  bidDelta: HTMLSpanElement | null;
  buyCell: HTMLDivElement | null;
  buyPreview: HTMLSpanElement | null;
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

export function ReplayLadder({
  engine,
  paper,
  previousClose,
  tickStepOf,
  deltaMode,
  onDeltaMode,
  onUndoRewind,
}: Props) {
  const [clickMode, setClickMode] = useState<OrderClickMode>("single");
  const [cashInputMan, setCashInputMan] = useState(String(DEFAULT_PAPER_INITIAL_CASH / MAN_WON));
  const [qtyInput, setQtyInput] = useState(String(DEFAULT_SIM_QTY));
  const [presetMode, setPresetMode] = useState<PresetMode>("amount");
  const [pickedPreset, setPickedPreset] = useState<string | null>(null);
  const [paperTick, setPaperTick] = useState(0);
  const [refPrice, setRefPrice] = useState<number | null>(() => referencePriceOf(engine.getFrame()));
  const [dragView, setDragView] = useState<DragView | null>(null);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);

  const ladderScrollRef = useRef<HTMLDivElement>(null);
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

  const pnlQtyRef = useRef<HTMLElement>(null);
  const pnlSellRemainRef = useRef<HTMLElement>(null);
  const pnlAvgRef = useRef<HTMLElement>(null);
  const pnlUnrealCellRef = useRef<HTMLDivElement>(null);
  const pnlUnrealRef = useRef<HTMLElement>(null);
  const pnlRealCellRef = useRef<HTMLDivElement>(null);
  const pnlRealRef = useRef<HTMLElement>(null);
  const pnlAvailRef = useRef<HTMLElement>(null);
  const pnlEquityCellRef = useRef<HTMLDivElement>(null);
  const pnlEquityRef = useRef<HTMLElement>(null);

  const rowPricesRef = useRef<(number | null)[]>(ROW_INDICES.map(() => null));
  const prevRowQtyRef = useRef<Map<string, number>>(new Map());
  const qtyNumRef = useRef<number>(DEFAULT_SIM_QTY);
  const dragOriginRef = useRef<{
    readonly side: PaperOrderSide;
    readonly fromPrice: number;
    readonly quantity: number;
    readonly startX: number;
    readonly startY: number;
    active: boolean;
  } | null>(null);
  const dragViewRef = useRef<DragView | null>(null);

  const rowRefs = useRef<RowRefs[]>(
    ROW_INDICES.map(() => ({
      row: null,
      sellCell: null,
      sellPreview: null,
      askCell: null,
      askBar: null,
      askGlow: null,
      askDelta: null,
      askVal: null,
      pxCell: null,
      pxTag: null,
      pxMark: null,
      pxNum: null,
      pxRate: null,
      bidCell: null,
      bidBar: null,
      bidGlow: null,
      bidVal: null,
      bidDelta: null,
      buyCell: null,
      buyPreview: null,
    })),
  );

  const parsedQty = useMemo(() => {
    const n = Math.floor(Number(qtyInput));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [qtyInput]);

  useEffect(() => {
    qtyNumRef.current = parsedQty;
  }, [parsedQty]);

  useEffect(() => {
    return paper.subscribe(() => setPaperTick((t) => t + 1));
  }, [paper]);

  const summary: PaperSummary = useMemo(
    () => paper.getSummary(refPrice),
    [paper, refPrice, paperTick],
  );

  const openOrderQtyByKey = useMemo(() => {
    const map = new Map<string, number>();
    for (const o of summary.openOrders) {
      const k = `${o.side}:${o.price}`;
      map.set(k, (map.get(k) ?? 0) + o.quantity);
    }
    return map;
  }, [summary.openOrders]);

  const totalSellOpenQty = useMemo(
    () => summary.openOrders.filter((o) => o.side === "sell").reduce((s, o) => s + o.quantity, 0),
    [summary.openOrders],
  );

  const totalBuyOpenQty = useMemo(
    () => summary.openOrders.filter((o) => o.side === "buy").reduce((s, o) => s + o.quantity, 0),
    [summary.openOrders],
  );

  const applyPnlDom = useCallback(
    (markPrice: number | null) => {
      const s = paper.getSummary(markPrice);
      setText(pnlQtyRef.current, `${formatPrice(s.quantity, false)}주`);
      setText(
        pnlSellRemainRef.current,
        s.reservedSellQuantity > 0 ? `가능 ${formatPrice(s.sellableQuantity, false)}` : "",
      );
      setText(pnlAvgRef.current, s.quantity > 0 ? `${formatPrice(Math.round(s.avgPrice), false)}원` : "-");

      const uTone = s.unrealizedPnl > 0 ? "up" : s.unrealizedPnl < 0 ? "down" : null;
      setAttr(pnlUnrealCellRef.current, "data-tone", uTone);
      setText(pnlUnrealRef.current, `${formatSignedQty(s.unrealizedPnl)}원 (${formatPercent(s.unrealizedPct)})`);

      const rTone = s.realizedPnl > 0 ? "up" : s.realizedPnl < 0 ? "down" : null;
      setAttr(pnlRealCellRef.current, "data-tone", rTone);
      setText(pnlRealRef.current, `${formatSignedQty(s.realizedPnl)}원`);

      setText(pnlAvailRef.current, `${formatPrice(s.availableCash, false)}원`);

      const eqTone = s.totalReturn > 0 ? "up" : s.totalReturn < 0 ? "down" : null;
      setAttr(pnlEquityCellRef.current, "data-tone", eqTone);
      setText(pnlEquityRef.current, `${formatWonCompact(s.totalEquity)} (${formatPercent(s.totalReturnPct)})`);
    },
    [paper],
  );

  useEffect(() => {
    const apply = (frame: ReplayEngineFrame) => {
      const snapshot = frame.ladder;
      const markPrice = referencePriceOf(frame);
      setRefPrice((prev) => (prev === markPrice ? prev : markPrice));
      applyPnlDom(markPrice);

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

      const holding = paper.getHolding();
      const step = holding.avgPrice > 0 ? tickStepOf(holding.avgPrice) : 0;
      const avgRounded = holding.quantity > 0 && step > 0
        ? Math.round(holding.avgPrice / step) * step
        : null;
      const availCash = paper.getAvailableCash();
      const sellable = paper.getSellableQuantity();
      const previewQty = qtyNumRef.current;
      const perfNow = typeof performance !== "undefined" ? performance.now() : Date.now();
      const nextBookMap = new Map<string, number>();

      for (let i = 0; i < 20; i++) {
        const refs = rowRefs.current[i]!;
        const row = snapshot.rows[i]!;
        rowPricesRef.current[i] = row.price;

        setAttr(refs.row, "data-side", row.side);
        setAttr(refs.row, "data-dim", row.dimmed ? "true" : null);
        setAttr(refs.row, "data-current", row.current ? "true" : null);
        setAttr(refs.row, "data-last-hit", row.lastHit);
        setAttr(
          refs.row,
          "data-sim-fill",
          row.price !== null && paper.isPriceFillFlashing(row.price, perfNow) ? "true" : null,
        );

        setAttr(refs.sellCell, "data-price", row.price !== null ? String(row.price) : null);
        setAttr(refs.sellCell, "data-empty", row.price === null || snapshot.inGap ? "" : null);
        setAttr(refs.buyCell, "data-price", row.price !== null ? String(row.price) : null);
        setAttr(refs.buyCell, "data-empty", row.price === null || snapshot.inGap ? "" : null);

        if (row.price !== null && !snapshot.inGap && previewQty > 0) {
          setText(refs.sellPreview, `매도 ${formatPrice(previewQty, false)}`);
          setAttr(refs.sellPreview, "data-over", previewQty > sellable ? "" : null);
          setText(refs.buyPreview, `매수 ${formatPrice(previewQty, false)}`);
          setAttr(refs.buyPreview, "data-over", row.price * previewQty > availCash ? "" : null);
        } else {
          setText(refs.sellPreview, "");
          setAttr(refs.sellPreview, "data-over", null);
          setText(refs.buyPreview, "");
          setAttr(refs.buyPreview, "data-over", null);
        }

        const priceTone = row.price === null || previousClose === null || previousClose <= 0
          ? ""
          : row.price > previousClose
            ? "mw-up"
            : row.price < previousClose
              ? "mw-down"
              : "";
        if (refs.pxCell) {
          const cls = priceTone ? `mw-px ${priceTone}` : "mw-px";
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
        if (refs.pxMark) {
          const showMark = avgRounded !== null && row.price === avgRounded;
          refs.pxMark.hidden = !showMark;
          setAttr(refs.pxMark, "data-testid", showMark ? "replay-sim-avg-dot" : null);
          setAttr(refs.pxMark, "title", showMark ? `매입평단가 ${formatPrice(Math.round(holding.avgPrice), false)}원` : null);
        }
        setText(refs.pxNum, row.price !== null ? formatPrice(row.price, false) : "—");
        setText(refs.pxRate, row.rate !== null ? formatPercent(row.rate) : "");

        const deltaText = row.delta !== 0 ? formatSignedQty(row.delta) : "";
        const deltaFlash = row.delta > 0 ? "up" : row.delta < 0 ? "down" : null;
        const levelKey = row.price !== null ? `${row.side}:${row.price}` : null;
        if (levelKey !== null) nextBookMap.set(levelKey, row.quantity);
        const prevQty = levelKey !== null ? prevRowQtyRef.current.get(levelKey) : undefined;
        const qtyChanged = prevQty !== undefined && prevQty !== row.quantity;
        const flash = levelKey ? frame.cellFlashes.get(levelKey) : undefined;

        if (row.side === "ask") {
          setAttr(refs.askCell, "data-wall", row.wall ? "true" : null);
          if (refs.askBar) {
            const tr = `scaleX(${row.price !== null ? row.ratio.toFixed(3) : 0})`;
            if (refs.askBar.style.transform !== tr) refs.askBar.style.transform = tr;
          }
          if (qtyChanged || flash !== undefined) replayGlow(refs.askGlow);
          setText(refs.askDelta, deltaText);
          setAttr(refs.askDelta, "data-flash", deltaFlash);
          setText(refs.askVal, row.price !== null ? formatPrice(row.quantity, false) : "");

          setAttr(refs.bidCell, "data-wall", null);
          if (refs.bidBar && refs.bidBar.style.transform !== "scaleX(0)") refs.bidBar.style.transform = "scaleX(0)";
          setText(refs.bidVal, "");
          setText(refs.bidDelta, "");
          setAttr(refs.bidDelta, "data-flash", null);
        } else {
          setAttr(refs.bidCell, "data-wall", row.wall ? "true" : null);
          if (refs.bidBar) {
            const tr = `scaleX(${row.price !== null ? row.ratio.toFixed(3) : 0})`;
            if (refs.bidBar.style.transform !== tr) refs.bidBar.style.transform = tr;
          }
          if (qtyChanged || flash !== undefined) replayGlow(refs.bidGlow);
          setText(refs.bidVal, row.price !== null ? formatPrice(row.quantity, false) : "");
          setText(refs.bidDelta, deltaText);
          setAttr(refs.bidDelta, "data-flash", deltaFlash);

          setAttr(refs.askCell, "data-wall", null);
          if (refs.askBar && refs.askBar.style.transform !== "scaleX(0)") refs.askBar.style.transform = "scaleX(0)";
          setText(refs.askVal, "");
          setText(refs.askDelta, "");
          setAttr(refs.askDelta, "data-flash", null);
        }
      }

      prevRowQtyRef.current = nextBookMap;

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

    const unsubFrame = engine.subscribeFrame(apply);
    const unsubPaper = paper.subscribe(() => apply(engine.getFrame()));
    return () => {
      unsubFrame();
      unsubPaper();
    };
  }, [engine, paper, previousClose, tickStepOf, applyPnlDom, parsedQty]);

  useEffect(() => {
    const onPointerMove = (e: globalThis.PointerEvent) => {
      const origin = dragOriginRef.current;
      if (!origin) return;
      if (!origin.active && Math.hypot(e.clientX - origin.startX, e.clientY - origin.startY) > 5) {
        origin.active = true;
      }
      if (!origin.active) return;

      const wrap = ladderScrollRef.current;
      const rect = wrap?.getBoundingClientRect();
      const outside = rect
        ? e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom
        : true;
      let targetPrice: number | null = null;
      if (!outside) {
        const under = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>(".od-cell[data-order-cell]");
        if (under && under.dataset.side === origin.side) {
          const p = Number(under.dataset.price);
          if (Number.isFinite(p) && p > 0 && p !== origin.fromPrice) {
            targetPrice = p;
          }
        }
      }
      const next: DragView = {
        side: origin.side,
        fromPrice: origin.fromPrice,
        quantity: origin.quantity,
        x: e.clientX,
        y: e.clientY,
        targetPrice,
        outside,
      };
      dragViewRef.current = next;
      setDragView(next);
    };

    const onPointerUp = () => {
      const origin = dragOriginRef.current;
      const view = dragViewRef.current;
      dragOriginRef.current = null;
      dragViewRef.current = null;
      setDragView(null);
      if (!origin || !origin.active || !view) return;
      const frame = engine.getFrame();
      if (view.outside) {
        paper.cancelOrdersAtPrice(origin.side, origin.fromPrice, frame.cursorMs);
      } else if (view.targetPrice !== null) {
        paper.modifyOrdersAtPrice(origin.side, origin.fromPrice, view.targetPrice, marketContextOf(frame));
      }
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [engine, paper]);

  useEffect(() => {
    if (ctxMenu === null) return;
    const close = () => setCtxMenu(null);
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  const handleOrderCellEvent = (side: PaperOrderSide, rowIndex: number, trigger: OrderClickMode, e: MouseEvent) => {
    if (trigger !== clickMode) return;
    if ((e.target as HTMLElement).closest(".od-chip")) return;
    const price = rowPricesRef.current[rowIndex] ?? null;
    const frame = engine.getFrame();
    if (price === null || frame.inGap) return;
    paper.placeOrder(side, price, parsedQty, marketContextOf(frame));
  };

  const startChipDrag = (side: PaperOrderSide, price: number, quantity: number, e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragOriginRef.current = {
      side,
      fromPrice: price,
      quantity,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
    };
  };

  const openChipMenu = (side: PaperOrderSide, price: number, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, side, price });
  };

  const openLadderMenu = (e: MouseEvent) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, side: null, price: null });
  };

  const handleCashPreset = (man: number) => {
    setCashInputMan(String(man));
    paper.reset(man * MAN_WON, engine.getFrame().cursorMs);
  };

  const handleCashInputCommit = () => {
    const parsed = Math.floor(Number(cashInputMan.replace(/[^0-9]/g, "")));
    const clamped = Number.isFinite(parsed) && parsed >= 100 ? Math.min(1_000_000, parsed) : DEFAULT_PAPER_INITIAL_CASH / MAN_WON;
    setCashInputMan(String(clamped));
    paper.reset(clamped * MAN_WON, engine.getFrame().cursorMs);
  };

  const handleQtyChange = (e: ChangeEvent<HTMLInputElement>) => {
    setQtyInput(e.target.value.replace(/[^0-9]/g, ""));
    setPickedPreset(null);
  };

  const handleQtyKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const step = (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : 1);
    setPickedPreset(null);
    setQtyInput(String(Math.max(1, (Number(qtyInput) || 0) + step)));
  };

  const presetButtons = useMemo(() => {
    if (presetMode === "amount") {
      return PAPER_AMOUNT_PRESETS_MAN.map((man) => {
        const qty = quantityForAmount(man * MAN_WON, refPrice) ?? 0;
        return {
          key: `amount:${man}`,
          label: man >= 1_000 ? `${man / 1_000}천만` : `${man}만`,
          qty,
          disabled: qty <= 0,
        };
      });
    }
    if (presetMode === "buy") {
      const maxQ = refPrice !== null && refPrice > 0 ? maxBuyQuantity(refPrice, summary.availableCash) : 0;
      return RATIO_PRESETS.map(({ percent, label }) => {
        const qty = quantityForRatio(maxQ, percent);
        return { key: `buy:${percent}`, label, qty, disabled: qty <= 0 };
      });
    }
    const sellable = summary.sellableQuantity;
    return RATIO_PRESETS.map(({ percent, label }) => {
      const qty = quantityForRatio(sellable, percent);
      return { key: `sell:${percent}`, label, qty, disabled: qty <= 0 };
    });
  }, [presetMode, refPrice, summary.availableCash, summary.sellableQuantity]);

  const ctxOrders = ctxMenu && ctxMenu.side !== null && ctxMenu.price !== null
    ? summary.openOrders.filter((o) => o.side === ctxMenu.side && o.price === ctxMenu.price)
    : [];

  return (
    <section className="rp-col" aria-label="10호가 사다리" data-testid="replay-ladder">
      <div className="rp-pane-head">
        <div className="rp-pane-title">
          <span>호가주문 시뮬레이터</span>
          <span ref={spreadRef} className="rp-badge-mini" data-testid="replay-spread">—</span>
        </div>
        <div className="rp-pane-controls">
          <div className="rp-seg" role="group" aria-label="주문 클릭 방식">
            <button type="button" aria-pressed={clickMode === "single"} onClick={() => setClickMode("single")}>원클릭</button>
            <button type="button" aria-pressed={clickMode === "double"} onClick={() => setClickMode("double")}>더블클릭</button>
          </div>
          <div className="rp-seg" role="group" aria-label="델타 표시 기준">
            <button type="button" aria-pressed={deltaMode === "tick"} onClick={() => onDeltaMode("tick")}>직전 틱 델타</button>
            <button type="button" aria-pressed={deltaMode === "min"} onClick={() => onDeltaMode("min")}>1분 누적 델타</button>
            <button type="button" aria-pressed={deltaMode === "off"} onClick={() => onDeltaMode("off")}>끄기</button>
          </div>
        </div>
      </div>

      <div className="rp-sim-account" data-testid="replay-sim-account">
        <div className="rp-sim-cap-group">
          <span className="rp-sim-cap-label">예수금</span>
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
        <div className="rp-sim-cap-actions">
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
          <button
            type="button"
            className="rp-sim-mini-btn"
            data-danger=""
            data-testid="replay-sim-reset"
            onClick={() => paper.reset(undefined, engine.getFrame().cursorMs)}
          >
            초기화
          </button>
        </div>
      </div>

      <div className="rp-sim-pnl rp-mono" data-testid="replay-sim-pnl">
        <button
          type="button"
          className="od-cellbtn"
          data-testid="replay-sim-qty-btn"
          disabled={summary.sellableQuantity <= 0}
          title="클릭 시 매도 가능 전량을 수량칸에 채움"
          onClick={() => {
            if (summary.sellableQuantity > 0) {
              setQtyInput(String(summary.sellableQuantity));
              setPickedPreset(null);
            }
          }}
        >
          <small>
            <span>보유수량</span>
            <i ref={pnlSellRemainRef} className="od-remaining" />
          </small>
          <b ref={pnlQtyRef} data-testid="replay-sim-qty">0주</b>
        </button>
        <div className="od-cellbtn">
          <small>매입평단가</small>
          <b ref={pnlAvgRef} data-testid="replay-sim-avg">-</b>
        </div>
        <div ref={pnlUnrealCellRef} className="od-cellbtn">
          <small>평가손익</small>
          <b ref={pnlUnrealRef} data-testid="replay-sim-unreal">0원 (0.00%)</b>
        </div>
        <div ref={pnlRealCellRef} className="od-cellbtn">
          <small>실현손익</small>
          <b ref={pnlRealRef} data-testid="replay-sim-real">0원</b>
        </div>
        <div className="od-cellbtn">
          <small>주문가능 현금</small>
          <b ref={pnlAvailRef} data-testid="replay-sim-avail">{`${formatPrice(summary.availableCash, false)}원`}</b>
        </div>
        <div ref={pnlEquityCellRef} className="od-cellbtn">
          <small>총 자산 (수익률)</small>
          <b ref={pnlEquityRef} data-testid="replay-sim-equity">{`${formatWonCompact(summary.totalEquity)} (0.00%)`}</b>
        </div>
      </div>

      <div className="od-qty rp-sim-qty-row" data-testid="replay-sim-quantity-row">
        <input
          className="od-qty-input rp-mono"
          data-testid="replay-sim-qty-input"
          aria-label="가상 주문 수량"
          inputMode="numeric"
          autoComplete="off"
          value={qtyInput}
          onChange={handleQtyChange}
          onKeyDown={handleQtyKeyDown}
        />
        <div className="ui-seg od-preset-mode" data-size="sm" role="group" aria-label="프리셋 기준">
          {PRESET_MODES.map((option) => (
            <button
              key={option.value}
              type="button"
              className="ui-seg-item"
              data-mode={option.value}
              aria-pressed={presetMode === option.value}
              onClick={() => {
                setPresetMode(option.value);
                setPickedPreset(null);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="od-presets rp-mono" role="group" aria-label="주문 수량 프리셋">
          {presetButtons.map((btn) => (
            <button
              key={btn.key}
              type="button"
              className="od-preset"
              data-side-tone={presetMode === "amount" ? undefined : presetMode}
              data-picked={pickedPreset === btn.key ? "" : undefined}
              disabled={btn.disabled}
              title={`${formatPrice(btn.qty, false)}주`}
              onClick={() => {
                setPickedPreset(btn.key);
                setQtyInput(String(btn.qty));
              }}
            >
              {btn.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="rp-sim-flatten"
          data-testid="replay-sim-flatten"
          disabled={summary.quantity <= 0}
          title="현재 매수 1호가로 보유 전량 즉시 청산"
          onClick={() => paper.flattenPosition(marketContextOf(engine.getFrame()))}
        >
          시장가 청산
        </button>
      </div>

      <div ref={gapBannerRef} className="rp-banner" data-mode="gap" role="status" data-testid="replay-gap-banner" hidden>
        <span>수집기 연결 끊김 구간 — 이 시각 호가·체결이 비어 있습니다</span>
        <span className="rp-mono">수집 끊김</span>
      </div>
      <div ref={viBannerRef} className="rp-banner" data-mode="vi" role="status" data-testid="replay-vi-banner" hidden>
        <span>단일가 호가 (VI · 동시호가 3단 이하)</span>
        <span className="rp-mono">단일가</span>
      </div>

      <div className="od-colhead rp-order-colhead">
        <span>매도주문</span>
        <span>매도잔량</span>
        <span>호가 · 등락률</span>
        <span>매수잔량</span>
        <span>매수주문</span>
      </div>

      <div
        ref={ladderScrollRef}
        className="od-ladder rp-order-ladder"
        data-divider=""
        data-dragging={dragView ? "" : undefined}
        onContextMenu={openLadderMenu}
      >
        <div className="mw-ladder rp-order-mw-ladder rp-mono">
          {ROW_INDICES.map((idx) => {
            const rowPrice = rowPricesRef.current[idx] ?? null;
            const sellOpenQty = rowPrice !== null ? (openOrderQtyByKey.get(`sell:${rowPrice}`) ?? 0) : 0;
            const buyOpenQty = rowPrice !== null ? (openOrderQtyByKey.get(`buy:${rowPrice}`) ?? 0) : 0;
            const sellTargeted = dragView !== null && !dragView.outside && dragView.side === "sell" && rowPrice !== null && dragView.targetPrice === rowPrice;
            const buyTargeted = dragView !== null && !dragView.outside && dragView.side === "buy" && rowPrice !== null && dragView.targetPrice === rowPrice;
            const sellChipDragging = dragView !== null && dragView.side === "sell" && rowPrice !== null && dragView.fromPrice === rowPrice;
            const buyChipDragging = dragView !== null && dragView.side === "buy" && rowPrice !== null && dragView.fromPrice === rowPrice;

            return (
              <div
                key={idx}
                ref={(el) => {
                  rowRefs.current[idx]!.row = el;
                }}
                className="mw-lr rp-order-row"
                data-side={idx < 10 ? "ask" : "bid"}
              >
                <div
                  ref={(el) => {
                    rowRefs.current[idx]!.sellCell = el;
                  }}
                  className="od-cell"
                  data-order-cell=""
                  data-side="sell"
                  data-target={sellTargeted ? "" : undefined}
                  data-testid="replay-sim-sell-cell"
                  onClick={(e) => handleOrderCellEvent("sell", idx, "single", e)}
                  onDoubleClick={(e) => handleOrderCellEvent("sell", idx, "double", e)}
                >
                  {sellOpenQty > 0 && rowPrice !== null ? (
                    <button
                      type="button"
                      className="od-chip"
                      data-testid="replay-sim-chip"
                      data-side="sell"
                      data-price={rowPrice}
                      data-dragging={sellChipDragging ? "" : undefined}
                      onPointerDown={(e) => startChipDrag("sell", rowPrice, sellOpenQty, e)}
                      onContextMenu={(e) => openChipMenu("sell", rowPrice, e)}
                    >
                      {formatPrice(sellOpenQty, false)}
                    </button>
                  ) : null}
                  <span
                    ref={(el) => {
                      rowRefs.current[idx]!.sellPreview = el;
                    }}
                    className="od-preview rp-order-preview"
                    hidden={sellOpenQty > 0}
                  />
                </div>

                <div
                  ref={(el) => {
                    rowRefs.current[idx]!.askCell = el;
                  }}
                  className="mw-qty"
                  data-side="ask"
                >
                  <i
                    ref={(el) => {
                      rowRefs.current[idx]!.askBar = el;
                    }}
                    className="mw-qty-bar"
                    style={{ transform: "scaleX(0)" }}
                  >
                    <b
                      ref={(el) => {
                        rowRefs.current[idx]!.askGlow = el;
                      }}
                      className="mw-qty-glow"
                    />
                  </i>
                  <span
                    ref={(el) => {
                      rowRefs.current[idx]!.askDelta = el;
                    }}
                    className="mw-qty-change"
                  />
                  <span
                    ref={(el) => {
                      rowRefs.current[idx]!.askVal = el;
                    }}
                    className="mw-qty-value"
                  />
                </div>

                <div
                  ref={(el) => {
                    rowRefs.current[idx]!.pxCell = el;
                  }}
                  className="mw-px"
                >
                  <span className="mw-px-tags">
                    <i
                      ref={(el) => {
                        rowRefs.current[idx]!.pxTag = el;
                      }}
                      className="mw-px-tag"
                      hidden
                    />
                  </span>
                  <span className="mw-px-num">
                    <i
                      ref={(el) => {
                        rowRefs.current[idx]!.pxMark = el;
                      }}
                      className="mw-px-mark"
                      hidden
                    />
                    <span
                      ref={(el) => {
                        rowRefs.current[idx]!.pxNum = el;
                      }}
                    >
                      —
                    </span>
                  </span>
                  <small
                    ref={(el) => {
                      rowRefs.current[idx]!.pxRate = el;
                    }}
                  />
                </div>

                <div
                  ref={(el) => {
                    rowRefs.current[idx]!.bidCell = el;
                  }}
                  className="mw-qty"
                  data-side="bid"
                >
                  <i
                    ref={(el) => {
                      rowRefs.current[idx]!.bidBar = el;
                    }}
                    className="mw-qty-bar"
                    style={{ transform: "scaleX(0)" }}
                  >
                    <b
                      ref={(el) => {
                        rowRefs.current[idx]!.bidGlow = el;
                      }}
                      className="mw-qty-glow"
                    />
                  </i>
                  <span
                    ref={(el) => {
                      rowRefs.current[idx]!.bidVal = el;
                    }}
                    className="mw-qty-value"
                  />
                  <span
                    ref={(el) => {
                      rowRefs.current[idx]!.bidDelta = el;
                    }}
                    className="mw-qty-change"
                  />
                </div>

                <div
                  ref={(el) => {
                    rowRefs.current[idx]!.buyCell = el;
                  }}
                  className="od-cell"
                  data-order-cell=""
                  data-side="buy"
                  data-target={buyTargeted ? "" : undefined}
                  data-testid="replay-sim-buy-cell"
                  onClick={(e) => handleOrderCellEvent("buy", idx, "single", e)}
                  onDoubleClick={(e) => handleOrderCellEvent("buy", idx, "double", e)}
                >
                  {buyOpenQty > 0 && rowPrice !== null ? (
                    <button
                      type="button"
                      className="od-chip"
                      data-testid="replay-sim-chip"
                      data-side="buy"
                      data-price={rowPrice}
                      data-dragging={buyChipDragging ? "" : undefined}
                      onPointerDown={(e) => startChipDrag("buy", rowPrice, buyOpenQty, e)}
                      onContextMenu={(e) => openChipMenu("buy", rowPrice, e)}
                    >
                      {formatPrice(buyOpenQty, false)}
                    </button>
                  ) : null}
                  <span
                    ref={(el) => {
                      rowRefs.current[idx]!.buyPreview = el;
                    }}
                    className="od-preview rp-order-preview"
                    hidden={buyOpenQty > 0}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="od-totals rp-order-totals">
        <button
          type="button"
          className="od-total rp-mono"
          data-side="sell"
          data-empty={totalSellOpenQty === 0 ? "" : undefined}
          title="클릭 시 매도 미체결 일괄 취소"
          onClick={() => paper.cancelOrdersBySide("sell", engine.getFrame().cursorMs)}
        >
          {formatPrice(totalSellOpenQty, false)}
        </button>
        <div
          className="rp-sim-status"
          data-testid="replay-sim-status"
          data-tone={summary.status.tone}
        >
          <span className="rp-sim-status-text">{summary.status.text}</span>
          {summary.lastRewindUndo !== null && (
            <button
              type="button"
              className="rp-sim-undo-btn"
              data-testid="replay-sim-undo-rewind"
              onClick={onUndoRewind}
            >
              실행 취소
            </button>
          )}
        </div>
        <button
          type="button"
          className="od-total rp-mono"
          data-side="buy"
          data-empty={totalBuyOpenQty === 0 ? "" : undefined}
          title="클릭 시 매수 미체결 일괄 취소"
          onClick={() => paper.cancelOrdersBySide("buy", engine.getFrame().cursorMs)}
        >
          {formatPrice(totalBuyOpenQty, false)}
        </button>
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

      {dragView && (
        <div
          className="od-ghost rp-mono"
          data-side={dragView.side}
          data-cancel={dragView.outside ? "" : undefined}
          style={{ left: `${dragView.x}px`, top: `${dragView.y}px` }}
        >
          {dragView.outside
            ? `놓으면 ${formatPrice(dragView.fromPrice, false)}원 ${dragView.side === "buy" ? "매수" : "매도"} 취소`
            : dragView.targetPrice !== null
              ? `${dragView.side === "buy" ? "매수" : "매도"} ${formatPrice(dragView.quantity, false)}주 → ${formatPrice(dragView.targetPrice, false)}원 정정`
              : `${dragView.side === "buy" ? "매수" : "매도"} ${formatPrice(dragView.fromPrice, false)}원 (${formatPrice(dragView.quantity, false)}주)`}
        </div>
      )}

      {ctxMenu && (
        <div
          className="rp-ctx-menu"
          role="menu"
          style={{
            left: `${Math.min(typeof window !== "undefined" ? window.innerWidth - 190 : ctxMenu.x, ctxMenu.x)}px`,
            top: `${Math.min(typeof window !== "undefined" ? window.innerHeight - 160 : ctxMenu.y, ctxMenu.y)}px`,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {ctxMenu.side !== null && ctxMenu.price !== null ? (
            <>
              <div className="rp-ctx-head rp-mono">
                {`${formatPrice(ctxMenu.price, false)}원 ${ctxMenu.side === "buy" ? "매수" : "매도"} (${ctxOrders.length}건)`}
              </div>
              {ctxOrders.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setCtxMenu(null);
                    paper.cancelOrderById(o.id, engine.getFrame().cursorMs);
                  }}
                >
                  {`${formatPrice(o.quantity, false)}주 취소`}
                </button>
              ))}
              <button
                type="button"
                role="menuitem"
                data-danger=""
                onClick={() => {
                  setCtxMenu(null);
                  paper.cancelOrdersAtPrice(ctxMenu.side!, ctxMenu.price!, engine.getFrame().cursorMs);
                }}
              >
                이 가격 모두 취소
              </button>
            </>
          ) : (
            <>
              <div className="rp-ctx-head">미체결 일괄 관리</div>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setCtxMenu(null);
                  paper.cancelOrdersBySide("buy", engine.getFrame().cursorMs);
                }}
              >
                {`매수 모두 취소 (${summary.openOrders.filter((o) => o.side === "buy").length}건)`}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setCtxMenu(null);
                  paper.cancelOrdersBySide("sell", engine.getFrame().cursorMs);
                }}
              >
                {`매도 모두 취소 (${summary.openOrders.filter((o) => o.side === "sell").length}건)`}
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
