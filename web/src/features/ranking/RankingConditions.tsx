import type { Ranking } from "../../api/generated/Ranking";
import { RANKING_CATEGORIES, categoryOf, changeRankingKind, conditionsOf } from "./rankingChoices";
import { RANKING_NAME, type RankingKind } from "./rankingKinds";
import { useVenue } from "../../stores/ui";

interface Props {
  ranking: Ranking;
  onChange(next: Ranking): void;
}

export function RankingPickers({ ranking, onChange }: Props) {
  const venue = useVenue();
  const category = categoryOf(ranking.kind);
  const pick = (kind: RankingKind) => onChange(changeRankingKind(ranking, kind, venue));
  return (
    <>
      <div className="rk-row" role="tablist" aria-label="순위 분류">
        {RANKING_CATEGORIES.map((c) => (
          <button key={c.id} type="button" role="tab" className="rk-seg" aria-selected={c.id === category.id} onClick={() => pick(c.kinds[0]!)}>
            {c.name}
          </button>
        ))}
      </div>
      <div className="rk-row rk-chips" role="tablist" aria-label="순위 종류">
        {category.kinds.map((kind) => (
          <button key={kind} type="button" role="tab" className="rk-chip" aria-selected={kind === ranking.kind} onClick={() => pick(kind)}>
            {RANKING_NAME[kind]}
          </button>
        ))}
      </div>
    </>
  );
}

export function RankingConditionRow({ ranking, onChange, children }: Props & { children?: React.ReactNode }) {
  return (
    <div className="rk-row rk-conditions" data-testid="ranking-conditions">
      {conditionsOf(ranking).map((condition) =>
        condition.type === "choice" ? (
          <label key={condition.id} className="rk-field">
            <span>{condition.label}</span>
            <select aria-label={`순위 ${condition.label}`} value={condition.value} onChange={(e) => onChange(condition.set(e.target.value))}>
              {condition.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <button key={condition.id} type="button" className="rk-chip rk-toggle" aria-pressed={condition.on} onClick={() => onChange(condition.set(!condition.on))}>
            {condition.label}
          </button>
        ),
      )}
      {children}
    </div>
  );
}
