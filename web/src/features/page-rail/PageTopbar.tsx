import { MockBadge } from "../topbar/MockBadge";
import { BrandLink } from "./BrandLink";
import { ALL_PAGES, type PageId } from "./pages";

export function PageTopbar({ page }: { page: PageId }) {
  const path = ALL_PAGES.find((entry) => entry.id === page)!.path;
  return (
    <header role="toolbar" aria-label="페이지 도구 막대" className="desktop-topbar ui-island relative z-20 mx-[var(--island-gap)] mt-[var(--island-gap)] h-[var(--island-h)] flex-none rounded-l max-md:hidden">
      <BrandLink />
      <MockBadge />
      <span className="page-topbar-path" aria-label="현재 주소">{path}</span>
    </header>
  );
}
