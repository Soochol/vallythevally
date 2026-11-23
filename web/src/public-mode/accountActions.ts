import { sendNoContent } from "../api/http";
import { ACCOUNT_PATH, LOGOUT_PATH } from "./session";
import { markSignedOut } from "./signedOut";

export async function logoutPublic(): Promise<void> {
  await sendNoContent("POST", LOGOUT_PATH, "{}");
  markSignedOut();
}

export async function deletePublicAccount(): Promise<void> {
  await sendNoContent("DELETE", ACCOUNT_PATH, "{}");
  markSignedOut();
}
