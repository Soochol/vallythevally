import { useEffect, useRef, useState } from "react";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { usePublicMode } from "../../public-mode/serverMode";
import { isActiveAutoOrder, useAutoOrdersStore } from "../../stores/autoOrders";
import { useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";

export function AutoGuardBadge() {
  const publicMode = usePublicMode();
  const loaded = useAutoOrdersStore((s) => s.loaded);
  const masterEnabled = useAutoOrdersStore((s) => s.masterEnabled);
  const rules = useAutoOrdersStore((s) => s.rules);
  const load = useAutoOrdersStore((s) => s.load);
  const toggleMaster = useAutoOrdersStore((s) => s.toggleMaster);
  const activeCell = useSelectionStore((s) => s.activeCell);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!publicMode && !loaded) void load();
  }, [publicMode, loaded, load]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  if (publicMode) return null;
  const activeRules = rules.filter(isActiveAutoOrder);
  if (activeRules.length === 0) return null;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-testid="auto-guard-badge"
        className="tb-btn"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
      >
        <span
          className={`inline-block h-2 w-2 rounded-full ${masterEnabled ? "bg-accent" : "bg-warning"}`}
        />
        <span>자동감시 {activeRules.length}</span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="자동감시 종목 목록"
          className="absolute right-0 top-[calc(100%+6px)] z-50 w-72 rounded-m border border-border bg-surface p-3 shadow-dialog"
        >
          <div className="mb-2 flex items-center justify-between border-b border-border pb-2 text-s font-semibold">
            <span>자동 손절·익절 감시</span>
            <button
              type="button"
              className="rounded-s border border-border px-2 py-0.5 text-xs"
              onClick={() => void toggleMaster(!masterEnabled)}
            >
              {masterEnabled ? "마스터 ON" : "마스터 OFF"}
            </button>
          </div>
          <div className="flex flex-col gap-1.5">
            {activeRules.map((rule) => (
              <button
                key={rule.id}
                type="button"
                className="flex flex-col rounded-s border border-border bg-surface-2 px-2.5 py-2 text-left hover:border-accent"
                onClick={() => {
                  useLayoutStore.getState().setSymbol(activeCell, { code: rule.symbol as SymbolCode });
                  setOpen(false);
                }}
              >
                <div className="flex w-full items-center justify-between text-s font-semibold">
                  <span>{rule.name}</span>
                  <span className="tabular-nums text-xs text-text-2">{rule.remainingQuantity}주</span>
                </div>
                <div className="mt-1 flex w-full justify-between tabular-nums text-xs">
                  <span className="text-warning">SL {rule.stopLossPrice.toLocaleString("ko-KR")}</span>
                  <span className="text-accent">TP {rule.takeProfit2Price.toLocaleString("ko-KR")}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
