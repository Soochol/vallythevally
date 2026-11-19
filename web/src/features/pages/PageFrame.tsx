import type { ReactNode } from "react";
import { Link } from "react-router";
import { useSymbolInfo } from "../../api/queries";
import { useUiStore } from "../../stores/ui";
import { pathOfPage } from "../page-rail/pages";
import { LinkColorPicker } from "./LinkColorPicker";
import { useSendSymbol } from "./sendSymbol";
import "./pageFrame.css";

interface PageFrameProps {
  title: string;
  freshness?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}

export function PageFrame({ title, freshness, actions, children }: PageFrameProps) {
  return (
    <div className="page-frame">
      <header className="page-frame-bar">
        <Link to={pathOfPage("workspace")} className="page-frame-back md:hidden" aria-label="작업 영역으로">‹</Link>
        <h1 className="page-frame-title">{title}</h1>
        <div className="page-frame-freshness" role="status" aria-label="자료 신선도">{freshness}</div>
        <div className="page-frame-spacer" />
        {actions}
        <LinkColorPicker />
      </header>
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
