import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import type { HeatmapBoardTheme } from "../../api/generated/HeatmapBoardTheme";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { heatmapBoardQuery } from "../../api/heatmapBoard";
import { ApiRequestError } from "../../api/http";
import { useSymbolInfos } from "../../api/queries";
import { formatKstClockSeconds } from "../../chart/time";
import { quoteBook } from "../../stores/realtime";
import { useVenue } from "../../stores/ui";
import { DataAgeNote } from "../data-age/DataAgeNote";
import { EmptyState, ErrorState } from "../overlay/State";
import { Notice } from "../ui/Notice";
import { PageFrame } from "../pages/PageFrame";
import { HeatmapFlow } from "./HeatmapFlow";
import { HeatmapGroup } from "./HeatmapGroup";
import { HeatmapToolbar } from "./HeatmapToolbar";
import { KiwoomBreadcrumb, KiwoomThemeMap } from "./KiwoomThemeMap";
import { ThemeEditor, type ThemeEditorStart } from "./ThemeEditor";
import { copyThemeToMineNow, type ThemeChoice } from "./themeQuickEdit";
import { boardRows, hasTradedValue } from "./arrange";
import { themeColors } from "./groupColors";
import { catalogFreshness, catalogNotice } from "./kiwoomThemes";
import { parseSettings, withSettings, type HeatmapSettings } from "./settings";
import "./heatmapPage.css";

export interface HeatmapSection {
  key: string;
  title: string;
  symbols: readonly SymbolCode[];
  color: string;
  theme: HeatmapBoardTheme;
}

export function heatmapSections(themes: readonly HeatmapBoardTheme[]): HeatmapSection[] {
  const colors = themeColors(themes.map((theme) => theme.id));
  return themes.map((theme) => ({ key: theme.id, title: theme.name, symbols: [...theme.members.map((m) => m.symbol), ...theme.missing], color: colors.get(theme.id)!, theme }));
}

const FRESHNESS_POLL_MS = 1000;

function freshestTime(asOf: number | null, codes: readonly SymbolCode[]): number | null {
  const times = [...(asOf === null ? [] : [asOf]), ...codes.flatMap((code) => quoteBook.get(code).quote?.t ?? [])];
  return times.length === 0 ? null : Math.max(...times);
}

function useFreshestTime(asOf: number | null, codes: readonly SymbolCode[]): number | null {
  const [latest, setLatest] = useState<number | null>(() => freshestTime(asOf, codes));
  useEffect(() => {
    const read = () => setLatest(freshestTime(asOf, codes));
    read();
    const timer = window.setInterval(read, FRESHNESS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [asOf, codes]);
  return latest;
}

function HeatmapSkeleton() {
  return (
    <div className="hm-groups hm-skeleton" role="status" aria-label="보드를 불러오는 중">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="hm-skeleton-card" aria-hidden="true">
          <span className="hm-skeleton-line" />
          <span className="hm-skeleton-line" data-short="" />
          <span className="hm-skeleton-map" />
        </div>
      ))}
    </div>
  );
}

