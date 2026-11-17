import { useRef, useState } from "react";
import { WINDOW_KINDS } from "../../layout/kinds";
import type { LinkColor } from "../../api/generated/LinkColor";
import { LINK_COLORS } from "../../api/linkColors";
import { linkedWindowCount, linkLabel, useLayoutStore, type WindowState } from "../../stores/layout";
import { Menu, type MenuItem } from "../menu/Menu";

const CHOICES: readonly (LinkColor | null)[] = [null, ...LINK_COLORS];

const choiceName = (link: LinkColor | null) => (link === null ? "끔" : linkLabel(link));

const countHint = (count: number) => (count === 0 ? "없음" : `창 ${count}개`);

function Swatch({ link }: { link: LinkColor | null }) {
  const fill = link === null ? "shadow-[inset_0_0_0_2px_var(--line-strong)]" : `bg-[var(--link-${link})]`;
  return <span aria-hidden="true" className={`size-2.5 rounded-full ${fill}`} />;
}

export function LinkDot({ window, selected }: { window: WindowState; selected: boolean }) {
  const dot = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const windows = useLayoutStore((s) => s.layout.windows);
  if (WINDOW_KINDS[window.kind].link === "none") return null;
  const value = choiceName(window.link);
  const items: MenuItem[] = [
    { kind: "heading", label: "연동 색 · 같은 색 창끼리 종목을 맞춥니다" },
    ...CHOICES.map((link): MenuItem => ({
      kind: "radio",
      label: choiceName(link),
      value: link ?? "off",
      icon: <Swatch link={link} />,
      hint: link === null ? undefined : countHint(linkedWindowCount(windows, link, window.id)),
      checked: window.link === link,
      onSelect: () => {
        if (link !== window.link) useLayoutStore.getState().setLink(window.id, link);
      },
    })),
  ];
  return (
    <>
      <button ref={dot} type="button" className="link-dot" tabIndex={selected ? 0 : -1} data-link={window.link ?? undefined} aria-label={`연동 색: ${value}`} aria-haspopup="menu" aria-expanded={open} title={`연동 색: ${value} · 눌러서 고르기`}
        onClick={() => setOpen((now) => !now)}>
        {window.link !== null && <span aria-hidden="true">{value}</span>}
      </button>
      {open && <Menu label="연동 색" root={dot} items={items} onClose={() => setOpen(false)} />}
    </>
  );
}
