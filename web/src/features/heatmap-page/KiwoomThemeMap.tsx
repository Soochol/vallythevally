import { memo, type ReactNode, useMemo, useRef } from "react";
import { Link } from "react-router";
import type { HeatmapBoardTheme } from "../../api/generated/HeatmapBoardTheme";
import { formatPercent } from "../../lib/format";
import { tradedText, MAP_HEIGHT, MAP_WIDTH } from "./HeatmapGroup";
import { needsStrongInk, rateFill, rateSide } from "../../lib/heat/colors";
import { nameLines, tileLabel, type TileLabel } from "../../lib/heat/tileLabel";
import { arrangeThemes } from "./kiwoomThemes";
import type { HeatmapSettings } from "./settings";
import type { TileRect } from "./treemap";
import { useElementSize } from "./useElementSize";

const COUNT_MIN_WIDTH_PX = 120;
const COUNT_MIN_HEIGHT_PX = 64;

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
  label: TileLabel;
  lines: 1 | 2;
  counted: boolean;
}

const ThemeTile = memo(function ThemeTile({ theme, rect, range, href, label, lines, counted }: TileProps) {
  const { summary } = theme;
  const rate = summary?.weightedRate ?? null;
  const rateText = rate === null ? "–" : formatPercent(rate);
  const counts = summary ? `상승 ${summary.rising} · 하락 ${summary.falling}` : "시세 없음";
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
        ["--name-lines" as string]: lines,
      }}
    >
      {label !== "none" && (
        <span className="hm-tile-text">
          {label === "full" && <b className="hm-tile-name">{theme.name}</b>}
          <span className="hm-tile-rate">{rateText}</span>
          {label === "full" && counted && <span className="hm-theme-counts">{counts}</span>}
        </span>
      )}
    </Link>
  );
});

export function KiwoomThemeMap({ themes, range, hrefOf }: MapProps) {
  const rects = useMemo(() => arrangeThemes(themes, MAP_WIDTH, MAP_HEIGHT), [themes]);
  const byId = useMemo(() => new Map(themes.map((theme) => [theme.id, theme] as const)), [themes]);
  const map = useRef<HTMLDivElement>(null);
  const size = useElementSize(map);
  return (
    <section className="hm-group hm-theme-map" aria-label="키움 테마 지도">
      <header className="hm-group-head">
        <div className="hm-group-title">
          <h2>키움 테마</h2>
          <span>{themes.length}개</span>
        </div>
        <p className="hm-summary">칸 크기 = 테마 거래대금 합(제곱근으로 줄임) · 큰 테마부터 · 칸 색 = 거래대금 가중 평균 등락률 · 칸을 누르면 그 테마의 종목 지도를 봅니다</p>
      </header>
      <div ref={map} className="hm-map" role="group" aria-label="키움 테마 칸">
        {[...rects].map(([id, rect]) => {
          const theme = byId.get(id);
          if (!theme) return null;
          const px = { w: (rect.w / MAP_WIDTH) * size.w, h: (rect.h / MAP_HEIGHT) * size.h };
          return <ThemeTile key={id} theme={theme} rect={rect} range={range} href={hrefOf(id)} label={tileLabel(px.w, px.h)} lines={nameLines(px.h)} counted={px.w >= COUNT_MIN_WIDTH_PX && px.h >= COUNT_MIN_HEIGHT_PX} />;
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
