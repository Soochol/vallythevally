import { BrandIcon } from "../icons";
import "./shellStates.css";

export const RESTORING_LABEL = "마지막 화면을 불러오는 중";
export const RESTORING_STATUS = "마지막 화면을 불러오는 중…";

const Bone = ({ size }: { size: "tab" | "line" | "short" | "tile" }) => <span data-size={size} className="shell-skeleton-bone" />;

function Pane({ kind, lines }: { kind: "chart" | "side"; lines: number }) {
  return (
    <div data-kind={kind} className="shell-skeleton-pane">
      <div className="shell-skeleton-tabs"><Bone size="tab" />{kind === "side" && <Bone size="tab" />}</div>
      <div className="shell-skeleton-body">
        {Array.from({ length: lines }, (_, index) => <Bone key={index} size={index % 2 === 0 ? "line" : "short"} />)}
      </div>
    </div>
  );
}

export function ShellSkeleton({ restoring }: { restoring: boolean }) {
  return (
    <div data-shell-skeleton aria-busy="true" aria-label={RESTORING_LABEL} className="app-shell relative flex h-dvh min-h-0 min-w-0 flex-col overflow-hidden bg-bg">
      <header data-skeleton-part="topbar" className="desktop-topbar ui-island relative z-20 mx-[var(--island-gap)] mt-[var(--island-gap)] h-[var(--island-h)] flex-none rounded-l max-md:hidden">
        <span className="app-brand"><BrandIcon /><span>vally</span></span>
      </header>
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="relative flex min-h-0 min-w-0 flex-1">
          <div className="absolute inset-0 flex">
            <span className="shell-skeleton-tools max-md:hidden" />
            <div className="shell-skeleton-workspace max-md:m-0">
              <Pane kind="chart" lines={4} />
              <Pane kind="side" lines={6} />
            </div>
          </div>
        </div>
        <nav data-skeleton-part="rail" aria-hidden="true" className="page-rail ui-island max-md:hidden">
          {Array.from({ length: 4 }, (_, index) => <Bone key={index} size="tile" />)}
        </nav>
      </div>
      <footer data-skeleton-part="status" className="status-bar flex min-w-0 flex-none items-center border-t border-line px-3 text-xs">
        {restoring && <span className="shell-skeleton-status chart-loading-label">{RESTORING_STATUS}</span>}
      </footer>
    </div>
  );
}
