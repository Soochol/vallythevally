import type { ReactNode } from "react";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { useSymbolInfo } from "../../api/queries";
import type { WindowId } from "../../layout/kinds";
import { isIndexCode } from "../../lib/symbol";
import { useKiwoomLinkStore } from "../../stores/kiwoomLink";
import { linkedWindowSymbol, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { EmptyState } from "../overlay/State";

export function useLinkedSymbol(id: WindowId): SymbolCode | null {
  const activeCell = useSelectionStore((s) => s.activeCell);
  return useLayoutStore((s) => linkedWindowSymbol(s.layout, id, activeCell));
}

export function MarketWindowGate({ id, children }: { id: WindowId; children(code: SymbolCode): ReactNode }) {
  const code = useLinkedSymbol(id);
  const link = useKiwoomLinkStore((s) => s.status);
  if (code === null) return <EmptyState title="연동된 종목이 없습니다" />;
  if (isIndexCode(code)) return <EmptyState title="이 창은 주식만 보입니다" />;
  if (link !== null && link.state !== "connected") return <EmptyState title="키움 연결 전입니다">{link.message && <p>{link.message}</p>}</EmptyState>;
  return <>{children(code)}</>;
}

export function PreparingBody({ code, kindName }: { code: SymbolCode; kindName: string }) {
  const name = useSymbolInfo(code).data?.name ?? code;
  return (
    <div className="mw-preparing" data-testid="market-window-preparing" data-symbol={code}>
      <b>{name}</b>
      <span>{kindName} 준비 중</span>
    </div>
  );
}
