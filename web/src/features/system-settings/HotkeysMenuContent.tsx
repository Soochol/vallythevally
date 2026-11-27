import { Fragment, useEffect, useId, useState } from "react";
import { addKey, type HotkeyActionDef, keyLabel, keyOf, moveKey, removeKey, resetAction, resetAllActions } from "../../lib/hotkeys";
import { useActionKeys, useUiStore } from "../../stores/ui";
import { CloseIcon, WarningIcon } from "../icons";
import { Badge } from "../ui/Badge";
import { Kbd } from "../ui/Kbd";
import { useHotkeyRecording } from "./hotkeyRecording";
import { groupedRows, keyPieces, LOCKED_KEY_ROWS, lockedKeyPieces, lockedReason } from "./hotkeysView";

type Notice =
  | { actionId: string; kind: "taken"; key: string; by: HotkeyActionDef }
  | { actionId: string; kind: "locked" | "owned"; key: string };

const MODIFIER_ONLY = /^(Control|Alt|Shift|Meta)(Left|Right)$/;

function Pieces({ pieces }: { pieces: readonly string[] }) {
  return (
    <>
      {pieces.map((piece, index) => (
        <Fragment key={index}>
          {index > 0 && <span aria-hidden="true" className="text-text-3">+</span>}
          <Kbd>{piece}</Kbd>
        </Fragment>
      ))}
    </>
  );
}

