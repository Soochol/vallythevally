import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import type { HeatmapBoardTheme } from "../../api/generated/HeatmapBoardTheme";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { heatmapBoardQuery } from "../../api/heatmapBoard";
import { ApiRequestError } from "../../api/http";
import { useSymbolInfos } from "../../api/queries";
import { formatKstClockSeconds } from "../../chart/time";
import { MAX_THEME_NAME_CHARS } from "../../lib/heatmapThemes";
import { quoteBook } from "../../stores/realtime";
import { useVenue } from "../../stores/ui";
import { useWatchlistStore } from "../../stores/watchlist";
import { DataAgeNote } from "../data-age/DataAgeNote";
import { EmptyState, ErrorState } from "../overlay/State";
import { PageFrame } from "../pages/PageFrame";
import { Notice } from "../ui/Notice";
import { boardRows, hasTradedValue } from "./arrange";
import { themeColors } from "./groupColors";
import { HeatmapGroup } from "./HeatmapGroup";
import { HeatmapList } from "./HeatmapList";
import { HeatmapToolbar } from "./HeatmapToolbar";
import { parseSettings, withSettings, type HeatmapSettings } from "./settings";
import { type ThemeChoice } from "./themeQuickEdit";
import { type SaveIndicatorState, useHeatmapInlineEdit } from "./useHeatmapInlineEdit";
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

function SaveBadge({ state }: { state: SaveIndicatorState }) {
  if (state === "idle") return null;
  const label = state === "saving" ? "자동 저장 중…" : state === "saved" ? "자동 저장됨" : "저장 실패";
  return (
    <span className="hm-save-status" data-state={state} role="status">
      <i className="hm-save-dot" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

function FirstUseEmpty({
  onCreate,
  onImport,
}: {
  onCreate(name: string): { ok: true; id: string } | { ok: false; problem: string };
  onImport(listId: string): string[];
}) {
  const lists = useWatchlistStore((state) => state.lists);
  const [mode, setMode] = useState<"idle" | "import" | "create">("idle");
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  const nameInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode === "create") nameInput.current?.focus();
  }, [mode]);

  return (
    <EmptyState title="테마가 없습니다">
      <p className="hm-empty-hint">히트맵은 내가 고른 종목 묶음인 테마마다 목록과 지도를 보여 줍니다. 관심종목 그룹을 그대로 테마로 가져오거나, 빈 테마를 만들어 종목을 넣어 보세요.</p>
      <div className="hm-empty-actions">
        <button
          type="button"
          className="btn-primary"
          aria-expanded={mode === "import"}
          onClick={() => {
            setMode((current) => (current === "import" ? "idle" : "import"));
            setProblem(null);
            setNotices([]);
          }}
        >
          관심종목 그룹에서 가져오기
        </button>
        <button
          type="button"
          className="btn"
          aria-expanded={mode === "create"}
          onClick={() => {
            setMode("create");
            setProblem(null);
            setNotices([]);
            nameInput.current?.focus();
          }}
        >
          테마 직접 만들기
        </button>
      </div>
      {mode === "import" && (
        <div className="hm-empty-panel" role="group" aria-label="관심종목 그룹에서 가져오기">
          {lists.map((list) => (
            <button key={list.id} type="button" className="btn btn-sm" onClick={() => setNotices(onImport(list.id))}>
              {list.name} · 그룹 {list.groups.length}개
            </button>
          ))}
        </div>
      )}
      {mode === "create" && (
        <form
          className="hm-empty-panel"
          onSubmit={(event) => {
            event.preventDefault();
            const result = onCreate(name);
            if (result.ok) {
              setName("");
              setProblem(null);
            } else {
              setProblem(result.problem);
            }
          }}
        >
          <input
            ref={nameInput}
            className="ui-field hm-empty-input"
            aria-label="새 테마 이름"
            placeholder={`새 테마 이름 (${MAX_THEME_NAME_CHARS}자까지)`}
            value={name}
            autoComplete="off"
            onChange={(event) => {
              setName(event.target.value);
              setProblem(null);
            }}
          />
          <button type="submit" className="btn-primary btn-sm">테마 추가</button>
        </form>
      )}
      {problem && <p className="hm-add-pop-error" role="alert">{problem}</p>}
      {notices.length > 0 && (
        <ul className="hm-add-pop-notices" role="status" aria-label="가져오기 결과">
          {notices.map((notice) => <li key={notice}>{notice}</li>)}
        </ul>
      )}
      <p className="hm-empty-hint">가져와도 관심종목은 그대로 남습니다.</p>
    </EmptyState>
  );
}

