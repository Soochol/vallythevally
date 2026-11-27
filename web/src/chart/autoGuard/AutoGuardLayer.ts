import type { AutoOrderRule } from "../../api/generated/AutoOrderRule";
import type { AutoOrderType } from "../../api/generated/AutoOrderType";
import type { AutoOrderUpsertInput } from "../../api/generated/AutoOrderUpsertInput";
import { isActiveAutoOrder, useAutoOrdersStore } from "../../stores/autoOrders";
import { useDrawingSession } from "../../stores/drawingSession";
import type { ChartExtension, ChartHost } from "../extensions";
import { snapKrxPrice } from "./tickSnap";

type DragLeg = "sl" | "tp1" | "tp2";

const ORDER_TYPE_LABEL: Record<AutoOrderType, string> = {
  market: "시장가",
  limit: "지정가",
  limit_offset: "현재가-2호가",
};

function toUpsertInput(rule: AutoOrderRule, patch: Partial<AutoOrderUpsertInput>): AutoOrderUpsertInput {
  return {
    symbol: rule.symbol,
    name: rule.name,
    accountRef: rule.accountRef,
    entryPrice: rule.entryPrice,
    quantity: rule.quantity,
    stopLossPrice: patch.stopLossPrice ?? rule.stopLossPrice,
    takeProfit1Price: patch.takeProfit1Price !== undefined ? patch.takeProfit1Price : rule.takeProfit1Price,
    takeProfit2Price: patch.takeProfit2Price ?? rule.takeProfit2Price,
    tp1Ratio: patch.tp1Ratio ?? rule.tp1Ratio,
    breakevenOnTp1: patch.breakevenOnTp1 ?? rule.breakevenOnTp1,
    trailingEnabled: patch.trailingEnabled ?? rule.trailingEnabled,
    trailingPct: patch.trailingPct ?? rule.trailingPct,
    orderType: patch.orderType ?? rule.orderType,
    tickOffset: patch.tickOffset ?? rule.tickOffset,
    paused: patch.paused ?? (rule.state === "paused"),
  };
}

function formatWonMan(diffWon: number): string {
  const man = Math.round(diffWon / 10_000);
  return `${man >= 0 ? "+" : ""}${man.toLocaleString("ko-KR")}만`;
}

