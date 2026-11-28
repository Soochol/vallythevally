import { useEffect, useRef, useState } from "react";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { usePublicMode } from "../../public-mode/serverMode";
import { isActiveAutoOrder, useAutoOrdersStore } from "../../stores/autoOrders";
import { useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { Popover } from "../overlay/Popover";

export function AutoGuardBadge() {
  const publicMode = usePublicMode();
  const loaded = useAutoOrdersStore((s) => s.loaded);
  const masterEnabled = useAutoOrdersStore((s) => s.masterEnabled);
  const rules = useAutoOrdersStore((s) => s.rules);
  const load = useAutoOrdersStore((s) => s.load);
  const toggleMaster = useAutoOrdersStore((s) => s.toggleMaster);
  const activeCell = useSelectionStore((s) => s.activeCell);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!publicMode && !loaded) void load();
  }, [publicMode, loaded, load]);

  if (publicMode) return null;
  const activeRules = rules.filter(isActiveAutoOrder);
  if (activeRules.length === 0) return null;

  return (
    <div className="relative">
      <button
        ref={triggerRef}
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
        <Popover
          anchor={triggerRef}
          solid
          placement="bottom"
          role="dialog"
          aria-label="자동감시 종목 목록"
          onClose={() => setOpen(false)}
          className="topbar-popover w-72 border border-line p-3"
        >
          <div className="mb-2 flex items-center justify-between border-b border-line pb-2 text-s font-semibold">
            <span>자동 손절·익절 감시</span>
            <button
              type="button"
              aria-pressed={masterEnabled}
              className="btn btn-sm"
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
                className="flex flex-col rounded-s border border-line bg-raised px-2.5 py-2 text-left hover:border-accent"
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
                  <span className="text-down">SL {rule.stopLossPrice.toLocaleString("ko-KR")}</span>
                  <span className="text-up">TP {rule.takeProfit2Price.toLocaleString("ko-KR")}</span>
                </div>
              </button>
            ))}
          </div>
        </Popover>
      )}
    </div>
  );
}
