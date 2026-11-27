import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useKiwoomThemeMembers, useKiwoomThemes } from "../../api/kiwoomThemes";
import type { WindowId } from "../../layout/kinds";
import { EmptyState, ErrorState, Skeleton } from "../overlay/State";
import { dropPendingOpen, openResult } from "../screener/resultActions";
import { symbolDragProps } from "../../stores/symbolDrag";
import "./themes.css";

type SortKey = "rate" | "breadth" | "count";

function roleLabel(index: number): string {
  if (index === 0) return "대장주";
  if (index === 1) return "2등주";
  return "후발주";
}

function ThemeMembersPanel({ code, windowId }: { code: string; windowId: WindowId }) {
  const queryClient = useQueryClient();
  const query = useKiwoomThemeMembers(code, true, 1);

  if (query.isPending) {
    return <div className="thm-members"><span className="thm-meta">구성 종목을 불러오는 중…</span></div>;
  }
  if (query.isError) {
    return <div className="thm-members"><span className="thm-meta">구성 종목을 불러오지 못했습니다</span></div>;
  }
  const members = [...(query.data?.members ?? [])].sort((a, b) => b.changeRate - a.changeRate);
  if (members.length === 0) {
    return <div className="thm-members"><span className="thm-meta">구성 종목이 없습니다</span></div>;
  }
  return (
    <div className="thm-members">
      {members.map((member, index) => (
        <button
          key={member.symbol}
          type="button"
          className="thm-member"
          data-testid={`theme-member-${member.symbol}`}
          {...symbolDragProps({ code: member.symbol, name: member.name, sourceWindow: windowId })}
          onClick={() => void openResult(queryClient, member.symbol, windowId)}
        >
          <span className="thm-role" data-rank={index}>{roleLabel(index)}</span>
          <span className="thm-name">{member.name}</span>
          <span className="thm-num">{member.price.toLocaleString()}</span>
          <span className={`thm-num ${member.changeRate > 0 ? "thm-up" : member.changeRate < 0 ? "thm-down" : ""}`}>
            {member.changeRate > 0 ? "+" : ""}{member.changeRate.toFixed(2)}%
          </span>
          <span className="thm-num thm-meta">{member.volume.toLocaleString()}</span>
        </button>
      ))}
    </div>
  );
}

export function ThemesWindow({ id }: { id: WindowId }) {
  const [sort, setSort] = useState<SortKey>("rate");
  const [expanded, setExpanded] = useState<string | null>(null);
  const query = useKiwoomThemes(1);

  useEffect(() => dropPendingOpen, []);

  const themes = useMemo(() => {
    const list = query.data?.themes ?? [];
    return [...list].sort((a, b) => {
      if (sort === "count") return b.stockCount - a.stockCount;
      if (sort === "breadth") {
        const ra = a.stockCount > 0 ? a.rising / a.stockCount : 0;
        const rb = b.stockCount > 0 ? b.rising / b.stockCount : 0;
        return rb - ra;
      }
      return b.changeRate - a.changeRate;
    });
  }, [query.data, sort]);

  return (
    <div className="thm-window" data-testid="themes-window">
      <div className="thm-head">
        <div className="thm-seg" role="group" aria-label="테마 정렬">
          <button type="button" className="thm-seg-btn" aria-pressed={sort === "rate"} onClick={() => setSort("rate")}>등락률순</button>
          <button type="button" className="thm-seg-btn" aria-pressed={sort === "breadth"} onClick={() => setSort("breadth")}>상승비율순</button>
          <button type="button" className="thm-seg-btn" aria-pressed={sort === "count"} onClick={() => setSort("count")}>종목수순</button>
        </div>
        <span className="thm-spacer" />
        <span className="thm-meta">{themes.length > 0 ? `${themes.length}개 테마` : "테마 리더보드"}</span>
      </div>
      <div className="thm-body">
        {query.isPending ? (
          <Skeleton label="테마 리더보드를 불러오는 중" rows={8} />
        ) : query.isError ? (
          <ErrorState message="테마 목록을 불러오지 못했습니다" retry={() => void query.refetch()} />
        ) : themes.length === 0 ? (
          <EmptyState title="표시할 테마가 없습니다" />
        ) : (
          themes.map((theme) => {
            const total = Math.max(theme.stockCount, 1);
            const upPct = Math.round((theme.rising / total) * 100);
            const downPct = Math.round((theme.falling / total) * 100);
            const isOpen = expanded === theme.code;
            return (
              <div key={theme.code} className="thm-group">
                <button
                  type="button"
                  className="thm-row"
                  data-testid={`theme-row-${theme.code}`}
                  aria-expanded={isOpen}
                  onClick={() => setExpanded(isOpen ? null : theme.code)}
                >
                  <span className="thm-meta">{isOpen ? "▾" : "▸"}</span>
                  <span className="thm-name">{theme.name}</span>
                  <span className={`thm-num ${theme.changeRate > 0 ? "thm-up" : theme.changeRate < 0 ? "thm-down" : ""}`}>
                    {theme.changeRate > 0 ? "+" : ""}{theme.changeRate.toFixed(2)}%
                  </span>
                  <div className="thm-bar" aria-label={`상승 ${upPct}%`}>
                    <div className="thm-bar-up" style={{ width: `${upPct}%` }} />
                    <div className="thm-bar-down" style={{ width: `${downPct}%` }} />
                  </div>
                  <span className="thm-num thm-meta">{theme.rising}/{theme.stockCount} ({upPct}%)</span>
                </button>
                {isOpen && <ThemeMembersPanel code={theme.code} windowId={id} />}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
