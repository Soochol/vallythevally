import type { WindowId } from "../../layout/kinds";
import { useLayoutStore } from "../../stores/layout";
import { RANKING_NAME } from "./rankingKinds";
import "./ranking.css";

export function RankingWindow({ id }: { id: WindowId }) {
  const kind = useLayoutStore((s) => {
    const window = s.layout.windows.find((w) => w.id === id);
    return window?.kind === "ranking" ? window.ranking.kind : null;
  });
  return (
    <div className="rk-window" data-testid="ranking-window" data-ranking={kind ?? undefined}>
      <b>{kind === null ? "" : RANKING_NAME[kind]}</b>
    </div>
  );
}