export function HeatmapPage() {
  const [params, setParams] = useSearchParams();
  const settings = useMemo(() => parseSettings(params), [params]);
  const change = useCallback((next: HeatmapSettings) => setParams((current) => withSettings(current, next), { replace: true }), [setParams]);
  const navigate = useCallback((next: HeatmapSettings) => setParams((current) => withSettings(current, next)), [setParams]);
  const hrefOf = (theme: string | null) => `?${withSettings(params, { ...settings, view: "board", theme })}`;
  const selectSource = useCallback((source: HeatmapSettings["source"]) => source !== settings.source && navigate({ ...settings, source, theme: null }), [navigate, settings]);
  const venue = useVenue();
  const client = useQueryClient();
  const [editor, setEditor] = useState<ThemeEditorStart | null>(null);
  const [copying, setCopying] = useState(false);
  const board = useQuery(heatmapBoardQuery(venue, settings.order, settings.source));
  const boardData = board.data?.source === settings.source ? board.data : undefined;
  const kiwoom = settings.source === "kiwoom";
  const sections = useMemo(() => heatmapSections(boardData?.themes ?? []), [boardData]);
  const selected = kiwoom ? sections.find((section) => section.key === settings.theme) : undefined;
  const shown = useMemo(() => (kiwoom ? (selected ? [selected] : []) : sections), [kiwoom, selected, sections]);
  const choices = useMemo((): ThemeChoice[] => sections.map((section) => ({ id: section.key, name: section.title, symbols: section.symbols })), [sections]);
  const codes = useMemo(() => [...new Set(shown.flatMap((section) => section.symbols))], [shown]);
  useEffect(() => (codes.length > 0 ? quoteBook.lease(codes) : undefined), [codes]);
  const infos = useSymbolInfos(codes);
  const nameOf = useMemo(() => {
    const names = new Map(infos.map((info) => [info.code, info.name] as const));
    for (const section of shown) for (const member of section.theme.members) names.set(member.symbol, member.name);
    return names;
  }, [infos, shown]);
  const settled = boardData !== undefined;
  const tradedKnown = useMemo(() => hasTradedValue(shown.flatMap((section) => boardRows(section.theme, nameOf))), [shown, nameOf]);
  const latest = useFreshestTime(boardData?.asOf ?? null, codes);
  const failed = board.isError;
  const lastText = latest === null ? "—" : formatKstClockSeconds(latest);
  const quoteFreshness = failed ? `받지 못함 · 마지막 ${lastText}` : latest === null ? "시세를 기다리는 중" : `시세 ${lastText} 기준 · 자리는 30초마다 바꿈`;
  const catalogDate = kiwoom ? catalogFreshness(boardData?.catalog ?? null) : null;
  const freshness = catalogDate === null ? quoteFreshness : `${quoteFreshness} · ${catalogDate}`;
  const notice = kiwoom && settled ? catalogNotice(boardData.catalog) : null;
  const copySelected = async (section: HeatmapSection) => {
    setCopying(true);
    try {
      await copyThemeToMineNow(client, { id: section.key, name: section.title, symbols: section.symbols });
    } finally {
      setCopying(false);
    }
  };
  const breadcrumb = <KiwoomBreadcrumb themeName={selected?.title ?? null} backHref={hrefOf(null)} />;
  const kiwoomBody = notice ? (
    <EmptyState title={notice.title}>{notice.hint && <p className="hm-empty-hint">{notice.hint}</p>}</EmptyState>
  ) : sections.length === 0 ? (
    <EmptyState title="키움 테마가 없습니다" />
  ) : settings.view === "flow" ? (
    selected ? (
      <>
        {breadcrumb}
        <HeatmapFlow sections={shown} names={nameOf} venue={venue} />
      </>
    ) : (
      <EmptyState title="테마를 고르면 그 테마의 흐름을 보입니다" action="키움 테마 지도로" onAction={() => navigate({ ...settings, view: "board", theme: null })} />
    )
  ) : selected ? (
    <>
      {breadcrumb}
      <div className="hm-detail">
        <HeatmapGroup
          section={selected}
          settings={settings}
          names={nameOf}
          themes={choices}
          editable={false}
          headAction={<button type="button" className="tb-btn hm-edit-open" disabled={copying} onClick={() => void copySelected(selected)}>내 테마로 가져오기</button>}
        />
      </div>
    </>
  ) : settings.theme !== null ? (
    <>
      {breadcrumb}
      <EmptyState title="고른 키움 테마를 찾지 못했습니다" />
    </>
  ) : (
    <KiwoomThemeMap themes={sections.map((section) => section.theme)} range={settings.range} hrefOf={hrefOf} />
  );
  const retry = () => void board.refetch();
  const cause = board.error instanceof ApiRequestError ? board.error.message : "서버에 닿지 못했습니다";
  const noThemes = !kiwoom && settled && sections.length === 0;
  const firstUse = (
    <EmptyState title="테마가 없습니다">
      <p className="hm-empty-hint">히트맵은 내가 고른 종목 묶음인 테마마다 지도를 그립니다. 관심종목 그룹을 그대로 테마로 가져오거나, 빈 테마를 만들어 종목을 넣어 보세요.</p>
      <div className="hm-empty-actions">
        <button type="button" className="btn-primary" onClick={() => setEditor("import")}>관심종목 그룹에서 가져오기</button>
        <button type="button" className="btn" onClick={() => setEditor("create")}>테마 직접 만들기</button>
        <button type="button" className="btn" onClick={() => selectSource("kiwoom")}>키움 테마 둘러보기</button>
      </div>
      <p className="hm-empty-hint">가져와도 관심종목은 그대로 남습니다.</p>
    </EmptyState>
  );
  const body = !settled ? (
    failed ? (
      <ErrorState message="히트맵 보드를 받지 못했습니다" retry={retry}>
        <p className="hm-error-cause">{cause}</p>
        <p className="hm-error-cause">30초마다 자동으로 다시 받습니다</p>
      </ErrorState>
    ) : (
      <HeatmapSkeleton />
    )
  ) : kiwoom ? (
    kiwoomBody
  ) : noThemes ? (
    firstUse
  ) : settings.view === "flow" ? (
    <HeatmapFlow sections={sections} names={nameOf} venue={venue} />
  ) : (
    <div className="hm-groups">
      {sections.map((section) => (
        <HeatmapGroup key={section.key} section={section} settings={settings} names={nameOf} themes={choices} editable />
      ))}
    </div>
  );
  return (
    <PageFrame title="히트맵" fresh={{ receivedAt: latest, failed }} freshness={<>{freshness}{boardData && <DataAgeNote recordedAt={boardData.asOf} cadence="heatmapBoard" />}</>}>
      {!noThemes && <HeatmapToolbar settings={settings} onChange={change} onSelectSource={selectSource} tradedKnown={!settled || tradedKnown} onEdit={() => setEditor("browse")} />}
      {settled && failed && <Notice tone="warning" action={{ label: "다시 시도", onClick: retry }}>{cause} · 마지막으로 받은 보드를 흐리게 보이고 있습니다. 자동으로 다시 받습니다.</Notice>}
      <div className="hm-body" data-stale={settled && failed ? "" : undefined}>{body}</div>
      {editor !== null && <ThemeEditor start={editor} onClose={() => setEditor(null)} />}
    </PageFrame>
  );
}
