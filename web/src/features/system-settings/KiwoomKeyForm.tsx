import { useLayoutEffect, useReducer } from "react";
import type { KiwoomLinkStatus } from "../../api/generated/KiwoomLinkStatus";
import type { SystemSettings } from "../../api/generated/SystemSettings";
import { deleteKiwoomKey, saveKiwoomKey, useSystemSettings } from "../../api/system";
import { confirmAction } from "../overlay/Confirm";
import { Badge } from "../ui/Badge";
import { SecretField } from "../ui/Field";
import { FormActions, KeyPortalNote, TRIMMED_HELP, useTrimNotice } from "./KiwoomKeyFields";
import { canSaveKey, EMPTY_KEY_FORM, keyFormReducer, keyLocked, keySaveNote, maskedAppKey } from "./kiwoomPanel";
import type { Command } from "./useCommand";

export const MOCK_KEY_NOTICE = "모의투자 키는 환경 설정(VALLY_KIWOOM_MOCK_APP_KEY)에서만 받습니다";

export function KiwoomKeyForm({ status, command, onSaved, onOpenIpHelp, onEditingChange }: { status: KiwoomLinkStatus | null; command: Command; onSaved(): void; onOpenIpHelp?(): void; onEditingChange?(editing: boolean): void }) {
  const [form, dispatch] = useReducer(keyFormReducer, EMPTY_KEY_FORM);
  const { trimmed, change } = useTrimNotice<"appKey" | "appSecret">(dispatch);
  const target = useSystemSettings().data?.kiwoomTarget;
  const keySource = status?.keySource;
  useLayoutEffect(() => {
    if (keySource === "env") dispatch({ type: "cancel" });
  }, [keySource]);
  const editing = form.editing && keySource !== "env";
  useLayoutEffect(() => onEditingChange?.(editing), [editing, onEditingChange]);
  if (!status) return null;
  if (status.environment === "mock") return <MockKeyNotice target={target} />;
  const locked = keyLocked(status);
  const stored = status.keySource !== "none";
  const inputs = !stored || form.editing;

  const save = async () => {
    const input = { appKey: form.appKey.trim(), appSecret: form.appSecret.trim() };
    if (!(await command.run(() => saveKiwoomKey(input)))) return;
    dispatch({ type: "saved" });
    onSaved();
  };
  const remove = async () => {
    if (!(await confirmAction("저장한 키움 키를 지웁니다", { action: "키 지우기", danger: true }))) return;
    await command.run(deleteKiwoomKey);
  };

  return (
    <section aria-label="키움 키" className="flex flex-col gap-3 rounded-m border border-line bg-surface p-4">
      <div className="flex items-center gap-2">
        <h3 className="text-m font-semibold">키</h3>
        {status.keySource === "env" && <Badge>.env에서 읽음 · 읽기 전용</Badge>}
      </div>
      <p className="text-s text-text-3">접속 대상: {target ? `${target.kind === "kiwoom" ? "키움 REST" : "로컬 시험 서버"}${target.host ? ` · ${target.host}` : ""} (고정)` : "—"}</p>
      {status.keySource === "env" ? (
        <div className="flex flex-col gap-2">
          <ReadOnlyRow label="앱키" value={maskedAppKey(status.appKeyTail)} />
          <ReadOnlyRow label="시크릿" value="읽기 전용 · 다시 볼 수 없음" />
        </div>
      ) : inputs ? (
        <form className="flex flex-col gap-3" autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (canSaveKey(form) && !command.busy) void save(); }}>
          <KeyPortalNote />
          <SecretField label="앱키" name="kiwoom-app-key" disabled={locked || command.busy} value={form.appKey} help={trimmed.has("appKey") ? TRIMMED_HELP : undefined} onChange={change("appKey")} />
          <SecretField label="시크릿" name="kiwoom-app-secret" disabled={locked || command.busy} value={form.appSecret} help={trimmed.has("appSecret") ? TRIMMED_HELP : undefined} onChange={change("appSecret")} />
          <FormActions>
            {form.editing && <button type="button" className="btn" onClick={() => dispatch({ type: "cancel" })}>취소</button>}
            <button type="submit" className="btn-primary" disabled={locked || command.busy || !canSaveKey(form)}>저장</button>
          </FormActions>
          <SaveNote note={keySaveNote(status)} onOpenIpHelp={onOpenIpHelp} />
        </form>
      ) : (
        <div className="flex flex-col gap-2">
          <ReadOnlyRow label="앱키" value={maskedAppKey(status.appKeyTail)} />
          <ReadOnlyRow label="시크릿" value="저장됨 · 다시 볼 수 없음" />
          <div className="flex justify-between gap-2">
            <button type="button" className="btn" disabled={locked || command.busy} onClick={() => dispatch({ type: "edit" })}>바꾸기</button>
            <button type="button" className="btn text-danger" disabled={locked || command.busy} onClick={() => void remove()}>지우기</button>
          </div>
        </div>
      )}
      {status.keySource === "env" && <p className="text-s text-text-3">화면에서 바꾸려면 .env에서 두 줄을 지우세요.</p>}
    </section>
  );
}

export function SaveNote({ note, onOpenIpHelp }: { note: ReturnType<typeof keySaveNote>; onOpenIpHelp?(): void }) {
  if (note === null) return null;
  if (note === "blockedBy8050") return <p className="text-s text-text-2">8050 확인을 마치기 전에는 저장해도 연결하지 않습니다</p>;
  if (note === "kisConnectsAtOnce") return <p className="text-s text-text-2">저장하면 바로 한투에 연결합니다</p>;
  return (
    <p className="text-s text-text-2">
      저장하면 바로 키움에 연결합니다. 포털에 지금 공인 IP를 먼저 등록하세요.{" "}
      {onOpenIpHelp && <button type="button" className="text-accent underline underline-offset-2" onClick={onOpenIpHelp}>공인 IP 확인 · 포털 안내 열기</button>}
    </p>
  );
}

export function ReadOnlyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 text-m max-md:flex-col max-md:items-start max-md:gap-0.5">
      <span className="w-16 flex-none text-text-2">{label}</span>
      <span className={`min-w-0 break-all text-text ${value.includes("•") ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}

function MockKeyNotice({ target }: { target: SystemSettings["kiwoomTarget"] | undefined }) {
  return (
    <section aria-label="키움 키" className="flex flex-col gap-3 rounded-m border border-line bg-surface p-4">
      <h3 className="text-m font-semibold">키</h3>
      <p className="text-s text-text-3">접속 대상: {target ? `${target.kind === "kiwoom" ? "키움 모의투자" : "로컬 시험 서버"}${target.host ? ` · ${target.host}` : ""} (고정)` : "—"}</p>
      <p className="text-m text-text" data-testid="mock-key-notice">{MOCK_KEY_NOTICE}</p>
    </section>
  );
}
