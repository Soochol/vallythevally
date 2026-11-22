import { useMemo } from "react";
import { useOrdersStatus } from "../../api/system";
import { useOrderSettings } from "../../stores/ui";
import { chooseAccount, type OrderAccountChoice } from "./orderAccount";

export function useOrderAccount(): OrderAccountChoice {
  const status = useOrdersStatus().data;
  const saved = useOrderSettings().account;
  return useMemo(() => chooseAccount(status, saved), [status, saved]);
}
