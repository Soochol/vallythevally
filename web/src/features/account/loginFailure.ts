const CANCELLED = "로그인을 취소했습니다";

const TEXT: Record<string, string> = {
  state: "이 브라우저에서 시작한 로그인이 아니어서 받지 않았습니다. 다시 로그인하세요",
  cancelled: CANCELLED,
  access_denied: CANCELLED,
  account_limit: "새 계정을 더 받지 않습니다. 이미 만든 계정으로는 로그인할 수 있습니다",
  blocked: "이 계정은 쓸 수 없습니다",
  idp_failed: "Google 또는 네이버가 로그인을 마치지 못했습니다. 잠시 뒤 다시 시도하세요",
  bad_request: "로그인 응답이 올바르지 않았습니다. 다시 시도하세요",
  local_only: "이 PC는 계정 서버를 쓰지 않아 로그인할 수 없습니다",
  exchange_failed: "계정 서버가 로그인을 받아들이지 않았습니다. 다시 시도하세요",
  server_unreachable: "계정 서버에 연결하지 못했습니다. 잠시 뒤 다시 시도하세요",
  storage: "이 PC에 로그인 정보를 저장하지 못했습니다. 저장 폴더의 권한을 확인하세요",
};

const UNKNOWN = "로그인하지 못했습니다. 다시 시도하세요";

export const loginFailureText = (reason: string | null): string => (reason !== null && Object.hasOwn(TEXT, reason) ? TEXT[reason]! : UNKNOWN);

export function takeLoginFailure(url: URL): { text: string; cleaned: string } | null {
  if (url.searchParams.get("login") !== "error") return null;
  const text = loginFailureText(url.searchParams.get("reason"));
  const rest = new URL(url);
  rest.searchParams.delete("login");
  rest.searchParams.delete("reason");
  return { text, cleaned: rest.pathname + rest.search + rest.hash };
}
