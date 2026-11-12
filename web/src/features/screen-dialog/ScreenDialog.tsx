import { Choice, CHOICE_LABEL, fieldName, KindFields, NumberBox, PERIODS, Together, type LineUi } from "./ConditionFields";
import { Select } from "../menu/Select";
import { confirmAction } from "../overlay/Confirm";
import { useQueryClient } from "@tanstack/react-query";
import { type Ref, useEffect, useId, useRef, useState } from "react";
import type { Screen } from "../../api/generated/Screen";
import type { Screens } from "../../api/generated/Screens";
import { saveScreens, useScreens } from "../../api/screener";
import {
  conditionSentence,
  EXCLUDE_LABEL,
  MARKET_LABEL,
  NO_CONDITIONS_SENTENCE,
  UNIT,
} from "../../lib/screener";
import { useScreenerStore } from "../../stores/screener";
import { useSelectionStore } from "../../stores/selection";
import { DialogFrame, Errors, Row } from "../dialog/DialogParts";
import { ArrowIcon, CloseIcon, PlusIcon } from "../icons";
import {
  addCondition,
  changeKind,
  type ConditionDraft,
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
  moveCondition,
  removeCondition,
  type ScreenDraft,
  toggleExclude,
  toggleMarket,
  withScreen,
} from "./screenForm";

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
      {barLine && <small className="text-xs text-text-3">마지막 봉을 포함한 실제 봉 개수입니다. 거래가 없어 봉이 없는 기간은 세지 않습니다.</small>}
      {row.ok && <p className="text-xs text-text-3">{conditionSentence(row.condition)}</p>}
    </li>
  );
}