export function HotkeysMenuContent() {
  const hotkeys = useUiStore((s) => s.prefs.hotkeys);
  const setHotkeys = useUiStore((s) => s.setHotkeys);
  const keys = useActionKeys();
  const recordingId = useHotkeyRecording((s) => s.actionId);
  const startRecording = useHotkeyRecording((s) => s.start);
  const stopRecording = useHotkeyRecording((s) => s.stop);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirmingAll, setConfirmingAll] = useState(false);
  const searchId = useId();
  const groups = groupedRows(keys, query);
  const changedCount = Object.keys(hotkeys).length;

  useEffect(() => {
    if (recordingId === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (MODIFIER_ONLY.test(e.code)) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      stopRecording();
      if (e.code === "Escape") return;
      const key = keyOf(e);
      const result = addKey(hotkeys, recordingId, key);
      if (result.kind === "added") {
        setHotkeys(result.hotkeys);
        setNotice(null);
      } else if (result.kind === "taken") setNotice({ actionId: recordingId, kind: "taken", key, by: result.by });
      else setNotice({ actionId: recordingId, kind: result.kind, key });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recordingId, hotkeys, setHotkeys, stopRecording]);

  useEffect(() => stopRecording, [stopRecording]);

  const record = (actionId: string) => {
    setNotice(null);
    setConfirmingAll(false);
    if (recordingId === actionId) stopRecording();
    else startRecording(actionId);
  };

  const noticeText = (n: Notice) => {
    if (n.kind === "taken") return `${keyLabel(n.key)}는 "${n.by.name}"에 쓰고 있습니다. 이 동작으로 옮길까요?`;
    if (n.kind === "locked") return `${keyLabel(n.key)}는 바꿀 수 없는 키입니다. ${lockedReason(n.key)}`.trim();
    return "이미 이 동작의 키입니다";
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="sticky top-0 z-10 -mx-5 flex flex-wrap items-center gap-2 bg-[var(--glass-solid)] px-5 pb-2 pt-1 max-md:-mx-4 max-md:px-4">
        <input
          id={searchId}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="단축키 찾기"
          placeholder="동작 이름이나 키로 찾기"
          className="ui-field min-w-0 flex-1 basis-48"
        />
        <button type="button" className="btn" disabled={changedCount === 0} onClick={() => { stopRecording(); setNotice(null); setConfirmingAll(true); }}>모두 기본값으로</button>
      </div>
      {confirmingAll && (
        <div role="group" aria-label="기본값 확인" className="flex flex-wrap items-center gap-2 rounded-m border border-line bg-raised px-3 py-2 text-m">
          <span className="min-w-0 flex-1">바꾼 키를 모두 되돌릴까요?</span>
          <button type="button" className="btn" onClick={() => setConfirmingAll(false)}>취소</button>
          <button type="button" className="btn-danger" onClick={() => { setHotkeys(resetAllActions()); setConfirmingAll(false); }}>되돌리기</button>
        </div>
      )}
      {groups.length === 0 && <p className="text-m text-text-2">맞는 단축키가 없습니다</p>}
      {groups.map(({ group, label, actions }) => (
        <section key={group} aria-label={label} className="flex min-w-0 flex-col">
          <h3 className="pb-1 text-s font-semibold text-text-2">{label}</h3>
          <ul className="flex flex-col">
            {actions.map((a) => {
              const own = keys[a.id] ?? [];
              const changed = hotkeys[a.id] !== undefined;
              const recording = recordingId === a.id;
              const rowNotice = notice?.actionId === a.id ? notice : null;
              return (
                <li key={a.id} data-action={a.id} data-recording={recording || undefined} className="flex min-w-0 flex-col gap-1 rounded-m border-t border-line px-2 py-1 first:border-t-0 data-[recording]:bg-accent-soft">
                  <div className="flex min-h-9 min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="flex min-w-0 basis-40 items-center gap-2 text-m text-text">
                      <span className="min-w-0 truncate">{a.name}</span>
                      {a.desktopOnly && <Badge>데스크톱</Badge>}
                      {changed && <Badge tone="accent">바꿈</Badge>}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                      {own.length === 0 && <span className="text-s text-text-3">없음</span>}
                      {own.map((key) => (
                        <span key={key} className="sys-keychip">
                          <Pieces pieces={keyPieces(key)} />
                          <button type="button" className="icon-btn !h-5 !w-5" aria-label={`${a.name}에서 ${keyLabel(key)} 빼기`} onClick={() => { setNotice(null); setHotkeys(removeKey(hotkeys, a.id, key)); }}><CloseIcon size={12} /></button>
                        </span>
                      ))}
                      <button type="button" className="sys-keychip sys-keychip-add" aria-label={`${a.name}에 키 더하기`} aria-pressed={recording} onClick={() => record(a.id)}>
                        {recording ? "키를 누르세요 · Esc 취소" : "+ 키"}
                      </button>
                    </span>
                    {changed && <button type="button" className="btn btn-sm" onClick={() => { setNotice(null); setHotkeys(resetAction(hotkeys, a.id)); }}>기본값</button>}
                  </div>
                  {rowNotice && (
                    <div role="status" data-tone="warning" className="ui-notice mb-1">
                      <WarningIcon />
                      <span className="ui-notice-text">{noticeText(rowNotice)}</span>
                      {rowNotice.kind === "taken" && (
                        <>
                          <button type="button" className="btn btn-sm" onClick={() => setNotice(null)}>취소</button>
                          <button type="button" className="btn-primary btn-sm" onClick={() => { setHotkeys(moveKey(hotkeys, a.id, rowNotice.key)); setNotice(null); }}>옮기기</button>
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {query.trim() === "" && (
        <section aria-label="바꿀 수 없는 키" className="flex min-w-0 flex-col">
          <h3 className="pb-1 text-s font-semibold text-text-2">바꿀 수 없는 키</h3>
          <dl className="grid grid-cols-[minmax(0,14rem)_minmax(0,1fr)] gap-x-4 gap-y-2 text-m max-md:grid-cols-1">
            {LOCKED_KEY_ROWS.map(([keysText, what]) => (
              <div key={keysText} className="contents">
                <dt className="flex min-w-0 flex-wrap items-center gap-1">
                  {lockedKeyPieces(keysText).map((pieces, index) => (
                    <Fragment key={index}>
                      {index > 0 && <span aria-hidden="true" className="text-text-3">·</span>}
                      <Pieces pieces={pieces} />
                    </Fragment>
                  ))}
                </dt>
                <dd className="min-w-0 text-text-2 max-md:mb-1">{what}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </div>
  );
}
