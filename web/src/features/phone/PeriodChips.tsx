import { useCallback, useId, useRef, useState } from "react";
import type { Period } from "../../api/generated/Period";
import { PERIOD_LABEL } from "../../lib/symbol";
import { type CellState, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { IndicatorIcon } from "../icons";
import { RadioMenu } from "../menu/RadioMenu";

const CHIPS = ["5m", "15m", "60m", "D", "W", "M"] as const satisfies readonly Period[];
const MENU = ["1m", "3m", "30m"] as const satisfies readonly Period[];
const MENU_OPTIONS = MENU.map((p) => ({ value: p, label: PERIOD_LABEL[p] }));
const LONG_PRESS_MS = 450;

const isMenuPeriod = (p: Period): p is (typeof MENU)[number] => (MENU as readonly Period[]).includes(p);

const CHIP =
  "h-[36px] min-w-[44px] flex-none rounded-full border border-line px-3 text-text-2 aria-pressed:border-accent aria-pressed:bg-accent aria-pressed:font-[650] aria-pressed:text-accent-ink";

/**
 * 휴대폰 봉 주기 칩(frontend.md §4, D11). 칩은 5·15·60분과 일·주·월 여섯이고,
 * 칩을 길게 누르면(또는 상황 메뉴 키) 1·3·30분 메뉴가 열린다.
 * 그 메뉴의 봉 주기를 보는 동안에는 그 칩을 맨 앞에 눌린 채로 보인다. 줄 끝에 지표 버튼을 둔다.
 */
export function PeriodChips({ cell }: { cell: CellState }) {
  const setPeriod = useLayoutStore((s) => s.setPeriod);
  const openIndicators = useSelectionStore((s) => s.openIndicators);
  const [menuOpen, setMenuOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);
  const hintId = useId();

  const cancelPress = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const openMenu = (button: HTMLButtonElement) => {
    cancelPress();
    opener.current = button;
    setMenuOpen(true);
  };
  const closeMenu = useCallback((restoreFocus: boolean) => {
    setMenuOpen(false);
    if (restoreFocus) opener.current?.focus();
  }, []);

  const chips: readonly Period[] = isMenuPeriod(cell.period) ? [cell.period, ...CHIPS] : CHIPS;

  return (
    <div ref={root} className="relative hidden border-b border-line [grid-area:mper] max-md:flex">
      <nav aria-label="봉 주기" className="flex min-w-0 flex-1 gap-1 overflow-x-auto px-3 pb-2 [scrollbar-width:none]">
        {chips.map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={cell.period === p}
            aria-describedby={hintId}
            className={`${CHIP} select-none [-webkit-touch-callout:none]`}
            onPointerDown={(e) => {
              longPressed.current = false;
              const button = e.currentTarget;
              timer.current = setTimeout(() => {
                longPressed.current = true;
                openMenu(button);
              }, LONG_PRESS_MS);
            }}
            onPointerUp={cancelPress}
            onPointerLeave={cancelPress}
            onPointerCancel={cancelPress}
            onContextMenu={(e) => {
              e.preventDefault();
              openMenu(e.currentTarget);
            }}
            onClick={() => {
              if (longPressed.current) return;
              setMenuOpen(false);
              setPeriod(cell.slot, p);
            }}
          >
            {PERIOD_LABEL[p]}
          </button>
        ))}
      </nav>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-label="지표"
        title="지표 (I)"
        className="mb-2 mr-3 grid h-[36px] w-[44px] flex-none place-items-center rounded-full border border-line text-text"
        onClick={() => openIndicators(cell.slot)}
      >
        <IndicatorIcon />
      </button>
      <span id={hintId} hidden>
        길게 누르면 1분, 3분, 30분
      </span>
      {menuOpen && (
        <RadioMenu
          label="다른 봉 주기"
          options={MENU_OPTIONS}
          value={isMenuPeriod(cell.period) ? cell.period : null}
          onChoose={(p) => setPeriod(cell.slot, p)}
          onClose={closeMenu}
          root={root}
          className="absolute left-3 top-[calc(100%-4px)]"
        />
      )}
    </div>
  );
}