function formatPct(price: number, entry: number): string {
  const pct = entry > 0 ? ((price - entry) / entry) * 100 : 0;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

export class AutoGuardLayer implements ChartExtension {
  private readonly root: HTMLDivElement;
  private readonly host: ChartHost;
  private readonly unsubs: Array<() => void> = [];
  private dragState: { leg: DragLeg; rule: AutoOrderRule; price: number } | null = null;
  private popoverLeg: DragLeg | null = null;
  private rafId: number | null = null;

  constructor(host: ChartHost) {
    this.host = host;
    this.root = document.createElement("div");
    this.root.className = "pointer-events-none absolute inset-0 z-[14] overflow-hidden select-none";
    this.root.dataset.testid = "auto-guard-layer";
    host.el.appendChild(this.root);

    this.unsubs.push(useAutoOrdersStore.subscribe(() => this.scheduleRender()));
    this.unsubs.push(useDrawingSession.subscribe(() => this.scheduleRender()));

    const onRange = () => this.scheduleRender();
    host.chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    this.unsubs.push(() => host.chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange));

    const ro = new ResizeObserver(() => this.scheduleRender());
    ro.observe(host.el);
    this.unsubs.push(() => ro.disconnect());

    this.scheduleRender();
  }

  reattach(): void {
    this.scheduleRender();
  }

  dispose(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    for (const unsub of this.unsubs) unsub();
    this.root.remove();
  }

  private scheduleRender(): void {
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.render();
    });
  }

  private activeRule(): AutoOrderRule | null {
    const view = this.host.view();
    if (!view) return null;
    const { rules } = useAutoOrdersStore.getState();
    return rules.find((r) => r.symbol === view.symbol && isActiveAutoOrder(r)) ?? null;
  }

  private render(): void {
    const rule = this.activeRule();
    const drawingTool = useDrawingSession.getState().tool;
    const yieldToDrawing = drawingTool !== null;
    this.root.innerHTML = "";
    if (!rule) return;

    const series = this.host.series();
    const slPrice = this.dragState?.leg === "sl" ? this.dragState.price : rule.stopLossPrice;
    const tp1Price = this.dragState?.leg === "tp1" ? this.dragState.price : rule.takeProfit1Price;
    const tp2Price = this.dragState?.leg === "tp2" ? this.dragState.price : rule.takeProfit2Price;

    const yEntry = series.priceToCoordinate(rule.entryPrice);
    const ySl = series.priceToCoordinate(slPrice);
    const yTp1 = tp1Price !== null && !rule.tp1Done ? series.priceToCoordinate(tp1Price) : null;
    const yTp2 = series.priceToCoordinate(tp2Price);

    if (yEntry !== null) {
      this.appendEntryLine(yEntry, rule.entryPrice);
    }

    if (ySl !== null) {
      this.appendDraggableLine({
        leg: "sl",
        y: ySl,
        color: "#f43f5e",
        label: `SL ${formatPct(slPrice, rule.entryPrice)} | ${formatWonMan((slPrice - rule.entryPrice) * rule.remainingQuantity)} | ${ORDER_TYPE_LABEL[rule.orderType]}${rule.trailingEnabled ? ` · 트레일-${rule.trailingPct}%` : ""}`,
        rule,
        yieldToDrawing,
      });
    }

    if (yTp1 !== null && tp1Price !== null) {
      const q1 = Math.round((rule.quantity * rule.tp1Ratio) / 100);
      this.appendDraggableLine({
        leg: "tp1",
        y: yTp1,
        color: "#10b981",
        label: `TP1 ${formatPct(tp1Price, rule.entryPrice)} | ${formatWonMan((tp1Price - rule.entryPrice) * q1)} | ${rule.tp1Ratio}%${rule.breakevenOnTp1 ? " · 본절" : ""}`,
        rule,
        yieldToDrawing,
      });
    }

    if (yTp2 !== null) {
      const q2 = rule.quantity - Math.round((rule.quantity * rule.tp1Ratio) / 100);
      this.appendDraggableLine({
        leg: "tp2",
        y: yTp2,
        color: "#10b981",
        label: `TP2 ${formatPct(tp2Price, rule.entryPrice)} | ${formatWonMan((tp2Price - rule.entryPrice) * q2)} | ${100 - rule.tp1Ratio}%`,
        rule,
        yieldToDrawing,
      });
    }

    if (this.popoverLeg !== null && !yieldToDrawing) {
      const anchorY = this.popoverLeg === "sl" ? ySl : this.popoverLeg === "tp1" ? yTp1 : yTp2;
      if (anchorY !== null) this.appendPopover(this.popoverLeg, anchorY, rule);
    }
  }

  private appendEntryLine(y: number, entryPrice: number): void {
    const line = document.createElement("div");
    line.style.cssText = `position:absolute;left:0;right:68px;top:${y}px;height:1px;border-top:1px dashed #3b82f6;pointer-events:none;`;
    const tag = document.createElement("span");
    tag.style.cssText = "position:absolute;left:10px;top:-11px;padding:1px 7px;border-radius:5px;background:#3b82f6;color:#fff;font-size:11px;font-weight:700;font-variant-numeric:tabular-nums;";
    tag.textContent = `평단 ${entryPrice.toLocaleString("ko-KR")}`;
    line.appendChild(tag);
    this.root.appendChild(line);
  }

  private appendDraggableLine(opts: {
    leg: DragLeg;
    y: number;
    color: string;
    label: string;
    rule: AutoOrderRule;
    yieldToDrawing: boolean;
  }): void {
    const strip = document.createElement("div");
    strip.dataset.testid = `auto-guard-line-${opts.leg}`;
    strip.style.cssText = `position:absolute;left:0;right:68px;top:${opts.y - 9}px;height:18px;cursor:ns-resize;pointer-events:${opts.yieldToDrawing ? "none" : "auto"};`;

    const bar = document.createElement("div");
    bar.style.cssText = `position:absolute;left:0;right:0;top:8px;height:2px;background:${opts.color};`;
    strip.appendChild(bar);

    const pill = document.createElement("div");
    pill.style.cssText = `position:absolute;right:8px;top:-4px;height:24px;display:inline-flex;align-items:center;border-radius:6px;background:${opts.color};color:#fff;font-size:11px;font-weight:700;font-variant-numeric:tabular-nums;box-shadow:0 3px 10px rgba(0,0,0,0.35);overflow:hidden;`;

    const textBtn = document.createElement("span");
    textBtn.style.cssText = "padding:0 8px;cursor:pointer;";
    textBtn.textContent = opts.label;
    textBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.popoverLeg = this.popoverLeg === opts.leg ? null : opts.leg;
      this.scheduleRender();
    });

    const closeBtn = document.createElement("span");
    closeBtn.style.cssText = "padding:0 7px;border-left:1px solid rgba(255,255,255,0.25);cursor:pointer;";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.popoverLeg = null;
      void useAutoOrdersStore.getState().removeRuleOptimistic(opts.rule.id);
    });

    pill.appendChild(textBtn);
    pill.appendChild(closeBtn);
    strip.appendChild(pill);

    strip.addEventListener("pointerdown", (e) => {
      if (e.target === closeBtn || e.target === textBtn) return;
      e.preventDefault();
      e.stopPropagation();
      this.popoverLeg = null;
      strip.setPointerCapture(e.pointerId);
      const startPrice =
        opts.leg === "sl"
          ? opts.rule.stopLossPrice
          : opts.leg === "tp1"
            ? (opts.rule.takeProfit1Price ?? opts.rule.takeProfit2Price)
            : opts.rule.takeProfit2Price;
      this.dragState = { leg: opts.leg, rule: opts.rule, price: startPrice };

      const onMove = (ev: PointerEvent) => {
        const rect = this.host.el.getBoundingClientRect();
        const raw = this.host.series().coordinateToPrice(ev.clientY - rect.top);
        if (raw === null) return;
        const snapped = snapKrxPrice(Number(raw));
        if (this.dragState) {
          this.dragState.price = snapped;
          this.scheduleRender();
        }
      };

      const onUp = () => {
        strip.removeEventListener("pointermove", onMove);
        strip.removeEventListener("pointerup", onUp);
        const finished = this.dragState;
        this.dragState = null;
        if (!finished) return;
        const patch: Partial<AutoOrderUpsertInput> =
          finished.leg === "sl"
            ? { stopLossPrice: finished.price }
            : finished.leg === "tp1"
              ? { takeProfit1Price: finished.price }
              : { takeProfit2Price: finished.price };
        void useAutoOrdersStore.getState().updateRuleOptimistic(finished.rule.id, toUpsertInput(finished.rule, patch));
      };

      strip.addEventListener("pointermove", onMove);
      strip.addEventListener("pointerup", onUp);
    });

    this.root.appendChild(strip);
  }

  private appendPopover(leg: DragLeg, y: number, rule: AutoOrderRule): void {
    const pop = document.createElement("div");
    pop.style.cssText = `position:absolute;right:80px;top:${Math.max(8, y + 14)}px;width:220px;padding:10px;border-radius:8px;background:var(--surface);border:1px solid var(--line);color:var(--text);font-size:11.5px;box-shadow:0 10px 28px rgba(0,0,0,0.45);pointer-events:auto;z-index:25;`;

    const title = document.createElement("div");
    title.style.cssText = "font-weight:700;margin-bottom:8px;display:flex;justify-content:space-between;";
    title.textContent = leg === "sl" ? "손절 · 트레일링 설정" : "분할 익절 설정";
    pop.appendChild(title);

    if (leg === "sl") {
      const sel = document.createElement("select");
      sel.style.cssText = "width:100%;margin-bottom:6px;padding:4px;border-radius:5px;background:var(--bg);color:inherit;border:1px solid var(--line);";
      for (const [val, lbl] of Object.entries(ORDER_TYPE_LABEL)) {
        const opt = document.createElement("option");
        opt.value = val;
        opt.textContent = lbl;
        opt.selected = rule.orderType === val;
        sel.appendChild(opt);
      }
      sel.addEventListener("change", () => {
        void useAutoOrdersStore.getState().updateRuleOptimistic(rule.id, toUpsertInput(rule, { orderType: sel.value as AutoOrderType }));
      });
      pop.appendChild(sel);

      const trailBtn = document.createElement("button");
      trailBtn.type = "button";
      trailBtn.style.cssText = "width:100%;padding:5px;border-radius:5px;background:var(--bg);color:inherit;border:1px solid var(--line);cursor:pointer;";
      trailBtn.textContent = rule.trailingEnabled ? `트레일링 ON (-${rule.trailingPct}%)` : "트레일링 OFF (켜기)";
      trailBtn.addEventListener("click", () => {
        void useAutoOrdersStore.getState().updateRuleOptimistic(rule.id, toUpsertInput(rule, { trailingEnabled: !rule.trailingEnabled }));
      });
      pop.appendChild(trailBtn);
    } else {
      const beBtn = document.createElement("button");
      beBtn.type = "button";
      beBtn.style.cssText = "width:100%;padding:5px;border-radius:5px;background:var(--bg);color:inherit;border:1px solid var(--line);cursor:pointer;";
      beBtn.textContent = rule.breakevenOnTp1 ? "1차 익절 시 본절 이동: ON" : "1차 익절 시 본절 이동: OFF";
      beBtn.addEventListener("click", () => {
        void useAutoOrdersStore.getState().updateRuleOptimistic(rule.id, toUpsertInput(rule, { breakevenOnTp1: !rule.breakevenOnTp1 }));
      });
      pop.appendChild(beBtn);
    }

    this.root.appendChild(pop);
  }
}

export const createAutoGuardLayer = (host: ChartHost): ChartExtension => new AutoGuardLayer(host);
