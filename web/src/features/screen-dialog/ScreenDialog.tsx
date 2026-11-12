import { Select } from "../menu/Select";
import { confirmAction } from "../overlay/Confirm";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, type Ref, useEffect, useId, useRef, useState } from "react";
import type { BarField } from "../../api/generated/BarField";
import type { BollingerBand } from "../../api/generated/BollingerBand";
import type { Direction } from "../../api/generated/Direction";
import type { Extreme } from "../../api/generated/Extreme";
import type { MaMethod } from "../../api/generated/MaMethod";
import type { MaOrder } from "../../api/generated/MaOrder";
import type { MacdTest } from "../../api/generated/MacdTest";
import type { PriceField } from "../../api/generated/PriceField";
import type { Screen } from "../../api/generated/Screen";
import type { Screens } from "../../api/generated/Screens";
import type { ScreenPeriod } from "../../api/generated/ScreenPeriod";
import type { Side } from "../../api/generated/Side";
import type { SurgeField } from "../../api/generated/SurgeField";
import { saveScreens, useScreens } from "../../api/screener";
import {
  BAND_LABEL,
  conditionSentence,
  DIRECTION_LABEL,
  EXCLUDE_LABEL,
  EXTREME_LABEL,
  FIELD_LABEL,
  KIND_LABEL,
  MA_METHOD_LABEL,
  MA_ORDER_LABEL,
  MARKET_LABEL,
  NEW_HIGH_NAME,
  NEW_LOW_NAME,
  NO_CONDITIONS_SENTENCE,
  PERIOD_NAME,
  SIDE_LABEL,
  UNIT,
  VALUE_UNIT,
} from "../../lib/screener";
import { useScreenerStore } from "../../stores/screener";
import { useSelectionStore } from "../../stores/selection";
import { DialogFrame, Errors, Row } from "../dialog/DialogParts";
import { ArrowIcon, CloseIcon, PlusIcon } from "../icons";
import {
  addCondition,
  addMaLine,
  changeKind,
  type CloseOrMa,
  type ConditionDraft,
  type ConditionErrors,
  checkCondition,
  checkDraft,
  draftOf,
  editCondition,
  type ExcludeGroup,
  excludesIn,
  type FieldKey,
  KIND_GROUPS,
  type KindChoice,
  kindChoiceOf,
  MARKETS,
  MAX_CONDITIONS,
  MAX_MA_LINES,
  MIN_MA_LINES,
  moveCondition,
  removeCondition,
  removeMaLine,
  type ScreenDraft,
  toggleExclude,
  toggleMarket,
  withScreen,
} from "./screenForm";

type Options<T extends string> = readonly (readonly [T, string])[];
const optionsOf = <T extends string>(labels: Record<T, string>, values: readonly T[]): Options<T> => values.map((v) => [v, labels[v]] as const);

const PERIODS = optionsOf<ScreenPeriod>(PERIOD_NAME, ["D", "W", "M"]);
const BAR_FIELDS = optionsOf<BarField>(FIELD_LABEL, ["open", "high", "low", "close", "volume", "traded_value"]);
const PRICE_FIELDS = optionsOf<PriceField>(FIELD_LABEL, ["open", "high", "low", "close"]);
const SURGE_FIELDS = optionsOf<SurgeField>(FIELD_LABEL, ["volume", "traded_value"]);
const METHODS = optionsOf<MaMethod>(MA_METHOD_LABEL, ["sma", "ema"]);
const SIDES = optionsOf<Side>(SIDE_LABEL, ["above", "below"]);
const DIRECTIONS = optionsOf<Direction>(DIRECTION_LABEL, ["up", "down"]);
const EXTREMES = optionsOf<Extreme>(EXTREME_LABEL, ["high", "low"]);
const ORDERS = optionsOf<MaOrder>(MA_ORDER_LABEL, ["bullish", "bearish"]);
const BANDS = optionsOf<BollingerBand>(BAND_LABEL, ["upper", "lower"]);
const FAST_LINES: Options<CloseOrMa> = [
  ["ma", "짧은 이평"],
  ["close", "종가"],
];
const RSI_TESTS: Options<"range" | "breakout"> = [
  ["range", "범위"],
  ["breakout", "돌파"],
];
const MACD_TESTS: Options<MacdTest["kind"]> = [
  ["signal_cross", "시그널 교차"],
  ["zero_breakout", "0선 돌파"],
  ["vs_signal", "시그널 대비"],
];
const STOCHASTIC_TESTS: Options<"cross" | "range"> = [
  ["cross", "%K·%D 교차"],
  ["range", "%K 범위"],
];
const BOLLINGER_TESTS: Options<"outside" | "cross"> = [
  ["outside", "밴드 밖"],
  ["cross", "밴드 교차"],
];
const BOLLINGER_SIDES: Options<Side> = [
  ["above", "상단 위"],
  ["below", "하단 아래"],
];
const ICHIMOKU_TESTS: Options<"cloud" | "cross"> = [
  ["cloud", "구름"],
  ["cross", "전환선·기준선 교차"],
];

