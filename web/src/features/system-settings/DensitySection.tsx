import { useSyncExternalStore } from "react";
import { appliedDensity, chooseDensity, DENSITY_OPTIONS, DEFAULT_DENSITY, subscribeDensity } from "../../persist/density";
import { Segmented } from "../ui/Segmented";

export function DensitySection() {
  const density = useSyncExternalStore(subscribeDensity, () => appliedDensity(), () => DEFAULT_DENSITY);
  return (
    <section aria-label="목록 밀도" className="flex flex-col gap-3 border-t border-line bg-transparent py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-m font-semibold">목록 밀도</h3>
          <p className="text-s text-text-2">관심종목·순위·스크리너 줄 높이를 고릅니다. 이 브라우저에만 저장됩니다</p>
        </div>
        <Segmented label="목록 밀도" options={DENSITY_OPTIONS} value={density} onChange={chooseDensity} />
      </div>
    </section>
  );
}
