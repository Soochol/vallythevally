import { type ReactNode, useMemo } from "react";
import { Link } from "react-router";
import type { HeatmapBoardTheme } from "../../api/generated/HeatmapBoardTheme";
import { formatPercent } from "../../lib/format";
import { tradedText, MAP_HEIGHT, MAP_WIDTH } from "./HeatmapGroup";
import { needsStrongInk, rateFill, rateSide } from "./colors";
import { arrangeThemes } from "./kiwoomThemes";
import type { HeatmapSettings } from "./settings";
import type { TileRect } from "./treemap";

const NAME_MIN_WIDTH = 9;
const NAME_MIN_HEIGHT = 6;
const COUNT_MIN_WIDTH = 16;
const COUNT_MIN_HEIGHT = 11;

interface MapProps {
  themes: readonly HeatmapBoardTheme[];
  range: HeatmapSettings["range"];
  hrefOf(themeId: string): string;
}

interface TileProps {
  theme: HeatmapBoardTheme;
  rect: TileRect;
  range: HeatmapSettings["range"];
  href: string;
}

function ThemeTile({ theme, rect, range, href }: TileProps) {
  const { summary } = theme;
  const rate = summary?.weightedRate ?? null;
  const rateText = rate === null ? "–" : formatPercent(rate);
  const counts = summary ? `상승 ${summary.rising} · 하락 ${summary.falling}` : "시세 없음";
  const labelled = rect.w >= NAME_MIN_WIDTH && rect.h >= NAME_MIN_HEIGHT;
  const counted = rect.w >= COUNT_MIN_WIDTH && rect.h >= COUNT_MIN_HEIGHT;
  const detail = summary ? `\n${theme.members.length + theme.missing.length}종목 · 거래대금 ${tradedText(summary.tradedMillionWon)}` : "";
  return (
    <Link
      to={href}
      className="hm-tile hm-theme-tile"
      data-theme={theme.id}
      data-side={rate === null ? "none" : rateSide(rate)}
      data-strong={rate !== null && needsStrongInk(rate, range)}
      aria-label={`${theme.name} ${rateText} ${counts}`}
      title={`${theme.name} ${rateText}\n${counts}${detail}`}
      style={{
        left: `${(rect.x / MAP_WIDTH) * 100}%`,
        top: `${(rect.y / MAP_HEIGHT) * 100}%`,
        width: `${(rect.w / MAP_WIDTH) * 100}%`,
        height: `${(rect.h / MAP_HEIGHT) * 100}%`,
        background: rate === null ? "var(--raised)" : rateFill(rate, range),
      }}
    >
      {labelled && (
        <span className="hm-tile-text">
          <b>{theme.name}</b>
          <span>{rateText}</span>
          {counted && <span className="hm-theme-counts">{counts}</span>}
        </span>
      )}
    </Link>
  );
}

export function KiwoomThemeMap({ themes, range, hrefOf }: MapProps) {
  const rects = useMemo(() => arrangeThemes(themes, MAP_WIDTH, MAP_HEIGHT), [themes]);
  return (
    <section className="hm-group hm-theme-map" aria-label="키움 테마 지도">
      <header className="hm-group-head">
        <div className="hm-group-title">
          <h2>키움 테마</h2>
          <span>{themes.length}개</span>
        </div>
        <p className="hm-summary">칸 크기 = 테마 거래대금 합 · 칸 색 = 거래대금 가중 평균 등락률 · 칸을 누르면 그 테마의 종목 지도를 봅니다</p>
      </header>
      <div className="hm-map" role="group" aria-label="키움 테마 칸">
        {themes.map((theme) => {
          const rect = rects.get(theme.id);
          return rect ? <ThemeTile key={theme.id} theme={theme} rect={rect} range={range} href={hrefOf(theme.id)} /> : null;
        })}
      </div>
    </section>
  );
}

export function KiwoomBreadcrumb({ themeName, backHref }: { themeName: string | null; backHref: string }): ReactNode {
  return (
    <nav className="hm-crumbs" aria-label="키움 테마 경로">
      <Link to={backHref}>키움 테마</Link>
      {themeName !== null && (
        <>
          <span aria-hidden="true">›</span>
          <span aria-current="page">{themeName}</span>
        </>
      )}
    </nav>
  );
}
