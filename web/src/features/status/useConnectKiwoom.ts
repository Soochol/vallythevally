import { connectKiwoom } from "../../api/system";
import { useCommand } from "../system-settings/useCommand";

export function useConnectKiwoom() {
  const command = useCommand();
  return { busy: command.busy, error: command.error, connect: () => void command.run(() => connectKiwoom({ acknowledged: false })) };
}
