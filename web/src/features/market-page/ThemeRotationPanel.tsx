import { useCallback, useState } from "react";
import type { KiwoomTheme } from "../../api/generated/KiwoomTheme";
import type { SymbolInfo } from "../../api/generated/SymbolInfo";
import { getJson } from "../../api/http";
import { useMarketThemes } from "../../api/marketOverview";
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

  const openLeader = useCallback(async (leaderName: string) => {
    setBusyLeader(leaderName);
    try {
      const rows = await getJson<SymbolInfo[]>(`/api/symbols?q=${encodeURIComponent(leaderName)}`);
      const exact = rows.find((row) => row.name === leaderName) ?? rows[0];
      if (exact !== undefined) send({ code: exact.code, name: exact.name });
    } finally {
      setBusyLeader(null);
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
