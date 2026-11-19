import { useRef, useState } from "react";
import type { LinkColor } from "../../api/generated/LinkColor";
import { LINK_COLORS } from "../../api/linkColors";
import { linkLabel, useLayoutStore } from "../../stores/layout";
import { useUiStore } from "../../stores/ui";
import { Popover } from "../overlay/Popover";

const CHOICES: readonly (LinkColor | null)[] = [null, ...LINK_COLORS];

const choiceName = (link: LinkColor | null) => (link === null ? "끔 · 활성 차트" : linkLabel(link));

export function LinkColorPicker() {
  const link = useUiStore((s) => s.prefs.pageLink);
  const windows = useLayoutStore((s) => s.layout.windows);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={button} type="button" className="page-link-button" aria-haspopup="menu" aria-expanded={open} aria-label={`보낼 연동 색: ${choiceName(link)}`} title="종목을 보낼 작업 영역 차트의 연동 색" onClick={() => setOpen((value) => !value)}>
        <span className="page-link-label">보낼 연동 색</span>
        <span className="link-swatch page-link-chip" data-link={link ?? undefined} aria-hidden="true">{link === null ? "" : linkLabel(link)}</span>
      </button>
      {open && (
        <Popover anchor={button} role="menu" aria-label="보낼 연동 색" aria-orientation="horizontal" onClose={() => setOpen(false)} className="link-swatch-menu z-40">
          <div role="presentation" className="link-swatch-head">보낼 연동 색</div>
          <div role="presentation" className="link-swatch-grid">
            {CHOICES.map((choice) => (
              <button
                key={choice ?? "off"}
                type="button"
                role="menuitemradio"
                className="link-swatch"
                data-link={choice ?? undefined}
                aria-label={choice === null ? "끔 · 활성 차트로 보냅니다" : `${linkLabel(choice)} · 창 ${windows.filter((w) => w.link === choice).length}개`}
                aria-checked={link === choice}
                onClick={() => {
                  useUiStore.getState().setPageLink(choice);
                  setOpen(false);
                }}
              >
                {choice !== null && <span aria-hidden="true">{linkLabel(choice)}</span>}
              </button>
            ))}
            <div role="separator" aria-orientation="vertical" className="link-swatch-rule" />
          </div>
          <div role="presentation" className="link-swatch-note">고른 색의 차트가 없으면 활성 차트로 보냅니다</div>
        </Popover>
      )}
    </>
  );
}
