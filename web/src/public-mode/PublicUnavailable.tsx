import type { WindowKind } from "../layout/kinds";
import { EmptyState } from "../features/overlay/State";

export const PUBLIC_UNAVAILABLE_TITLE = "실시간·차트 연결은 준비 중입니다";

export const PUBLIC_UNAVAILABLE_KINDS: ReadonlySet<WindowKind> = new Set<WindowKind>(["chart", "trades", "book", "program", "brokers", "order", "premarket"]);

export function PublicUnavailable() {
  return (
    <div data-testid="public-unavailable" className="grid min-h-0 min-w-0 flex-1 place-items-center">
      <EmptyState title={PUBLIC_UNAVAILABLE_TITLE}>
        <p>순위, 시장, 스크리너, 관심종목은 지금 쓸 수 있습니다.</p>
      </EmptyState>
    </div>
  );
}
