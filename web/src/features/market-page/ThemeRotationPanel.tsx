import { useCallback, useEffect, useRef, useState } from "react";
import type { KiwoomTheme } from "../../api/generated/KiwoomTheme";
import type { SymbolInfo } from "../../api/generated/SymbolInfo";
import { getJson } from "../../api/http";
import { useMarketThemes } from "../../api/marketOverview";
import { useSelectionStore } from "../../stores/selection";
import { useSendSymbol } from "../pages/sendSymbol";
import { EmptyNote, Loaded, PartView } from "./CardPart";
import { formatCount, signedRate, toneOf } from "./marketFormat";

const THEME_SKELETON = { shape: "card", minHeight: "var(--mk-skeleton-sector)" } as const;
const MAX_THEMES = 8;

function ThemeCardRow({ theme, onOpenLeader, busyLeader }: { theme: KiwoomTheme; onOpenLeader: (name: string) => void; busyLeader: string | null }) {
  return (
    <li className="mk-theme-card" data-code={theme.code} data-tone={toneOf(theme.changeRate)}>
      <div className="mk-theme-top">
        <strong className="mk-theme-name">{theme.name}</strong>
        <span className="mk-theme-rate mk-num" data-tone={toneOf(theme.changeRate)}>{signedRate(theme.changeRate)}</span>
      </div>
      <div className="mk-theme-counts">
        <span>총 {formatCount(theme.stockCount)}</span>
        <span data-tone="up">상승 {formatCount(theme.rising)}</span>
        <span data-tone="down">하락 {formatCount(theme.falling)}</span>
      </div>
      {theme.leaders.length > 0 && (
        <div className="mk-theme-leaders" aria-label={`${theme.name} 주도 종목`}>
          {theme.leaders.map((leader) => (
            <button
              key={leader}
              type="button"
              className="mk-leader-chip"
              disabled={busyLeader === leader}
              onClick={() => onOpenLeader(leader)}
            >
              {leader}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}

export function ThemeRotationPanel({ enabled }: { enabled: boolean }) {
  const query = useMarketThemes({ enabled });
  const send = useSendSymbol();
  const [busyLeader, setBusyLeader] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const openLeader = useCallback(async (leaderName: string) => {
    const requestId = ++requestIdRef.current;
    setBusyLeader(leaderName);
    try {
      const rows = await getJson<SymbolInfo[]>(`/api/symbols?q=${encodeURIComponent(leaderName)}`);
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      const exact = rows.find((row) => row.name === leaderName) ?? rows[0];
      if (exact !== undefined) {
        send({ code: exact.code, name: exact.name });
      } else {
        useSelectionStore.getState().showToast("종목 정보를 찾지 못했습니다");
      }
    } catch {
      if (mountedRef.current && requestId === requestIdRef.current) {
        useSelectionStore.getState().showToast("종목 정보를 찾지 못했습니다");
      }
    } finally {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setBusyLeader(null);
      }
    }
  }, [send]);

  return (
    <Loaded query={query} label="장중 키움 테마" skeleton={THEME_SKELETON}>
      {(card) => (
        <PartView part={card.themes}>
          {(themes) => {
            if (themes.length === 0) return <EmptyNote>표시할 장중 키움 테마가 없습니다</EmptyNote>;
            const sorted = [...themes].sort((a, b) => b.changeRate - a.changeRate).slice(0, MAX_THEMES);
            return (
              <ul className="mk-theme-grid" aria-label="장중 키움 테마 목록">
                {sorted.map((theme) => (
                  <ThemeCardRow key={theme.code} theme={theme} onOpenLeader={openLeader} busyLeader={busyLeader} />
                ))}
              </ul>
            );
          }}
        </PartView>
      )}
    </Loaded>
  );
}
