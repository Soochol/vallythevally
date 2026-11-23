import { useQueryClient } from "@tanstack/react-query";
import type { KiwoomKey } from "../../api/generated/KiwoomKey";
import { designateMarketKey, loadKiwoomLink, storeKiwoomKeys } from "../../api/system";
import { Select, type SelectOption } from "../menu/Select";
import { confirmAction } from "../overlay/Confirm";
import { brokerOrder } from "./brokers";
import { marketChangeText, marketKeyOf, pickerOption } from "./kiwoomKeys";
import { useCommand } from "./useCommand";
import { useWaitingClock } from "./useWaitingClock";

const TRIGGER = "h-9 w-full min-w-0 rounded-m border border-[var(--line-strong)] bg-bg px-3 text-left text-m text-text hover:bg-hover disabled:text-text-3";

export function MarketKeyPicker({ keys }: { keys: readonly KiwoomKey[] }) {
  const queryClient = useQueryClient();
  const command = useCommand();
  const now = useWaitingClock(keys.map((key) => key.link.retryAt));
  const market = marketKeyOf(keys);
  if (keys.length === 0) return null;
  if (keys.length === 1) return <p className="text-m text-text-2">시세 키 · <span className="font-semibold text-text">{keys[0]!.alias}</span></p>;

  const choose = async (keyId: string) => {
    const chosen = keys.find((key) => key.keyId === keyId);
    if (!chosen || chosen.market) return;
    const text = marketChangeText(chosen.alias, market?.broker ?? null, chosen.broker);
    if (!(await confirmAction(text.title, { action: "시세 바꾸기", detail: text.detail }))) return;
    await command.run(async () => {
      await storeKiwoomKeys(queryClient, await designateMarketKey({ keyId }));
      await loadKiwoomLink();
    });
  };

  const options: SelectOption<string>[] = brokerOrder().flatMap((broker) => keys.filter((key) => key.broker === broker).map((key) => pickerOption(key, now)));

  return (
    <div className="sys-picker flex flex-col gap-1">
      <div className="flex items-center gap-2 text-m max-md:flex-col max-md:items-stretch max-md:gap-1">
        <span className="flex-none text-text-2">시세 키</span>
        <Select label="시세 키" className={TRIGGER} value={market?.keyId ?? ""} options={options} disabled={command.busy} onChange={(keyId) => void choose(keyId)} />
      </div>
      {command.error && <p role="alert" className="text-m text-danger">{command.error}</p>}
    </div>
  );
}
