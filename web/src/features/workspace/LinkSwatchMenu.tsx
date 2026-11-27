import { type KeyboardEvent, type RefObject, useRef, useState } from "react";
import type { LinkColor } from "../../api/generated/LinkColor";
import { LINK_COLORS } from "../../api/linkColors";
import { isFollowsWindow, isPinnableWindow, isWindowLocked, linkedWindowCount, linkLabel, useLayoutStore, type WindowState } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { Popover } from "../overlay/Popover";
import { swatchIndexAfterKey, swatchLinkAt } from "./linkSwatchKeys";

const CHOICES: readonly (LinkColor | null)[] = [null, ...LINK_COLORS];

const countHint = (count: number) => (count === 0 ? "없음" : `창 ${count}개`);

const swatchName = (link: LinkColor | null, count: number) => (link === null ? "끔" : `${linkLabel(link)} · ${countHint(count)}`);

const swatchDescription = (link: LinkColor | null, count: number) =>
  link === null ? "끔 · 이 창만 따로 봅니다" : count === 0 ? `${linkLabel(link)} · 아직 이 색을 쓰는 창이 없습니다` : `${linkLabel(link)} · 창 ${count}개와 종목을 맞춥니다`;

export function LinkSwatchMenu({ window, dot, onClose }: { window: WindowState; dot: RefObject<HTMLElement | null>; onClose(): void }) {
  const windows = useLayoutStore((s) => s.layout.windows);
  const lockedWindows = useLayoutStore((s) => s.lockedWindows);
  const activeCell = useSelectionStore((s) => s.activeCell);
  const swatches = useRef<(HTMLButtonElement | null)[]>([]);
  const [pointed, setPointed] = useState<LinkColor | null | undefined>(undefined);
  const [focused, setFocused] = useState<LinkColor | null>(window.link);
  const countOf = (link: LinkColor | null) => (link === null ? 0 : linkedWindowCount(windows, link, window.id));
  const described = pointed === undefined ? focused : pointed;
  const canLock = isFollowsWindow(window);
  const locked = canLock && (isWindowLocked(window, lockedWindows) || (isPinnableWindow(window) && window.symbol !== undefined));

  const onKeyDown = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Tab") {
      onClose();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const current = swatches.current.findIndex((swatch) => swatch === document.activeElement);
    const next = swatchIndexAfterKey(Math.max(current, 0), event.key);
    if (next === null) return;
    event.preventDefault();
    swatches.current[next]?.focus();
  };

  return (
    <Popover anchor={dot} role="menu" aria-label="연동 색" aria-orientation="horizontal" onKeyDown={onKeyDown} onClose={onClose} className="link-swatch-menu z-40">
      <div role="presentation" className="link-swatch-head">연동 색</div>
      <div role="presentation" className="link-swatch-grid" onPointerLeave={() => setPointed(undefined)}>
        {CHOICES.map((link, index) => (
          <button
            key={link ?? "off"}
            ref={(el) => { swatches.current[index] = el; }}
            type="button"
            role="menuitemradio"
            className="link-swatch"
            data-link={link ?? undefined}
            aria-label={swatchName(link, countOf(link))}
            aria-checked={window.link === link}
            onPointerEnter={() => setPointed(link)}
            onFocus={() => setFocused(swatchLinkAt(index))}
            onClick={() => {
              if (link !== window.link) useLayoutStore.getState().setLink(window.id, link);
              onClose();
            }}
          >
            {link !== null && <span aria-hidden="true">{linkLabel(link)}</span>}
          </button>
        ))}
        <div role="separator" aria-orientation="vertical" className="link-swatch-rule" />
      </div>
      <div role="presentation" className="link-swatch-note">{swatchDescription(described, countOf(described))}</div>
      {canLock && (
        <>
          <div role="separator" className="link-swatch-divider" />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={locked}
            className="link-swatch-lock"
            onClick={() => useLayoutStore.getState().toggleWindowLock(window.id, activeCell)}
          >
            <span className="link-swatch-lock-label">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="7" width="10" height="7" rx="1.8" />
                <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
              </svg>
              이 창 종목 고정
            </span>
            <span className="link-swatch-switch" data-on={locked ? "" : undefined} aria-hidden="true" />
          </button>
        </>
      )}
    </Popover>
  );
}
