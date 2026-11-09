# tradingview.com 직접 관찰 시도 (2026-11-09)

로그인하지 않은 상태로 `https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL`을 headless Chromium(1400×850)으로 열었다. 스크립트는 `observe.mjs`, 단계 기록은 `steps.log`다.

- 차트는 열린다.
- `Alt+T`를 누르고 차트를 클릭하자 "Join for free" 가입 창이 떴다. 그 뒤의 클릭은 가입 창과 십자선만 움직였다. 드로잉은 하나도 만들어지지 않았다.
- 그래서 점 찍는 방식(클릭 두 번 / 눌러 끌기), 고른 상태의 핸들, 떠 있는 막대, 오른쪽 클릭 메뉴는 **직접 관찰하지 못했다.** 제안서는 이 항목들을 도움말 스크린숏 읽기(`tradingview-lines-fib/screenshots.md`)과 Charting Library 문서로 채우고, 근거가 없는 것은 설계 결정으로 표시했다.
- 계정으로 로그인하면 관찰할 수 있다. 이 작업은 계정을 쓰지 않았다.

`steps.log`에 남은 단계 A~J는 가입 창 때문에 아무것도 그리지 못했다. tradingview.com 화면 캡처는 공개 저장소에 두지 않는다. `observe.mjs`를 다시 돌리면 같은 자리에 캡처가 생기고, `.gitignore`가 그 png를 커밋에서 뺀다.