export function HeatmapPage() {
  const [params, setParams] = useSearchParams();
  const settings = useMemo(() => parseSettings(params), [params]);
  const change = useCallback((next: HeatmapSettings) => setParams((current) => withSettings(current, next), { replace: true }), [setParams]);
  const venue = useVenue();
  const [listQuery, setListQuery] = useState("");
  const board = useQuery(heatmapBoardQuery(venue, settings.order));
  const rawBoard = board.data;

  const baseNames = useMemo(() => {
    const names = new Map<SymbolCode, string>();
    for (const theme of rawBoard?.themes ?? []) {
      for (const member of theme.members) names.set(member.symbol, member.name);
    }
    return names;
  }, [rawBoard]);

  const { displayBoard, extraNames, actions } = useHeatmapInlineEdit(rawBoard, settings, change, baseNames);
  const sections = useMemo(() => heatmapSections(displayBoard?.themes ?? []), [displayBoard]);
  const choices = useMemo((): ThemeChoice[] => sections.map((section) => ({ id: section.key, name: section.title, symbols: section.symbols })), [sections]);
  const codes = useMemo(() => [...new Set(sections.flatMap((section) => section.symbols))], [sections]);
  useEffect(() => (codes.length > 0 ? quoteBook.lease(codes) : undefined), [codes]);
  const infos = useSymbolInfos(codes);
  const nameOf = useMemo(() => {
    const names = new Map(infos.map((info) => [info.code, info.name] as const));
    for (const [code, name] of extraNames) names.set(code, name);
    for (const section of sections) for (const member of section.theme.members) names.set(member.symbol, member.name);
    return names;
  }, [infos, extraNames, sections]);

  const settled = displayBoard !== undefined;
  const tradedKnown = useMemo(() => hasTradedValue(sections.flatMap((section) => boardRows(section.theme, nameOf))), [sections, nameOf]);
  const latest = useFreshestTime(displayBoard?.asOf ?? null, codes);
  const failed = board.isError;
  const lastText = latest === null ? "—" : formatKstClockSeconds(latest);
  const freshness = failed ? `받지 못함 · 마지막 ${lastText}` : latest === null ? "시세를 기다리는 중" : `시세 ${lastText} 기준 · 자리는 30초마다 바꿈`;
  const retry = () => void board.refetch();
  const cause = board.error instanceof ApiRequestError ? board.error.message : "서버에 닿지 못했습니다";
  const noThemes = settled && sections.length === 0;

  const body = !settled ? (
    failed ? (
      <ErrorState message="히트맵 보드를 받지 못했습니다" retry={retry}>
        <p className="hm-error-cause">{cause}</p>
        <p className="hm-error-cause">30초마다 자동으로 다시 받습니다</p>
      </ErrorState>
    ) : (
      <HeatmapSkeleton />
    )
  ) : noThemes ? (
    <FirstUseEmpty onCreate={actions.create} onImport={actions.importFromWatchlist} />
  ) : settings.view === "list" ? (
    <HeatmapList sections={sections} settings={settings} names={nameOf} themes={choices} query={listQuery} edit={actions} />
  ) : (
    <div className="hm-groups">
      {sections.map((section) => (
        <HeatmapGroup key={section.key} section={section} settings={settings} names={nameOf} themes={choices} editable />
      ))}
    </div>
  );

  return (
    <PageFrame
      title="히트맵"
      fresh={{ receivedAt: latest, failed }}
      freshness={
        <>
          {freshness}
          {displayBoard && <DataAgeNote recordedAt={displayBoard.asOf} cadence="heatmapBoard" />}
          <SaveBadge state={actions.saveState} />
        </>
      }
    >
      {!noThemes && (
        <HeatmapToolbar
          settings={settings}
          onChange={change}
          tradedKnown={!settled || tradedKnown}
          themeCount={sections.length}
          listQuery={listQuery}
          onListQueryChange={setListQuery}
          onCreateTheme={actions.create}
          onImportWatchlist={actions.importFromWatchlist}
        />
      )}
      {settled && failed && <Notice tone="warning" action={{ label: "다시 시도", onClick: retry }}>{cause} · 마지막으로 받은 보드를 흐리게 보이고 있습니다. 자동으로 다시 받습니다.</Notice>}
      <div className="hm-body" data-stale={settled && failed ? "" : undefined}>{body}</div>
    </PageFrame>
  );
}
