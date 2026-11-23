import { type ReactNode, useRef, useState } from "react";
import type { Ranking } from "../../api/generated/Ranking";
import { useMarketSource } from "../../stores/kiwoomLink";
import { useVenue } from "../../stores/ui";
import { SlidersIcon } from "../icons";
import { Select } from "../menu/Select";
import { Popover } from "../overlay/Popover";
import { choiceOn, FEED_CHOICE_TOOLTIP } from "../status/marketFeed";
import { Chip } from "../ui/Chip";
import { RANKING_CATEGORIES, categoryOf, changeRankingKind, changedConditions, conditionsOf } from "./rankingChoices";
import { RANKING_NAME, type RankingKind } from "./rankingKinds";

interface Props {
  ranking: Ranking;
  onChange(next: Ranking): void;
}

const SHARED_SELECT: ReadonlySet<string> = new Set(["market", "venue"]);

export function RankingHead({ ranking, onChange, status }: Props & { status: ReactNode }) {
  const venue = useVenue();
  const category = categoryOf(ranking.kind);
  const changed = changedConditions(ranking, venue);
  const pick = (kind: RankingKind) => onChange(changeRankingKind(ranking, kind, venue));
  return (
    <div className="rk-head">
      <div className="rk-row">
        <div className="ui-seg rk-cats" role="tablist" aria-label="순위 분류" data-size="sm">
          {RANKING_CATEGORIES.map((c) => (
            <button key={c.id} type="button" role="tab" className="ui-seg-item" aria-selected={c.id === category.id} onClick={() => pick(c.kinds[0]!)}>
              {c.name}
            </button>
          ))}
        </div>
        <span className="rk-grow" />
        {status}
      </div>
      <div className="rk-row" data-testid="ranking-conditions">
        <div className="rk-kinds" role="tablist" aria-label="순위 종류">
          {category.kinds.map((kind) => (
            <button key={kind} type="button" role="tab" className="rk-kind" aria-selected={kind === ranking.kind} onClick={() => pick(kind)}>
              {RANKING_NAME[kind]}
            </button>
          ))}
        </div>
        <span className="rk-changed" aria-label="바뀐 조건">
          {changed.map((c) => <span key={c.id} className="rk-mini">{c.text}</span>)}
        </span>
        <ConditionButton ranking={ranking} onChange={onChange} count={changed.length} />
      </div>
    </div>
  );
}

function ConditionButton({ ranking, onChange, count }: Props & { count: number }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={button} type="button" className="btn btn-sm rk-condition-button" aria-haspopup="dialog" aria-expanded={open} title={count === 0 ? "순위 조건" : `순위 조건 · 바뀐 조건 ${count}개`} onClick={() => setOpen(!open)}>
        <SlidersIcon size={14} />
        조건
      </button>
      {open && (
        <Popover anchor={button} role="dialog" aria-label="순위 조건" data-chart-control="" solid onClose={() => setOpen(false)} className="rk-popover">
          <Conditions ranking={ranking} onChange={onChange} />
        </Popover>
      )}
    </>
  );
}

function Conditions({ ranking, onChange }: Props) {
  const source = useMarketSource();
  const choices = conditionsOf(ranking).filter((c) => c.type === "choice");
  const toggles = conditionsOf(ranking).filter((c) => c.type === "toggle");
  return (
    <div className="rk-conditions">
      {choices.map((condition) => {
        if (condition.type !== "choice") return null;
        const label = `순위 ${condition.label}`;
        const allowed = (value: string) => choiceOn(source, ranking, condition.id, value);
        return (
          <div key={condition.id} className="rk-field">
            <span>{condition.label}</span>
            {SHARED_SELECT.has(condition.id) ? (
              <Select
                label={label}
                value={condition.value}
                className="ui-field px-2"
                options={condition.options.map((option) => ({ value: option.value, label: option.label, hint: allowed(option.value) ? undefined : FEED_CHOICE_TOOLTIP }))}
                onChange={(next) => allowed(next) && onChange(condition.set(next))}
              />
            ) : (
              <select aria-label={label} className="ui-field px-2" value={condition.value} onChange={(e) => onChange(condition.set(e.target.value))}>
                {condition.options.map((option) => (
                  <option key={option.value} value={option.value} {...(allowed(option.value) ? {} : { disabled: true, title: FEED_CHOICE_TOOLTIP, "data-feed-refused": "" })}>
                    {option.label}
                  </option>
                ))}
              </select>
            )}
          </div>
        );
      })}
      {toggles.length > 0 && (
        <div className="rk-toggles">
          {toggles.map((condition) => condition.type === "toggle" && (
            <Chip key={condition.id} pressed={condition.on} onPressedChange={(on) => onChange(condition.set(on))}>{condition.label}</Chip>
          ))}
        </div>
      )}
    </div>
  );
}
