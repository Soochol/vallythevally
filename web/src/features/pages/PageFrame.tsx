import { type ReactNode, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate } from "react-router";
import { useSymbolInfo } from "../../api/queries";
import { DESKTOP_QUERY, useMediaQuery } from "../../lib/media";
import { useUiStore } from "../../stores/ui";
import { ChevronIcon } from "../icons";
import { Menu, type MenuItem } from "../menu/Menu";
import { pageOfPath, pathOfPage, RAIL_PAGES } from "../page-rail/pages";
import { Freshness, type FreshnessClock } from "./Freshness";
import { LinkColorPicker } from "./LinkColorPicker";
import { usePageSlot } from "./pageSlot";
import { useSendSymbol } from "./sendSymbol";
import "./pageFrame.css";

interface PageFrameProps {
  title: string;
  freshness?: ReactNode;
  fresh?: FreshnessClock;
  actions?: ReactNode;
  fullWidth?: boolean;
  hideLinkColorPicker?: boolean;
  children: ReactNode;
}

function PageTitleMenu({ title }: { title: string }) {
  const navigate = useNavigate();
  const current = pageOfPath(useLocation().pathname);
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const items: MenuItem[] = RAIL_PAGES.map(({ id, path, label }) => ({ kind: "radio", label, checked: id === current, onSelect: () => navigate(path) }));
  return (
    <div ref={root} className="page-frame-title-menu">
      <h1 className="page-frame-title">
        <button type="button" className="page-frame-title-button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {title}
          <ChevronIcon size={14} />
        </button>
      </h1>
      {open && <Menu label="페이지 이동" root={root} items={items} onClose={() => setOpen(false)} />}
    </div>
  );
}

export function PageFrame({ title, freshness, fresh, actions, fullWidth = false, hideLinkColorPicker = false, children }: PageFrameProps) {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const slot = usePageSlot();
  const status = <Freshness clock={fresh}>{freshness}</Freshness>;
  const topbarContent = (
    <>
      <h1 className="page-frame-title">{title}</h1>
      {status}
      <div className="page-frame-spacer" />
      {actions}
      {!hideLinkColorPicker && <LinkColorPicker />}
    </>
  );
  return (
    <div className="page-frame" data-full-width={fullWidth ? "" : undefined}>
      {desktop ? (
        slot && createPortal(topbarContent, slot)
      ) : (
        <>
          <header className="page-frame-bar">
            <Link to={pathOfPage("workspace")} className="page-frame-back" aria-label="작업 영역으로">‹</Link>
            <PageTitleMenu title={title} />
            <div className="page-frame-spacer" />
            {!hideLinkColorPicker && <LinkColorPicker />}
          </header>
          {actions && <div className="page-frame-actions">{actions}</div>}
          {status}
        </>
      )}
      <div className="page-frame-body">{children}</div>
    </div>
  );
}

function RecentSymbolButton({ code }: { code: string }) {
  const send = useSendSymbol();
  const info = useSymbolInfo(code).data;
  return <button type="button" className="page-preparing-symbol" onClick={() => send(info ?? { code })}>{info?.name ?? code}</button>;
}

export function PagePreparing() {
  const recent = useUiStore((s) => s.prefs.recentSymbols);
  return (
    <div className="page-preparing">
      <strong>준비 중입니다</strong>
      <span role="status">이 페이지는 아직 만들어지는 중입니다.</span>
      {recent.length > 0 && (
        <div role="group" aria-label="최근 본 종목을 연동 차트로 보내기" className="page-preparing-recent">
          {recent.map((code) => <RecentSymbolButton key={code} code={code} />)}
        </div>
      )}
    </div>
  );
}
