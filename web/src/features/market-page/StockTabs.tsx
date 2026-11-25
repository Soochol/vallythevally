import type { UseQueryResult } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import type { Market } from "../../api/generated/Market";
import type { MarketOverviewScope } from "../../api/generated/MarketOverviewScope";
import type { MarketOverviewStreak } from "../../api/generated/MarketOverviewStreak";
import type { MarketOverviewStreaksCard } from "../../api/generated/MarketOverviewStreaksCard";
import type { MarketOverviewViCard } from "../../api/generated/MarketOverviewViCard";
import type { MarketOverviewViEvent } from "../../api/generated/MarketOverviewViEvent";
import type { Ranking } from "../../api/generated/Ranking";
import type { RankingPage } from "../../api/generated/RankingPage";
import type { RankingRow } from "../../api/generated/RankingRow";
import { useMarketRanking, useMarketStreaks, useMarketVi } from "../../api/marketOverview";
import { formatPrice } from "../../lib/format";
import { useSendSymbol } from "../pages/sendSymbol";
import { useOverviewOn } from "../status/marketFeed";
import { Tabs, panelDomId } from "../ui/Tabs";
import { CardShell, EmptyNote, FeedUnavailable, Loaded, PartView } from "./CardPart";
import { formatViTime, MARKET_LABEL, viKindLabel } from "./derivedFormat";
import { formatCount, formatEok, signedEok, signedRate, toneOf } from "./marketFormat";

export const STOCK_TABS = [
  { id: "value", label: "거래대금" },
  { id: "gainers", label: "상승" },
  { id: "losers", label: "하락" },
  { id: "foreign", label: "외국인 연속" },
  { id: "institution", label: "기관 연속" },
  { id: "vi", label: "VI 발동" },
] as const;
export type StockTab = (typeof STOCK_TABS)[number]["id"];

const EXCLUDES = { etfEtn: true, preferred: false } as const;

export function rankingOf(tab: "value" | "gainers" | "losers", scope: MarketOverviewScope): Ranking {
  if (tab === "value") return { kind: "tradeAmount", market: scope, venue: "combined", excludes: EXCLUDES, excludeManaged: false };
  return { kind: tab, market: scope, venue: "combined", includeLimit: true, minTradeAmount: "any", excludes: EXCLUDES, excludeManaged: false };
}

const VISIBLE_ROWS = 10;
const STOCK_SKELETON = { shape: "card", minHeight: "var(--mk-skeleton-stocks)" } as const;

function SymbolName({ code, name }: { code: string; name: string }) {
  return (
    <>
      <button type="button" className="mk-stock-name">{name}</button>
      <span className="mk-stock-code">{code}</span>
    </>
  );
}

const eokOfWon = (won: number): string => formatEok(Math.round(won / 1e8));

function SymbolRows<T extends { code: string; name: string }>({ rows, keyOf, children }: { rows: readonly T[]; keyOf?: (row: T, index: number) => string; children: (row: T) => ReactNode }) {
  const send = useSendSymbol();
  return rows.map((row, index) => (
    <tr key={keyOf ? keyOf(row, index) : row.code} data-code={row.code} className="mk-stock-row" onClick={() => send({ code: row.code, name: row.name })}>
      {children(row)}
    </tr>
  ));
}

function RankingTable({ query, tab }: { query: UseQueryResult<RankingPage>; tab: "value" | "gainers" | "losers" }) {
  return (
    <Loaded query={query} label="종목 순위" skeleton={STOCK_SKELETON}>
      {(page) => (
        <StockTable kind="ranking" head={[["순위", "num"], ["종목", "text"], ["현재가", "num"], ["등락률", "num"], [tab === "value" ? "거래대금" : "거래량", "num"]]} rows={page.rows}>
          {(rows) => (
            <SymbolRows rows={rows}>
              {(row: RankingRow) => (
                <>
                  <td className="mk-num">{row.rank}</td>
                  <td><SymbolName code={row.code} name={row.name} /></td>
                  <td className="mk-num">{row.price === null ? "—" : formatPrice(row.price, false)}</td>
                  <td className="mk-num" data-tone={row.changeRate === null ? "flat" : toneOf(row.changeRate)}>{row.changeRate === null ? "—" : signedRate(row.changeRate)}</td>
                  <td className="mk-num">{row.figures.kind === "tradeAmount" ? eokOfWon(row.figures.tradeAmount) : "volume" in row.figures ? formatCount(Number(row.figures.volume)) : "—"}</td>
                </>
              )}
            </SymbolRows>
          )}
        </StockTable>
      )}
    </Loaded>
  );
}

type Align = "num" | "text";

