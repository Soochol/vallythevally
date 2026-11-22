import { useQueryClient } from "@tanstack/react-query";
import type { KiwoomKey } from "../../api/generated/KiwoomKey";
import { designateMarketKey, KIWOOM_KEYS_QUERY_KEY, loadKiwoomLink } from "../../api/system";
import { confirmAction } from "../overlay/Confirm";
import { marketChangeText, marketKeyOf, pickerLabel } from "./kiwoomKeys";
import { useCommand } from "./useCommand";

export function MarketKeyPicker({ keys, now }: { keys: readonly KiwoomKey[]; now: number }) {
  const queryClient = useQueryClient();
  const command = useCommand();
  const market = marketKeyOf(keys);
  if (keys.length === 0) return null;
  if (keys.length === 1) return <p className="text-m text-text-2">시세 키 · <span className="font-semibold text-text">{keys[0]!.alias}</span></p>;

  const choose = async (keyId: string) => {
    const chosen = keys.find((key) => key.keyId === keyId);
    if (!chosen || chosen.market) return;
    if (!(await confirmAction(marketChangeText(chosen.alias), { action: "시세 바꾸기" }))) return;
    await command.run(async () => {
      queryClient.setQueryData(KIWOOM_KEYS_QUERY_KEY, await designateMarketKey({ keyId }));
      await loadKiwoomLink();
    });
  };

  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2 text-m max-md:flex-col max-md:items-stretch max-md:gap-1">
        <span className="flex-none text-text-2">시세 키</span>
        <select className="h-9 min-w-0 flex-1 rounded-s border border-line bg-bg px-2 text-m text-text focus:border-accent focus:outline-none disabled:opacity-60" disabled={command.busy} value={market?.keyId ?? ""} onChange={(e) => void choose(e.target.value)}>
          {keys.map((key) => <option key={key.keyId} value={key.keyId} className={key.link.state === "failed" ? "text-text-3" : undefined}>{pickerLabel(key, now)}</option>)}
        </select>
      </label>
      {command.error && <p role="alert" className="text-m text-danger">{command.error}</p>}
    </div>
  );
}