export const CHOICE_LABEL: Record<KindChoice, string> = { ...KIND_LABEL, volume_high: NEW_HIGH_NAME.volume, traded_value_high: NEW_HIGH_NAME.traded_value };
const VALUE_FIELDS: Partial<Record<KindChoice, Options<BarField>>> = { new_high: PRICE_FIELDS, new_low: BAR_FIELDS };

const FIELD_NAME: Record<Exclude<FieldKey, `lengths.${number}`>, string> = {
  recentBars: "최근 기간",
  n: "기간",
  min: "최소",
  max: "최대",
  back: "비교 봉 수",
  minPct: "최소 등락률",
  maxPct: "최대 등락률",
  withinPct: "거리",
  times: "배수",
  length: "기간",
  fast: "빠른 기간",
  slow: "느린 기간",
  signal: "시그널 기간",
  value: "돌파 값",
  k: "%K 기간",
  d: "%D 기간",
  smooth: "평활 기간",
  conversion: "전환선 기간",
  base: "기준선 기간",
  spanB: "선행스팬 B 기간",
  displacement: "이동 봉 수",
};
const KIND_FIELD_NAME: { [K in KindChoice]?: Partial<Record<FieldKey, string>> } = {
  new_high: { n: "신고가 기간" },
  new_low: { n: "신저가 기간" },
  volume_high: { n: `${NEW_HIGH_NAME.volume} 기간` },
  traded_value_high: { n: `${NEW_HIGH_NAME.traded_value} 기간` },
  surge: { n: "평균 기간" },
  ma_position: { length: "이평 기간" },
  ma_cross: { fast: "짧은 이평", slow: "긴 이평" },
  rsi: { length: "RSI 기간" },
  bollinger: { k: "표준편차 배수" },
};

const LENGTHS = "lengths.";
const isLengthKey = (key: FieldKey): key is `lengths.${number}` => key.startsWith(LENGTHS);

function fieldName(kind: KindChoice, key: FieldKey): string {
  if (isLengthKey(key)) return `이평 ${Number(key.slice(LENGTHS.length)) + 1}`;
  return KIND_FIELD_NAME[kind]?.[key] ?? FIELD_NAME[key];
}

const EXCLUDE_ROWS: readonly { group: ExcludeGroup; label: string }[] = [
  { group: "kind", label: "종류 제외" },
  { group: "status", label: "상태 제외" },
];
const FIELD_BOX = "ui-field";
const CHIP =
  "h-9 rounded-m border border-line px-3 text-s text-text-2 hover:text-text " +
  "aria-pressed:border-accent aria-pressed:bg-accent-soft aria-pressed:font-[600] aria-pressed:text-accent max-md:h-9";
const STALE_SAVE = "이 대화상자를 연 뒤 다른 탭이나 기기에서 조건식 목록이 바뀌어 덮어쓰지 않았습니다. 바뀐 목록을 불러왔습니다. 다시 저장하면 이 조건식을 지금 보이는 내용으로 바꿉니다.";
const STALE_DELETE = "이 대화상자를 연 뒤 다른 탭이나 기기에서 조건식 목록이 바뀌어 삭제하지 않았습니다. 바뀐 목록을 불러왔으니 다시 삭제하세요.";

type Saving = { kind: "idle" } | { kind: "saving" } | { kind: "failed"; message: string };

