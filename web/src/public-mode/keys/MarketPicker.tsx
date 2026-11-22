import type { VaultView } from "../../engine/vault";
import { useCommand } from "../../features/system-settings/useCommand";
import { marketKeyOf } from "./keyEntry";
import { useKeyVault } from "./vaultStore";

export function MarketPicker({ view }: { view: VaultView }) {
  const apply = useKeyVault((s) => s.apply);
  const command = useCommand();
  const market = marketKeyOf(view);
  if (view.keys.length < 2) return null;
  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2 text-m max-md:flex-col max-md:items-stretch max-md:gap-1">
        <span className="flex-none text-text-2">시세 키</span>
        <select className="h-9 min-w-0 flex-1 rounded-s border border-line bg-bg px-2 text-m text-text focus:border-accent focus:outline-none disabled:opacity-60" disabled={command.busy} value={market?.keyId ?? ""} onChange={(e) => void command.run(() => apply((vault) => vault.setMarketKey(e.target.value)))}>
          {view.keys.map((key) => <option key={key.keyId} value={key.keyId}>{key.alias} · {key.maskedAppKey.slice(-4)}</option>)}
        </select>
      </label>
      {command.error && <p role="alert" className="text-m text-danger">{command.error}</p>}
    </div>
  );
}
