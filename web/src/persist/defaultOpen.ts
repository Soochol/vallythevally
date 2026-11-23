const REQUEST_KEY = "vv.open-default";

export const DEFAULT_OPEN_MESSAGE = "마지막 화면을 건너뛰고 기본 화면으로 열었습니다. 바꾼 것은 저장하지 않습니다";

export function requestDefaultOpen(): boolean {
  try {
    sessionStorage.setItem(REQUEST_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

export function takeDefaultOpenRequest(): boolean {
  try {
    const requested = sessionStorage.getItem(REQUEST_KEY) !== null;
    sessionStorage.removeItem(REQUEST_KEY);
    return requested;
  } catch {
    return false;
  }
}