export function ScreenDialog() {
  const dialog = useSelectionStore((s) => s.dialog);
  const screens = useScreens().data;
  return dialog?.kind === "screen" && screens ? <ScreenDialogBody editId={dialog.editId} opened={screens} /> : null;
}

function ScreenDialogBody({ editId, opened }: { editId: string | null; opened: Screens }) {
  const closeDialog = useSelectionStore((s) => s.closeDialog);
  const client = useQueryClient();
  const ids = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [id] = useState(() => editId ?? crypto.randomUUID());
  const [base, setBase] = useState(opened);
  const [initial] = useState(() => draftOf(opened.screens.find((s) => s.id === editId) ?? null));
  const [draft, setDraft] = useState(initial);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState<Saving>({ kind: "idle" });

  useEffect(() => nameRef.current?.focus(), []);

  const busy = saving.kind === "saving";
  const editing = editId !== null;
  const check = checkDraft(draft, id, base.screens);
  const errors = check.ok ? null : check.errors;
  const nameError = tried || draft.name !== initial.name ? (errors?.name ?? null) : null;
  const notice = saving.kind === "failed" ? saving.message : errors?.list;
  const dismiss = () => {
    if (!busy) closeDialog();
  };

  const store = async (change: (list: readonly Screen[]) => Screen[], stale: string, done: () => void) => {
    setSaving({ kind: "saving" });
    try {
      const outcome = await saveScreens(client, base, change);
      if (outcome.kind === "saved") return done();
      setBase(outcome.latest);
      setSaving({ kind: "failed", message: stale });
    } catch (e) {
      setSaving({ kind: "failed", message: `저장하지 못했습니다: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const submit = (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    if (!check.ok) {
      setTried(true);
      (check.errors.name ? nameRef.current : formRef.current?.querySelector<HTMLElement>("[aria-invalid=true]"))?.focus();
      return;
    }
    const screen = check.screen;
    void store((list) => withScreen(list, screen), STALE_SAVE, () => {
      useScreenerStore.getState().choose(screen.id);
      closeDialog();
    });
  };

  const remove = async () => {
    const name = base.screens.find((s) => s.id === id)?.name ?? initial.name;
    if (busy || !await confirmAction(`"${name}" 조건식을 삭제할까요? 되돌릴 수 없습니다.`)) return;
    void store((list) => list.filter((s) => s.id !== id), STALE_DELETE, closeDialog);
  };

  return (
    <DialogFrame labelledBy={`${ids}-title`} width="w-[min(980px,calc(100vw-32px))]" onClose={dismiss}>
      <div className="ui-dialog-head">
        <h2 id={`${ids}-title`} className="min-w-0 flex-1 truncate text-l font-[650]">
          {editing ? "조건식 편집" : "새 조건식"}
        </h2>
        <button type="button" className="icon-btn flex-none" aria-label="닫기" title="닫기 (Esc)" onClick={dismiss}>
          <CloseIcon />
        </button>
      </div>

      <form ref={formRef} onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
        <ScreenFields ids={ids} draft={draft} nameError={nameError} nameRef={nameRef} locked={busy} onChange={setDraft} />

        {notice && (
          <p role="alert" className="flex-none border-t border-line px-4 py-2 text-s leading-[1.45] text-danger">
            {notice}
          </p>
        )}
        <div className="ui-dialog-foot">
          {editing && (
            <button type="button" className="h-8 flex-none rounded-m px-3 text-danger hover:bg-raised disabled:opacity-50" disabled={busy} onClick={remove}>
              삭제
            </button>
          )}
          <span className="flex items-center gap-2 text-s text-text-3 max-md:hidden">
            <kbd>Enter</kbd> 저장 <kbd>Esc</kbd> 닫기
          </span>
          <span className="flex-1" />
          <button type="button" className="h-8 flex-none rounded-m border border-line px-4 hover:bg-raised disabled:opacity-50" disabled={busy} onClick={dismiss}>
            취소
          </button>
          <button type="submit" className="btn-primary flex-none disabled:cursor-not-allowed disabled:opacity-50" disabled={busy}>
            {busy ? "저장 중" : "저장"}
          </button>
        </div>
      </form>
    </DialogFrame>
  );
}

interface FieldsProps {
  ids: string;
  draft: ScreenDraft;
  nameError: string | null;
  nameRef?: Ref<HTMLInputElement>;
  locked: boolean;
  onChange(change: (draft: ScreenDraft) => ScreenDraft): void;
}

export function ScreenFields({ ids, draft, nameError, nameRef, locked, onChange }: FieldsProps) {
  const lines = draft.conditions.length;
  return (
    <div className={`screen-fields flex min-h-0 flex-1 flex-col overflow-auto ${locked ? "opacity-60" : ""}`}>
      <fieldset disabled={locked} className="contents">
        <section className="screen-section"><h3>조건식 이름</h3>
        <Row label="이름" labelFor={`${ids}-name`}>
          <input
            ref={nameRef}
            id={`${ids}-name`}
            value={draft.name}
            onChange={(e) => onChange((d) => ({ ...d, name: e.target.value }))}
            aria-invalid={nameError !== null}
            aria-describedby={nameError ? `${ids}-name-error` : undefined}
            placeholder="예: 고가 200일 신고가"
            autoComplete="off"
            spellCheck={false}
            className={`${FIELD_BOX} w-full max-w-[360px] px-2 placeholder:text-text-3`}
          />
          <Errors id={`${ids}-name-error`} messages={nameError ? [nameError] : []} />
        </Row>

        </section>
        <section className="screen-section"><h3>대상 종목</h3><div className="flex flex-col gap-5">
        <Row label="시장">
          <div role="group" aria-label="시장" className="flex flex-wrap gap-1.5 pt-px">
            {MARKETS.map((m) => (
              <button key={m} type="button" aria-pressed={draft.markets.includes(m)} onClick={() => onChange((d) => toggleMarket(d, m))} className={CHIP}>
                {MARKET_LABEL[m]}
              </button>
            ))}
          </div>
          <p className="text-xs leading-[1.5] text-text-3">고른 시장의 종목만 남깁니다. 아무것도 고르지 않으면 두 시장 모두입니다.</p>
        </Row>

        {EXCLUDE_ROWS.map(({ group, label }) => (
          <Row key={group} label={label}>
            <div role="group" aria-label={label} className="flex flex-wrap gap-1.5 pt-px">
              {excludesIn(group).map((k) => (
                <button key={k} type="button" aria-pressed={draft.exclude.includes(k)} onClick={() => onChange((d) => toggleExclude(d, k))} className={CHIP}>
                  {EXCLUDE_LABEL[k]}
                </button>
              ))}
            </div>
            {group === "status" && <p className="text-xs leading-[1.5] text-text-3">고른 종류와 상태의 종목은 결과에서 뺍니다. 아무것도 고르지 않으면 전 종목이 대상입니다.</p>}
          </Row>
        ))}
        </div></section>
        <section className="screen-section"><h3>조건 <span className="ml-2 text-s font-normal text-text-3">모든 조건 충족</span></h3>
        <Row label="조건">
          {lines === 0 ? (
            <p className="pt-1.5 text-s text-text-2">{NO_CONDITIONS_SENTENCE}</p>
          ) : (
            <ol aria-label="조건" className="flex flex-col gap-2.5">
              {draft.conditions.map((c, i) => (
                <ConditionLine
                  key={c.key}
                  ids={ids}
                  index={i}
                  last={i === lines - 1}
                  condition={c}
                  onChange={(line) => onChange((d) => editCondition(d, line))}
                  onKind={(kind) => onChange((d) => changeKind(d, c.key, kind))}
                  onMove={(by) => onChange((d) => moveCondition(d, c.key, by))}
                  onRemove={() => onChange((d) => removeCondition(d, c.key))}
                />
              ))}
            </ol>
          )}
          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <button type="button" className="tb-btn h-8 border border-line px-2.5 text-s disabled:opacity-40" disabled={lines >= MAX_CONDITIONS} onClick={() => onChange(addCondition)}>
              <PlusIcon size={14} />
              조건 더하기
            </button>
            <span className="text-xs text-text-3">
              조건을 모두 만족하는 종목만 찾습니다 · {lines}/{MAX_CONDITIONS}줄
            </span>
          </span>
        </Row>

        </section>
      </fieldset>
    </div>
  );
}

interface LineProps {
  ids: string;
  index: number;
  last: boolean;
  condition: ConditionDraft;
  onChange(line: ConditionDraft): void;
  onKind(kind: KindChoice): void;
  onMove(by: -1 | 1): void;
  onRemove(): void;
}

interface LineUi {
  label: string;
  base: string;
  kind: KindChoice;
  errors: ConditionErrors;
}

function ConditionLine({ ids, index, last, condition, onChange, onKind, onMove, onRemove }: LineProps) {
  const label = `조건 ${index + 1}`;
  const row = checkCondition(condition);
  const kind = kindChoiceOf(condition);
  const ui: LineUi = { label, base: `${ids}-condition-${condition.key}`, kind, errors: row.ok ? {} : row.errors };
  const barLine = condition.kind !== "market_cap";
  return (
    <li className="condition-card flex flex-col gap-3">
      <header><strong className="font-semibold">{label}</strong><span className="text-xs text-text-3">{index > 0 ? "그리고" : "첫 번째 조건"}</span></header>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5 text-s text-text-2">
        <Select label={`${label} 종류`} value={kind} onChange={onKind} className={`${FIELD_BOX} px-1.5`} options={KIND_GROUPS.flatMap((group) => group.kinds.map((choice) => ({ value: choice, label: CHOICE_LABEL[choice], group: group.label })))} />
        {barLine && <Choice label={`${label} 봉 주기`} value={condition.period} options={PERIODS} onChange={(period) => onChange({ ...condition, period })} />}
        {barLine && (
          <Together>
            <span>최근</span>
            <NumberBox ui={ui} field="recentBars" value={condition.recentBars} onChange={(recentBars) => onChange({ ...condition, recentBars })} />
            <span>{UNIT[condition.period]} 이내</span>
          </Together>
        )}
        <KindFields ui={ui} line={condition} onChange={onChange} />
        <span className="flex-1" />
        <span className="flex flex-none items-center">
          <button type="button" className="icon-btn h-7 w-7 max-md:h-10 max-md:w-10" aria-label={`${label} 위로 옮기기`} title="위로 옮기기" disabled={index === 0} onClick={() => onMove(-1)}>
            <ArrowIcon dir="up" size={14} />
          </button>
          <button type="button" className="icon-btn h-7 w-7 max-md:h-10 max-md:w-10" aria-label={`${label} 아래로 옮기기`} title="아래로 옮기기" disabled={last} onClick={() => onMove(1)}>
            <ArrowIcon dir="down" size={14} />
          </button>
          <button type="button" className="icon-btn h-7 w-7 max-md:h-10 max-md:w-10" aria-label={`${label} 빼기`} title="조건 빼기" onClick={onRemove}>
            <CloseIcon />
          </button>
        </span>
      </div>
      {(Object.entries(ui.errors) as [FieldKey, string][]).map(([key, message]) => (
        <Errors key={key} id={`${ui.base}-${key}-error`} messages={[`${fieldName(kind, key)}: ${message}`]} />
      ))}
      {barLine && <p className="text-xs text-text-3">마지막 봉을 포함한 실제 봉 개수입니다. 거래가 없어 봉이 없는 기간은 세지 않습니다.</p>}
      {row.ok && <p className="text-xs text-text-3">{conditionSentence(row.condition)}</p>}
    </li>
  );
}


type Width = "count" | "length" | "amount" | "percent";
const WIDTH: Record<Width, string> = { count: "w-[72px]", length: "w-[52px]", amount: "w-[88px]", percent: "w-[60px]" };

interface NumberProps {
  ui: LineUi;
  field: FieldKey;
  value: string;
  width?: Width;
  onChange(value: string): void;
}

function NumberBox({ ui, field, value, width = "count", onChange }: NumberProps) {
  const error = ui.errors[field];
  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={`${ui.label} ${fieldName(ui.kind, field)}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-invalid={error !== undefined}
      aria-describedby={error !== undefined ? `${ui.base}-${field}-error` : undefined}
      autoComplete="off"
      className={`${FIELD_BOX} ${WIDTH[width]} px-2 text-right`}
    />
  );
}

interface ChoiceProps<T extends string> {
  label: string;
  value: T;
  options: Options<T>;
  onChange(value: T): void;
}

function Choice<T extends string>({ label, value, options, onChange }: ChoiceProps<T>) {
  return <Select label={label} value={value} options={options.map(([value, label]) => ({ value, label }))} onChange={onChange} className={`${FIELD_BOX} px-1.5`} />;
}

const Together = ({ children }: { children: ReactNode }) => <span className="flex flex-none items-center gap-1.5">{children}</span>;

interface RangeProps {
  ui: LineUi;
  keys: readonly ["min", "max"] | readonly ["minPct", "maxPct"];
  unit: string;
  width: Width;
  min: string;
  max: string;
  onChange(min: string, max: string): void;
}

function RangeBoxes({ ui, keys: [minKey, maxKey], unit, width, min, max, onChange }: RangeProps) {
  return (
    <>
      <Together>
        <NumberBox ui={ui} field={minKey} value={min} width={width} onChange={(v) => onChange(v, max)} />
        <span>{unit} 이상</span>
      </Together>
      <Together>
        <NumberBox ui={ui} field={maxKey} value={max} width={width} onChange={(v) => onChange(min, v)} />
        <span>{unit} 이하</span>
      </Together>
    </>
  );
}

const BOUNDS = ["min", "max"] as const;

interface KindProps {
  ui: LineUi;
  line: ConditionDraft;
  onChange(line: ConditionDraft): void;
}

function KindFields({ ui, line, onChange }: KindProps) {
  const unit = UNIT[line.period];
  const choice = (name: string) => `${ui.label} ${name}`;
  const direction = <L extends Extract<ConditionDraft, { direction: Direction }>>(directed: L) => (
    <Choice label={choice("방향")} value={directed.direction} options={DIRECTIONS} onChange={(direction) => onChange({ ...directed, direction })} />
  );
  switch (line.kind) {
    case "new_high":
    case "new_low": {
      const fields = VALUE_FIELDS[ui.kind];
      return (
        <>
          {fields && <Choice label={choice("값")} value={line.field} options={fields} onChange={(field) => onChange({ ...line, field })} />}
          <Together>
            <NumberBox ui={ui} field="n" value={line.n} onChange={(n) => onChange({ ...line, n })} />
            <span>
              {unit} {(line.kind === "new_high" ? NEW_HIGH_NAME : NEW_LOW_NAME)[line.field]}
            </span>
          </Together>
        </>
      );
    }
    case "value_range":
      return (
        <>
          <Choice label={choice("값")} value={line.field} options={BAR_FIELDS} onChange={(field) => onChange({ ...line, field })} />
          <RangeBoxes ui={ui} keys={BOUNDS} unit={VALUE_UNIT[line.field]} width="amount" min={line.min} max={line.max} onChange={(min, max) => onChange({ ...line, min, max })} />
        </>
      );
    case "change":
      return (
        <>
          <Together>
            <span>종가</span>
            <NumberBox ui={ui} field="back" value={line.back} onChange={(back) => onChange({ ...line, back })} />
            <span>{unit} 전보다</span>
          </Together>
          <RangeBoxes ui={ui} keys={["minPct", "maxPct"]} unit="%" width="percent" min={line.minPct} max={line.maxPct} onChange={(minPct, maxPct) => onChange({ ...line, minPct, maxPct })} />
        </>
      );
    case "near_extreme":
      return (
        <>
          <Together>
            <span>종가가</span>
            <NumberBox ui={ui} field="n" value={line.n} onChange={(n) => onChange({ ...line, n })} />
            <span>{unit}</span>
          </Together>
          <Together>
            <Choice label={choice("고점·저점")} value={line.extreme} options={EXTREMES} onChange={(extreme) => onChange({ ...line, extreme })} />
            <span>에서</span>
          </Together>
          <Together>
            <NumberBox ui={ui} field="withinPct" value={line.withinPct} width="percent" onChange={(withinPct) => onChange({ ...line, withinPct })} />
            <span>% 안</span>
          </Together>
        </>
      );
    case "surge":
      return (
        <>
          <Choice label={choice("값")} value={line.field} options={SURGE_FIELDS} onChange={(field) => onChange({ ...line, field })} />
          <Together>
            <span>직전</span>
            <NumberBox ui={ui} field="n" value={line.n} onChange={(n) => onChange({ ...line, n })} />
            <span>{unit} 평균의</span>
          </Together>
          <Together>
            <NumberBox ui={ui} field="times" value={line.times} width="percent" onChange={(times) => onChange({ ...line, times })} />
            <span>배 이상</span>
          </Together>
        </>
      );
    case "ma_position":
      return (
        <>
          <Choice label={choice("값")} value={line.field} options={PRICE_FIELDS} onChange={(field) => onChange({ ...line, field })} />
          <Together>
            <NumberBox ui={ui} field="length" value={line.length} width="length" onChange={(length) => onChange({ ...line, length })} />
            <span>{unit}</span>
          </Together>
          <Together>
            <Choice label={choice("계산 방식")} value={line.method} options={METHODS} onChange={(method) => onChange({ ...line, method })} />
            <span>이동평균</span>
          </Together>
          <Choice label={choice("위치")} value={line.side} options={SIDES} onChange={(side) => onChange({ ...line, side })} />
        </>
      );
    case "ma_alignment":
      return (
        <>
          <Together>
            <Choice label={choice("계산 방식")} value={line.method} options={METHODS} onChange={(method) => onChange({ ...line, method })} />
            <span>이동평균</span>
          </Together>
          {line.lengths.map((length, i) => (
            <Together key={i}>
              {i > 0 && <span>·</span>}
              <NumberBox
                ui={ui}
                field={`lengths.${i}`}
                value={length}
                width="length"
                onChange={(value) => onChange({ ...line, lengths: line.lengths.map((l, j) => (j === i ? value : l)) })}
              />
              {i === line.lengths.length - 1 && <span>{unit}</span>}
            </Together>
          ))}
          <Together>
            <button type="button" className="icon-btn h-7 w-7 max-md:h-10 max-md:w-10" aria-label={`${ui.label} 이평 더하기`} title="이평 더하기" disabled={line.lengths.length >= MAX_MA_LINES} onClick={() => onChange(addMaLine(line))}>
              <PlusIcon size={14} />
            </button>
            <button type="button" className="icon-btn h-7 w-7 max-md:h-10 max-md:w-10" aria-label={`${ui.label} 이평 빼기`} title="이평 빼기" disabled={line.lengths.length <= MIN_MA_LINES} onClick={() => onChange(removeMaLine(line))}>
              <CloseIcon size={12} />
            </button>
          </Together>
          <Choice label={choice("배열")} value={line.order} options={ORDERS} onChange={(order) => onChange({ ...line, order })} />
        </>
      );
    case "ma_cross":
      return (
        <>
          <Choice label={choice("계산 방식")} value={line.method} options={METHODS} onChange={(method) => onChange({ ...line, method })} />
          <Choice label={choice("짧은 선")} value={line.fastLine} options={FAST_LINES} onChange={(fastLine) => onChange({ ...line, fastLine })} />
          {line.fastLine === "ma" && (
            <Together>
              <NumberBox ui={ui} field="fast" value={line.fast} width="length" onChange={(fast) => onChange({ ...line, fast })} />
              <span>{unit}선이</span>
            </Together>
          )}
          <Together>
            <NumberBox ui={ui} field="slow" value={line.slow} width="length" onChange={(slow) => onChange({ ...line, slow })} />
            <span>{unit}선을</span>
          </Together>
          <Together>
            {direction(line)}
            <span>교차</span>
          </Together>
        </>
      );
    case "rsi":
      return (
        <>
          <Together>
            <span>RSI</span>
            <NumberBox ui={ui} field="length" value={line.length} width="length" onChange={(length) => onChange({ ...line, length })} />
          </Together>
          <Choice label={choice("판정")} value={line.test} options={RSI_TESTS} onChange={(test) => onChange({ ...line, test })} />
          {line.test === "range" ? (
            <RangeBoxes ui={ui} keys={BOUNDS} unit="" width="percent" min={line.min} max={line.max} onChange={(min, max) => onChange({ ...line, min, max })} />
          ) : (
            <Together>
              <NumberBox ui={ui} field="value" value={line.value} width="percent" onChange={(value) => onChange({ ...line, value })} />
              {direction(line)}
            </Together>
          )}
        </>
      );
    case "macd":
      return (
        <>
          <Together>
            <span>MACD</span>
            <NumberBox ui={ui} field="fast" value={line.fast} width="length" onChange={(fast) => onChange({ ...line, fast })} />
          </Together>
          <NumberBox ui={ui} field="slow" value={line.slow} width="length" onChange={(slow) => onChange({ ...line, slow })} />
          <NumberBox ui={ui} field="signal" value={line.signal} width="length" onChange={(signal) => onChange({ ...line, signal })} />
          <Choice label={choice("판정")} value={line.test} options={MACD_TESTS} onChange={(test) => onChange({ ...line, test })} />
          {line.test === "vs_signal" ? <Choice label={choice("위치")} value={line.side} options={SIDES} onChange={(side) => onChange({ ...line, side })} /> : direction(line)}
        </>
      );
    case "stochastic":
      return (
        <>
          <Together>
            <span>스토캐스틱</span>
            <NumberBox ui={ui} field="k" value={line.k} width="length" onChange={(k) => onChange({ ...line, k })} />
          </Together>
          <NumberBox ui={ui} field="d" value={line.d} width="length" onChange={(d) => onChange({ ...line, d })} />
          <NumberBox ui={ui} field="smooth" value={line.smooth} width="length" onChange={(smooth) => onChange({ ...line, smooth })} />
          <Choice label={choice("판정")} value={line.test} options={STOCHASTIC_TESTS} onChange={(test) => onChange({ ...line, test })} />
          {line.test === "cross" ? (
            direction(line)
          ) : (
            <RangeBoxes ui={ui} keys={BOUNDS} unit="" width="percent" min={line.min} max={line.max} onChange={(min, max) => onChange({ ...line, min, max })} />
          )}
        </>
      );
    case "bollinger":
      return (
        <>
          <Together>
            <span>볼린저</span>
            <NumberBox ui={ui} field="length" value={line.length} width="length" onChange={(length) => onChange({ ...line, length })} />
          </Together>
          <NumberBox ui={ui} field="k" value={line.k} width="length" onChange={(k) => onChange({ ...line, k })} />
          <Choice label={choice("판정")} value={line.test} options={BOLLINGER_TESTS} onChange={(test) => onChange({ ...line, test })} />
          {line.test === "outside" ? (
            <Choice label={choice("위치")} value={line.side} options={BOLLINGER_SIDES} onChange={(side) => onChange({ ...line, side })} />
          ) : (
            <Together>
              <Choice label={choice("밴드")} value={line.band} options={BANDS} onChange={(band) => onChange({ ...line, band })} />
              {direction(line)}
            </Together>
          )}
        </>
      );
    case "ichimoku":
      return (
        <>
          <Together>
            <span>일목</span>
            <NumberBox ui={ui} field="conversion" value={line.conversion} width="length" onChange={(conversion) => onChange({ ...line, conversion })} />
          </Together>
          <NumberBox ui={ui} field="base" value={line.base} width="length" onChange={(base) => onChange({ ...line, base })} />
          <NumberBox ui={ui} field="spanB" value={line.spanB} width="length" onChange={(spanB) => onChange({ ...line, spanB })} />
          <NumberBox ui={ui} field="displacement" value={line.displacement} width="length" onChange={(displacement) => onChange({ ...line, displacement })} />
          <Choice label={choice("판정")} value={line.test} options={ICHIMOKU_TESTS} onChange={(test) => onChange({ ...line, test })} />
          {line.test === "cloud" ? <Choice label={choice("위치")} value={line.side} options={SIDES} onChange={(side) => onChange({ ...line, side })} /> : direction(line)}
        </>
      );
    case "market_cap":
      return <RangeBoxes ui={ui} keys={BOUNDS} unit="억 원" width="amount" min={line.min} max={line.max} onChange={(min, max) => onChange({ ...line, min, max })} />;
  }
}
