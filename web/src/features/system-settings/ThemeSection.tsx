import { useSyncExternalStore } from "react";
import { appliedTheme, chooseTheme, DEFAULT_THEME, subscribeTheme, THEME_OPTIONS } from "../../persist/theme";
import { Segmented } from "../ui/Segmented";

export function ThemeSection() {
  const theme = useSyncExternalStore(subscribeTheme, () => appliedTheme(), () => DEFAULT_THEME);
  return (
    <section aria-label="화면 테마" className="flex flex-col gap-3 border-t border-line bg-transparent py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-m font-semibold">화면 테마</h3>
          <p className="text-s text-text-2">화면 스타일과 색상을 고릅니다. 이 브라우저에만 저장됩니다</p>
        </div>
        <Segmented label="화면 테마" options={THEME_OPTIONS} value={theme} onChange={chooseTheme} className="sys-theme-seg" />
      </div>
    </section>
  );
}