function StockTable<T>({ kind, head, rows, emptyMessage = "순위가 비어 있습니다", children }: { kind: "ranking" | "streak" | "vi"; head: readonly (readonly [string, Align])[]; rows: readonly T[]; emptyMessage?: string; children: (rows: readonly T[]) => ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  if (rows.length === 0) return <EmptyNote>{emptyMessage}</EmptyNote>;
  const shown = expanded ? rows : rows.slice(0, VISIBLE_ROWS);
  return (
    <div className="mk-table-wrap">
      <table className="mk-table" data-kind={kind}>
        <thead>
          <tr>{head.map(([label, align]) => <th key={label} className={align === "num" ? "mk-num" : undefined}>{label}</th>)}</tr>
        </thead>
        <tbody>{children(shown)}</tbody>
      </table>
      {rows.length > VISIBLE_ROWS && !expanded && <button type="button" className="btn btn-sm mk-more" onClick={() => setExpanded(true)}>더 보기 ({rows.length - VISIBLE_ROWS})</button>}
    </div>
  );
}

function StreakRows({ rows }: { rows: readonly MarketOverviewStreak[] }) {
  return (
    <StockTable kind="streak" head={[["종목", "text"], ["연속", "num"], ["순매매", "num"], ["기간 등락률", "num"]]} rows={rows}>
      {(shown) => (
        <SymbolRows rows={shown}>
          {(row: MarketOverviewStreak) => (
            <>
              <td><SymbolName code={row.code} name={row.name} /></td>
              <td className="mk-num" data-tone={toneOf(Number(row.days))}>{Number(row.days) > 0 ? "+" : ""}{formatCount(Number(row.days))}일</td>
              <td className="mk-num" data-tone={toneOf(row.netEok)}>{signedEok(row.netEok)}</td>
              <td className="mk-num" data-tone={toneOf(row.periodChangeRate)}>{signedRate(row.periodChangeRate)}</td>
            </>
          )}
        </SymbolRows>
      )}
    </StockTable>
  );
}

function StreakTable({ query, subject }: { query: UseQueryResult<MarketOverviewStreaksCard>; subject: "foreign" | "institution" }) {
  return (
    <Loaded query={query} label="연속 매매" skeleton={STOCK_SKELETON}>
      {(card) => (
        <div className="mk-streaks">
          {([["순매수 연속", card.buying], ["순매도 연속", card.selling]] as const).map(([title, part]) => (
            <section key={title} aria-label={title}>
              <h3>{title}</h3>
              <PartView part={part}>{(board) => <StreakRows rows={board[subject]} />}</PartView>
            </section>
          ))}
        </div>
      )}
    </Loaded>
  );
}

function ViTable({ query }: { query: UseQueryResult<MarketOverviewViCard> }) {
  return (
    <Loaded query={query} label="VI 발동" skeleton={STOCK_SKELETON}>
      {(card) => (
        <PartView part={card.events}>
          {(events) => (
            <StockTable
              kind="vi"
              head={[["종목", "text"], ["방향", "text"], ["유형", "text"], ["발동 시각", "num"], ["괴리율", "num"]]}
              rows={events}
              emptyMessage="오늘 발동된 VI 종목이 없습니다"
            >
              {(shown) => (
                <SymbolRows rows={shown} keyOf={(row, index) => `${row.code}-${row.triggeredAt}-${index}`}>
                  {(row: MarketOverviewViEvent) => (
                    <>
                      <td>
                        <SymbolName code={row.code} name={row.name} />
                        <span className="mk-vi-market">{MARKET_LABEL[row.market]}</span>
                      </td>
                      <td>
                        <span className="mk-vi-dir" data-tone={row.direction === "up" ? "up" : "down"}>
                          {row.direction === "up" ? "상승 VI" : "하락 VI"}
                        </span>
                      </td>
                      <td>
                        <span className="mk-vi-badge">{viKindLabel(row)}</span>
                      </td>
                      <td className="mk-num">{formatViTime(row.triggeredAt)}</td>
                      <td className="mk-num" data-tone={row.dispersionRate === null ? "flat" : toneOf(row.dispersionRate)}>
                        {row.dispersionRate === null ? "—" : signedRate(row.dispersionRate)}
                      </td>
                    </>
                  )}
                </SymbolRows>
              )}
            </StockTable>
          )}
        </PartView>
      )}
    </Loaded>
  );
}

export function StockTabs({ scope, market, enabled }: { scope: MarketOverviewScope; market: Market; enabled: boolean }) {
  const [tab, setTab] = useState<StockTab>("value");
  const streaksOn = useOverviewOn("streaks");
  const streakTab = tab === "foreign" || tab === "institution";
  const viTab = tab === "vi";
  const rankingTab = !streakTab && !viTab;
  const streaks = useMarketStreaks(market, { enabled: enabled && streaksOn });
  const vi = useMarketVi(scope, { enabled: enabled && viTab });
  const ranking = useMarketRanking(rankingOf(rankingTab ? tab : "value", scope), { enabled: enabled && rankingTab });
  const source = viTab ? vi.data?.source : streakTab ? streaks.data?.context.source : ranking.data?.source;
  return (
    <CardShell title="종목" card="stocks" source={source}>
      <Tabs label="종목 보기" idPrefix="mk" className="mk-tabs" items={STOCK_TABS.map((entry) => ({ id: entry.id, label: entry.label }))} value={tab} onChange={(id) => setTab(id as StockTab)} />
      <div role="tabpanel" id={panelDomId("mk", tab)} aria-labelledby={`mk-tab-${tab}`} className="mk-stock-panel">
        {viTab ? (
          <ViTable query={vi} />
        ) : streakTab ? (
          streaksOn ? <StreakTable query={streaks} subject={tab} /> : <FeedUnavailable />
        ) : (
          <RankingTable query={ranking} tab={tab} />
        )}
      </div>
    </CardShell>
  );
}
