import type { KeyView, VaultView } from "../../engine/vault";
import type { KeyEntry } from "../../features/system-settings/kiwoomKeys";

const filled = (value: string) => value.trim() !== "";

export const defaultAlias = (view: VaultView): string => `키움 ${view.keys.length + 1}`;

export const atLimit = (view: VaultView): boolean => view.keys.length >= view.limit;

export type KeyEdit = { alias?: string; credentials?: { appKey: string; appSecret: string } };

export function keyEdit(entry: KeyEntry, current: KeyView): KeyEdit | null {
  const alias = entry.alias.trim();
  if (alias === "" || filled(entry.appKey) !== filled(entry.appSecret)) return null;
  const edit: KeyEdit = {};
  if (alias !== current.alias) edit.alias = alias;
  if (filled(entry.appKey)) edit.credentials = { appKey: entry.appKey.trim(), appSecret: entry.appSecret.trim() };
  return edit.alias === undefined && edit.credentials === undefined ? null : edit;
}

export const marketKeyOf = (view: VaultView): KeyView | undefined => view.keys.find((key) => key.market);
