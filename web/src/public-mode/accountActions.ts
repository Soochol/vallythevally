import { sendNoContent } from "../api/http";
import { ACCOUNT_PATH, LOGOUT_PATH } from "./session";
import { wipeBrowserKeys } from "./keys/vaultStore";
import { markSignedOut } from "./signedOut";

export async function logoutPublic(): Promise<void> {
  await sendNoContent("POST", LOGOUT_PATH, "{}");
  markSignedOut();
}

export async function deletePublicAccount(options: { clearBrowserKeys: boolean }): Promise<void> {
  await sendNoContent("DELETE", ACCOUNT_PATH, "{}");
  try {
    if (options.clearBrowserKeys) await wipeBrowserKeys();
  } finally {
    markSignedOut();
  }
}
