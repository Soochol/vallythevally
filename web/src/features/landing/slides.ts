export interface Slide {
  lines: readonly [string, string];
  accentLast?: boolean;
  body: string;
}

export const SLIDES: readonly Slide[] = [
  { lines: ["시세는 내 PC에.", "셋업은 어디서나."], body: "키움 REST API로 도는 개인 차트 워크스페이스." },
  { lines: ["차트 위에", "내 선을 긋는다."], body: "지표와 드로잉을 얹은 차트를 최대 8개까지 한 화면에 엽니다. 그린 선은 종목마다 그대로 남습니다." },
  { lines: ["조건으로 거르고", "바로 차트로."], body: "관심종목을 그룹으로 나누고 조건식으로 종목을 걸러 냅니다. 결과를 고르면 연동된 차트가 바로 바뀝니다." },
  { lines: ["다른 PC에서도", "같은 화면."], accentLast: true, body: "레이아웃, 드로잉, 조건식이 계정에 저장됩니다. 키움 키와 시세는 내 PC를 떠나지 않습니다." },
];

export const SERVER_NOTES = [
  { title: "내 PC에만", body: "키움 키와 토큰, 시세, 스크리너 일봉, 재무자료" },
  { title: "계정에 저장", body: "관심종목, 레이아웃, 드로잉, 조건식, 화면 상태" },
  { title: "받지 않는 것", body: "비밀번호, 이메일, 이름" },
] as const;
