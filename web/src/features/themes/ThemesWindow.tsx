import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useKiwoomThemeMembers, useKiwoomThemes } from "../../api/kiwoomThemes";
import type { WindowId } from "../../layout/kinds";
import { formatPercent } from "../../lib/format";
import { useFeedLink } from "../../stores/kiwoomLink";
import { ChevronIcon } from "../icons";
import { FeedConnectGate } from "../market-window/MarketWindowGate";
import { EmptyState, ErrorState, Skeleton } from "../overlay/State";
import { dropPendingOpen, openResult } from "../screener/resultActions";
import { Segmented } from "../ui/Segmented";
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
    return (
      <div className="thm-members">
        <ErrorState message="구성 종목을 불러오지 못했습니다" retry={() => void query.refetch()} />
      </div>
    );
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
          <span className="thm-num">{member.price.toLocaleString("ko-KR")}</span>
          <span className={`thm-num ${member.changeRate > 0 ? "thm-up" : member.changeRate < 0 ? "thm-down" : ""}`}>
            {formatPercent(member.changeRate)}
          </span>
          <span className="thm-num thm-meta">{member.volume.toLocaleString("ko-KR")}</span>
        </button>
      ))}
    </div>
  );
}

export function ThemesWindow({ id }: { id: WindowId }) {
  const link = useFeedLink();
  const connected = link === null || link.state === "connected";
  const [sort, setSort] = useState<SortKey>("rate");
  const [expanded, setExpanded] = useState<string | null>(null);
  const query = useKiwoomThemes(1, connected);

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
        <Segmented<SortKey>
          label="테마 정렬"
          mode="pressed"
          size="xs"
          value={sort}
          options={[
            { value: "rate", label: "등락률순" },
            { value: "breadth", label: "상승비율순" },
            { value: "count", label: "종목수순" },
          ]}
          onChange={setSort}
        />
        <span className="thm-spacer" />
        <span className="thm-meta">{themes.length > 0 ? `${themes.length}개 테마` : "테마 리더보드"}</span>
      </div>
      <div className="thm-body">
        {!connected ? (
          <FeedConnectGate message={link?.message} />
        ) : query.isPending ? (
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
                  <span className={`thm-meta inline-flex transition-transform duration-[var(--dur-fast)] ${isOpen ? "" : "-rotate-90"}`}><ChevronIcon size={12} /></span>
                  <span className="thm-name">{theme.name}</span>
                  <span className={`thm-num ${theme.changeRate > 0 ? "thm-up" : theme.changeRate < 0 ? "thm-down" : ""}`}>
                    {formatPercent(theme.changeRate)}
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
