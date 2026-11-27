import { type ReactNode, type Ref, useEffect, useId, useRef } from "react";
import { EXCLUDE_LABEL, MARKET_LABEL } from "../../lib/screener";
import type { WindowId } from "../../layout/kinds";
import { useSelectionStore } from "../../stores/selection";
import { DialogFrame, Errors } from "../dialog/DialogParts";
import { CloseIcon } from "../icons";
import { Kbd } from "../ui/Kbd";
import { SentenceConditions } from "../screener/SentenceFields";
import { removeChosen, useScreenEditing } from "../screener/useScreenEditing";
import { type ExcludeGroup, excludesIn, MARKETS, type ScreenDraft, toggleExclude, toggleMarket } from "./screenForm";

const EXCLUDE_ROWS: readonly { group: ExcludeGroup; label: string }[] = [
  { group: "kind", label: "종류 제외" },
  { group: "status", label: "상태 제외" },
];
const CHIP =
  "h-9 rounded-m border border-line px-3 text-s text-text-2 hover:text-text " +
  "aria-pressed:border-accent aria-pressed:bg-accent-soft aria-pressed:font-[600] aria-pressed:text-accent";
const TARGETS_NOTE = "고른 시장의 종목만 남기고, 고른 종류와 상태의 종목은 결과에서 뺍니다. 아무것도 고르지 않으면 전 종목이 대상입니다.";
export function ScreenDialog() {
  const dialog = useSelectionStore((s) => s.dialog);
  return dialog?.kind === "screen" ? <ScreenDialogBody window={dialog.window} /> : null;
}

function ScreenDialogBody({ window }: { window: WindowId | null }) {
  const closeDialog = useSelectionStore((s) => s.closeDialog);
  const { editing, view: { chosen } } = useScreenEditing(window);
  const ids = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => nameRef.current?.focus(), []);

  if (!chosen) return null;
  const { draft, runnable, canSave, saving: busy, nameError, alerts } = chosen;
  const dismiss = () => {
    if (!busy) closeDialog();
  };

  const submit = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canSave) return;
    const saved = editing.save();
    if (!runnable.ok) (runnable.errors.name ? nameRef.current : formRef.current?.querySelector<HTMLElement>("[aria-invalid=true]"))?.focus();
    if (await saved) closeDialog();
  };

  const remove = async () => {
    if (await removeChosen(editing, chosen)) closeDialog();
  };

  return (
    <DialogFrame labelledBy={`${ids}-title`} width="w-[min(980px,calc(100vw-32px))]" onClose={dismiss}>
      <div className="ui-dialog-head">
        <h2 id={`${ids}-title`} className="min-w-0 flex-1 truncate text-l font-[600]">
          {chosen.stored ? "조건식 편집" : "새 조건식"}
        </h2>
        <button type="button" className="icon-btn flex-none" aria-label="닫기" title="닫기 (Esc)" onClick={dismiss}>
          <CloseIcon />
        </button>
      </div>

      <form ref={formRef} onSubmit={(e) => void submit(e)} noValidate className="flex min-h-0 flex-1 flex-col">
        <ScreenFields ids={ids} draft={draft} nameError={nameError} nameRef={nameRef} locked={busy} onChange={editing.edit} />

        {alerts.length > 0 && (
          <div className="flex-none border-t border-line px-4 py-2 text-s leading-[1.45] text-danger">
            {alerts.map((message) => <p key={message} role="alert">{message}</p>)}
          </div>
        )}
        <div className="ui-dialog-foot">
          <button type="button" className="btn-danger flex-none" disabled={busy} onClick={remove}>
            삭제
          </button>
          <span className="flex items-center gap-2 text-s text-text-3 max-md:hidden">
            <Kbd>Enter</Kbd> 저장 <Kbd>Esc</Kbd> 닫기
          </span>
          <span className="flex-1" />
          <button type="button" className="btn flex-none" disabled={busy} onClick={dismiss}>
            취소
          </button>
          <button type="submit" className="btn-primary flex-none" disabled={!canSave}>
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

function FieldRow({ label, labelFor, children }: { label: string; labelFor?: string; children: ReactNode }) {
  const caption = "text-s leading-[30px] text-text-2 max-md:leading-normal";
  return (
    <div className="grid grid-cols-[92px_minmax(0,1fr)] items-start gap-3 max-md:grid-cols-1 max-md:gap-1.5">
      {labelFor ? <label htmlFor={labelFor} className={caption}>{label}</label> : <span className={caption}>{label}</span>}
      <div className="flex min-w-0 flex-col gap-1">{children}</div>
    </div>
  );
}

export function ScreenFields({ ids, draft, nameError, nameRef, locked, onChange }: FieldsProps) {
  return (
    <div className={`screen-fields flex min-h-0 flex-1 flex-col overflow-auto ${locked ? "opacity-60" : ""}`}>
      <fieldset disabled={locked} className="contents">
        <section className="screen-part"><h3>조건식 이름</h3>
          <FieldRow label="이름" labelFor={`${ids}-name`}>
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
              className="ui-field w-full max-w-[360px] px-2 placeholder:text-text-3"
            />
            <Errors id={`${ids}-name-error`} messages={nameError ? [nameError] : []} />
          </FieldRow>
        </section>
        <section className="screen-part"><h3>대상 종목</h3>
          <FieldRow label="시장">
            <div role="group" aria-label="시장" className="flex flex-wrap gap-1.5 pt-px">
              {MARKETS.map((m) => (
                <button key={m} type="button" aria-pressed={draft.markets.includes(m)} onClick={() => onChange((d) => toggleMarket(d, m))} className={CHIP}>
                  {MARKET_LABEL[m]}
                </button>
              ))}
            </div>
          </FieldRow>
          {EXCLUDE_ROWS.map(({ group, label }) => (
            <FieldRow key={group} label={label}>
              <div role="group" aria-label={label} className="flex flex-wrap gap-1.5 pt-px">
                {excludesIn(group).map((k) => (
                  <button key={k} type="button" aria-pressed={draft.exclude.includes(k)} onClick={() => onChange((d) => toggleExclude(d, k))} className={CHIP}>
                    {EXCLUDE_LABEL[k]}
                  </button>
                ))}
              </div>
            </FieldRow>
          ))}
        </section>
        <section className="screen-part text-s"><h3>조건</h3>
          <SentenceConditions ids={ids} draft={draft} locked={locked} onChange={onChange} />
        </section>
        <p className="text-xs leading-[1.5] text-text-2">{TARGETS_NOTE}</p>
      </fieldset>
    </div>
  );
}
