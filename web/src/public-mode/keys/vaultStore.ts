import { create } from "zustand";
import { indexedDbStore, Vault, VaultError, type VaultErrorCode, type VaultView } from "../../engine/vault";

const MESSAGES: Record<VaultErrorCode, string> = {
  limit: "키는 5개까지입니다",
  duplicate_app_key: "이미 저장한 앱키입니다",
  alias_length: "별칭은 1~20자로 적으세요",
  empty_credentials: "앱키와 시크릿을 모두 적으세요",
  unknown_key: "저장된 키를 찾을 수 없습니다",
  unsupported_broker: "공개 모드에서는 키움 키만 받습니다",
  password_too_short: "비밀번호는 8자 이상으로 적으세요",
  wrong_password: "비밀번호가 맞지 않습니다",
  locked: "잠겨 있습니다. 비밀번호로 먼저 푸세요",
  wrong_lock_mode: "잠금 방식이 바뀌었습니다. 화면을 다시 확인하세요",
  key_lost: "이 브라우저의 보관소 키를 찾을 수 없습니다. 모든 키 지우기 뒤 다시 넣으세요",
  unreadable: "저장된 키를 읽지 못했습니다. 모든 키 지우기 뒤 다시 넣으세요",
  unsupported_format: "이 화면보다 새 형식으로 저장된 보관소입니다",
  missing_value: "저장된 값이 없습니다",
};

export const vaultFailureText = (e: unknown): string => (e instanceof VaultError ? MESSAGES[e.code] : "이 브라우저에 키를 저장하지 못했습니다. 비공개 창이거나 저장소가 막혀 있을 수 있습니다");

let instance: Vault | null = null;
export const browserVault = (): Vault => (instance ??= new Vault(indexedDbStore()));

interface KeyVaultStore {
  view: VaultView | null;
  loadFailure: string | null;
  load(): Promise<void>;
  apply(task: (vault: Vault) => Promise<VaultView>): Promise<void>;
}

export const useKeyVault = create<KeyVaultStore>()((set) => ({
  view: null,
  loadFailure: null,
  async load() {
    try {
      set({ view: await browserVault().view(), loadFailure: null });
    } catch (e) {
      set({ loadFailure: vaultFailureText(e) });
    }
  },
  async apply(task) {
    try {
      set({ view: await task(browserVault()), loadFailure: null });
    } catch (e) {
      void browserVault().view().then((view) => set({ view }), () => undefined);
      throw new Error(vaultFailureText(e));
    }
  },
}));

export const wipeBrowserKeys = (): Promise<void> => useKeyVault.getState().apply((vault) => vault.wipe());
