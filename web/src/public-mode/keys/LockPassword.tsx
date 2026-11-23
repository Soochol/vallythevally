import { useState } from "react";
import { PASSWORD_MIN_LENGTH, type VaultView } from "../../engine/vault";
import { FIELD } from "../../features/system-settings/KiwoomKeyForm";
import { useCommand } from "../../features/system-settings/useCommand";
import { useKeyVault } from "./vaultStore";

type Step = "idle" | "enabling" | "disabling";

function PasswordInput({ label, value, onChange, disabled, name }: { label: string; value: string; onChange(value: string): void; disabled: boolean; name: string }) {
  return (
    <label className="flex items-center gap-2 text-m max-md:flex-col max-md:items-stretch max-md:gap-1">
      <span className="w-24 flex-none text-text-2">{label}</span>
      <input className={FIELD} type="password" name={name} autoComplete="off" spellCheck={false} disabled={disabled} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

export function UnlockForm() {
  const apply = useKeyVault((s) => s.apply);
  const command = useCommand();
  const [password, setPassword] = useState("");
  const submit = async () => {
    if (await command.run(() => apply((vault) => vault.unlock(password)))) setPassword("");
  };
  return (
    <form aria-label="잠금 풀기" className="flex flex-col gap-2 rounded-m border border-line bg-raised p-3" autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (password !== "" && !command.busy) void submit(); }}>
      <p className="text-m text-text">잠겨 있습니다. 잠금 비밀번호로 풀면 키를 바꾸거나 더할 수 있습니다</p>
      <PasswordInput label="잠금 비밀번호" name="vault-unlock-password" value={password} onChange={setPassword} disabled={command.busy} />
      <button type="submit" className="btn-primary h-9 self-start px-4 disabled:cursor-not-allowed disabled:opacity-50" disabled={command.busy || password === ""}>풀기</button>
      {command.error && <p role="alert" className="text-m text-danger">{command.error}</p>}
    </form>
  );
}

export function LockPassword({ view }: { view: VaultView }) {
  const apply = useKeyVault((s) => s.apply);
  const command = useCommand();
  const [step, setStep] = useState<Step>("idle");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const password8 = [...password].length >= PASSWORD_MIN_LENGTH;
  const reset = () => { setStep("idle"); setPassword(""); setAgain(""); };

  const enable = async () => {
    if (await command.run(() => apply((vault) => vault.enablePassword(password)))) reset();
  };
  const disable = async () => {
    if (await command.run(() => apply((vault) => vault.disablePassword(password)))) reset();
  };

  return (
    <section aria-label="잠금 비밀번호" className="flex flex-col gap-2 rounded-m border border-line bg-surface p-4">
      <h3 className="text-m font-semibold">잠금 비밀번호</h3>
      {view.lock === "auto" && step === "idle" && (
        <>
          <p className="text-s text-text-3">비밀번호를 켜면 이 컴퓨터의 브라우저 프로필을 읽는 사람과, 잠긴 동안 화면에 끼어든 스크립트를 막습니다. 비밀번호는 저장하지 않고 서버로 보내지 않습니다. 잊으면 모든 키 지우기 뒤 다시 넣어야 합니다.</p>
          <button type="button" className="tb-btn h-9 self-start px-3" onClick={() => setStep("enabling")}>잠금 비밀번호 켜기</button>
        </>
      )}
      {step === "enabling" && (
        <form aria-label="잠금 비밀번호 켜기" className="flex flex-col gap-2" autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (password8 && password === again && !command.busy) void enable(); }}>
          <PasswordInput label="비밀번호" name="vault-new-password" value={password} onChange={setPassword} disabled={command.busy} />
          <PasswordInput label="비밀번호 확인" name="vault-new-password-again" value={again} onChange={setAgain} disabled={command.busy} />
          <p className="text-s text-text-3">{PASSWORD_MIN_LENGTH}자 이상으로 적으세요{password !== "" && again !== "" && password !== again ? " · 두 번 적은 비밀번호가 다릅니다" : ""}</p>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className="btn-primary h-9 px-4 disabled:cursor-not-allowed disabled:opacity-50" disabled={command.busy || !password8 || password !== again}>켜기</button>
            <button type="button" className="tb-btn h-9 px-3" disabled={command.busy} onClick={reset}>취소</button>
          </div>
        </form>
      )}
      {view.lock === "password" && step === "idle" && (
        <>
          <p className="text-s text-text-3">잠금 비밀번호가 켜져 있습니다{view.locked ? "" : ". 풀린 키는 이 탭의 메모리에만 있습니다"}</p>
          <div className="flex flex-wrap gap-2">
            {!view.locked && <button type="button" className="tb-btn h-9 px-3 disabled:opacity-50" disabled={command.busy} onClick={() => void command.run(() => apply((vault) => vault.lock()))}>잠그기</button>}
            <button type="button" className="tb-btn h-9 px-3" onClick={() => setStep("disabling")}>잠금 비밀번호 끄기</button>
          </div>
        </>
      )}
      {step === "disabling" && (
        <form aria-label="잠금 비밀번호 끄기" className="flex flex-col gap-2" autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (password !== "" && !command.busy) void disable(); }}>
          <p className="text-s text-text-3">끄면 비밀번호를 한 번 확인한 뒤 이 브라우저가 알아서 암호화해 저장하는 방식으로 돌아갑니다</p>
          <PasswordInput label="잠금 비밀번호" name="vault-disable-password" value={password} onChange={setPassword} disabled={command.busy} />
          <div className="flex flex-wrap gap-2">
            <button type="submit" className="btn-primary h-9 px-4 disabled:cursor-not-allowed disabled:opacity-50" disabled={command.busy || password === ""}>끄기</button>
            <button type="button" className="tb-btn h-9 px-3" disabled={command.busy} onClick={reset}>취소</button>
          </div>
        </form>
      )}
      {command.error && <p role="alert" className="text-m text-danger">{command.error}</p>}
    </section>
  );
}
