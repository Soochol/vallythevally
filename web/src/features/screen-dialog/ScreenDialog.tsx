import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import type { BarField } from "../../api/generated/BarField";
import type { Screen } from "../../api/generated/Screen";
import type { Screens } from "../../api/generated/Screens";
import type { ScreenPeriod } from "../../api/generated/ScreenPeriod";
import { saveScreens, useScreens } from "../../api/screener";
import { conditionSentence, EXCLUDE_LABEL, FIELD_LABEL, PERIOD_NAME, UNIT } from "../../lib/screener";
import { useScreenerStore } from "../../stores/screener";
import { useSelectionStore } from "../../stores/selection";
import { DialogFrame, Errors, Row, Segment } from "../dialog/DialogParts";
import { CloseIcon, PlusIcon } from "../icons";
import {
  addCondition,
  type ConditionDraft,
  checkCondition,
  checkDraft,
  draftOf,
  editCondition,
  type ExcludeGroup,
  excludesIn,
  MAX_CONDITIONS,
  removeCondition,
  toggleExclude,
  withScreen,
} from "./screenForm";

const PERIODS = (["D", "W", "M"] as const satisfies readonly ScreenPeriod[]).map((p) => [p, PERIOD_NAME[p]] as const);
const FIELDS = Object.keys(FIELD_LABEL) as BarField[];
const EXCLUDE_ROWS: readonly { group: ExcludeGroup; label: string }[] = [
  { group: "kind", label: "종류 제외" },
  { group: "status", label: "상태 제외" },
];
const FIELD_BOX = "h-[30px] rounded-m border border-line bg-chart-bg text-text outline-none focus:border-accent aria-invalid:border-up aria-invalid:focus:border-up";
const CHIP =
  "h-7 rounded-full border border-line px-2.5 text-s text-text-2 hover:text-text " +
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

  const remove = () => {
    const name = base.screens.find((s) => s.id === id)?.name ?? initial.name;
    if (busy || !window.confirm(`"${name}" 조건식을 삭제할까요? 되돌릴 수 없습니다.`)) return;
    void store((list) => list.filter((s) => s.id !== id), STALE_DELETE, closeDialog);
  };

  return (
    <DialogFrame labelledBy={`${ids}-title`} width="w-[min(640px,calc(100vw-32px))]" onClose={dismiss}>
      <div className="flex flex-none items-center gap-3 border-b border-line px-4 py-3">
        <h2 id={`${ids}-title`} className="min-w-0 flex-1 truncate text-l font-[650]">
          {editing ? "조건식 편집" : "새 조건식"}
        </h2>
        <button type="button" className="icon-btn flex-none" aria-label="닫기" title="닫기 (Esc)" onClick={dismiss}>
          <CloseIcon />
        </button>
      </div>

      <form ref={formRef} onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
          <Row label="이름" labelFor={`${ids}-name`}>
            <input
              ref={nameRef}
              id={`${ids}-name`}
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              aria-invalid={nameError !== null}
              aria-describedby={nameError ? `${ids}-name-error` : undefined}
              placeholder="예: 고가 200일 신고가"
              autoComplete="off"
              spellCheck={false}
              className={`${FIELD_BOX} w-full max-w-[360px] px-2 placeholder:text-text-3`}
            />
            <Errors id={`${ids}-name-error`} messages={nameError ? [nameError] : []} />
          </Row>

          <Row label="봉 주기">
            <Segment label="봉 주기" options={PERIODS} value={draft.period} onChange={(period) => setDraft((d) => ({ ...d, period }))} />
          </Row>

          <Row label="조건">
            <ol aria-label="조건" className="flex flex-col gap-2.5">
              {draft.conditions.map((c, i) => (
                <ConditionLine
                  key={c.key}
                  ids={ids}
                  index={i}
                  condition={c}
                  period={draft.period}
                  removable={draft.conditions.length > 1}
                  onChange={(patch) => setDraft((d) => editCondition(d, c.key, patch))}
                  onRemove={() => setDraft((d) => removeCondition(d, c.key))}
                />
              ))}
            </ol>
            <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
              <button
                type="button"
                className="tb-btn h-8 border border-line px-2.5 text-s disabled:opacity-40"
                disabled={draft.conditions.length >= MAX_CONDITIONS}
                onClick={() => setDraft(addCondition)}
              >
                <PlusIcon size={14} />
                조건 더하기
              </button>
              <span className="text-xs text-text-3">
                조건을 모두 만족하는 종목만 찾습니다 · {draft.conditions.length}/{MAX_CONDITIONS}줄
              </span>
            </span>
          </Row>

          {EXCLUDE_ROWS.map(({ group, label }) => (
            <Row key={group} label={label}>
              <div role="group" aria-label={label} className="flex flex-wrap gap-1.5 pt-px">
                {excludesIn(group).map((k) => (
                  <button key={k} type="button" aria-pressed={draft.exclude.includes(k)} onClick={() => setDraft((d) => toggleExclude(d, k))} className={CHIP}>
                    {EXCLUDE_LABEL[k]}
                  </button>
                ))}
              </div>
              {group === "status" && <p className="text-xs leading-[1.5] text-text-3">고른 종류와 상태의 종목은 결과에서 뺍니다. 아무것도 고르지 않으면 전 종목이 대상입니다.</p>}
            </Row>
          ))}
        </div>

        {notice && (
          <p role="alert" className="flex-none border-t border-line px-4 py-2 text-s leading-[1.45] text-up">
            {notice}
          </p>
        )}
        <div className="flex flex-none items-center gap-2 border-t border-line px-4 py-2">
          {editing && (
            <button type="button" className="h-8 flex-none rounded-m px-3 text-up hover:bg-raised disabled:opacity-50" disabled={busy} onClick={remove}>
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

interface LineProps {
  ids: string;
  index: number;
  condition: ConditionDraft;
  period: ScreenPeriod;
  removable: boolean;
  onChange(patch: Partial<Omit<ConditionDraft, "key">>): void;
  onRemove(): void;
}

function ConditionLine({ ids, index, condition, period, removable, onChange, onRemove }: LineProps) {
  const label = `조건 ${index + 1}`;
  const base = `${ids}-condition-${condition.key}`;
  const row = checkCondition(condition, period);
  const errors = row.ok ? { n: null, m: null } : row.errors;
  const unit = UNIT[period];
  const count = (key: "n" | "m", name: string) => (
    <input
      type="text"
      inputMode="numeric"
      aria-label={`${label} ${name}`}
      value={condition[key]}
      onChange={(e) => onChange({ [key]: e.target.value })}
      aria-invalid={errors[key] !== null}
      aria-describedby={errors[key] !== null ? `${base}-${key}-error` : undefined}
      autoComplete="off"
      className={`${FIELD_BOX} w-[84px] px-2 text-right max-md:w-[72px]`}
    />
  );
  return (
    <li className="flex flex-col gap-1">
      {index > 0 && <span className="text-xs font-[600] text-accent">그리고</span>}
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5 text-s text-text-2">
        <select
          aria-label={`${label} 값`}
          value={condition.field}
          onChange={(e) => onChange({ field: e.target.value as BarField })}
          className={`${FIELD_BOX} px-1.5`}
        >
          {FIELDS.map((f) => (
            <option key={f} value={f}>
              {FIELD_LABEL[f]}
            </option>
          ))}
        </select>
        {count("n", "신고가 기간")}
        <span>
          {unit} {condition.field === "volume" ? "신고거래량" : "신고가"},
        </span>
        <span>최근</span>
        {count("m", "최근 봉 수")}
        <span>{unit} 안에</span>
        <span className="flex-1" />
        <button type="button" className="icon-btn h-7 w-7 max-md:h-10 max-md:w-10" aria-label={`${label} 빼기`} title="조건 빼기" disabled={!removable} onClick={onRemove}>
          <CloseIcon />
        </button>
      </div>
      <Errors id={`${base}-n-error`} messages={errors.n ? [`신고가 기간: ${errors.n}`] : []} />
      <Errors id={`${base}-m-error`} messages={errors.m ? [`최근 봉 수: ${errors.m}`] : []} />
      {row.ok && <p className="text-xs text-text-3">{conditionSentence(period, row.condition)}</p>}
    </li>
  );
}
