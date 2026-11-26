import { useSyncExternalStore } from "react";
import {
  appliedThemeMode,
  appliedThemeStyle,
  chooseThemeMode,
  chooseThemeStyle,
  DEFAULT_THEME_MODE,
  DEFAULT_THEME_STYLE,
  subscribeTheme,
  THEME_MODE_OPTIONS,
  THEME_STYLE_OPTIONS,
} from "../../persist/theme";
import { Segmented } from "../ui/Segmented";

export function ThemeSection() {
  const style = useSyncExternalStore(subscribeTheme, () => appliedThemeStyle(), () => DEFAULT_THEME_STYLE);
  const mode = useSyncExternalStore(subscribeTheme, () => appliedThemeMode(), () => DEFAULT_THEME_MODE);
  return (
    <section aria-label="화면 스타일과 색상" className="flex flex-col gap-4 border-t border-line bg-transparent py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-m font-semibold">스타일</h3>
          <p className="text-s text-text-2">화면 표면과 카드 조형을 고릅니다. 이 브라우저에만 저장됩니다</p>
        </div>
        <Segmented label="스타일" options={THEME_STYLE_OPTIONS} value={style} onChange={chooseThemeStyle} className="sys-theme-seg" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line-subtle pt-4">
        <div className="min-w-0">
          <h3 className="text-m font-semibold">색상 모드</h3>
          <p className="text-s text-text-2">어두운 화면과 밝은 화면을 고릅니다. 모든 스타일과 조합할 수 있습니다</p>
        </div>
        <Segmented label="색상 모드" options={THEME_MODE_OPTIONS} value={mode} onChange={chooseThemeMode} />
      </div>
    </section>
  );
}
