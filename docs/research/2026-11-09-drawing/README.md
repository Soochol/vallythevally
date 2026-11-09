# 드로잉 조사 원자료 (#34, 2026-11-09)

`docs/design/drawing-proposal.md`의 근거다. 제안서는 근거를 `[접두어:번호]`로 적는다.

| 접두어 | 폴더 | 내용 |
|---|---|---|
| `L` | `tradingview-lines-fib/` | 선 7개와 피보나치 2개. TradingView 도움말(`S`), Charting Library 기본값(`CL`), 도움말 스크린숏 읽기(`IMG`) |
| `M` | `tradingview-shapes-annotations-measures/` | 도형, 주석, 측정. 도움말(`S1`~`S18`), Charting Library 기본값(`S19`~`S25`) |
| `E` | `tradingview-editing/` | 편집 경험과 단축키. 앱 안 단축키 창(`S42`) |
| `P` | `lwc-probe/` | Lightweight Charts 5.2.1 실험 코드와 결과 |
| `O` | `tradingview-observed/` | tradingview.com 직접 관찰 시도. 로그인 없이는 가입 창이 막았다 |

각 폴더의 `sources.md`가 출처 목록(URL, 가져온 날짜, 얻은 것)이다. 가져온 글과 tradingview.com 캡처는 공개 저장소에 두지 않는다. 각 폴더의 `tools.md`·`editing.md`가 그 내용을 우리 말로 정리했고, 인용은 근거를 보이는 짧은 문장만 남겼다. 도움말 스크린숏을 사람이 읽은 기록은 `tradingview-lines-fib/screenshots.md`다.

## 근거의 세기

1. **도움말 원문**(`L:S*`, `M:S1`~`M:S18`, `E:S*`): TradingView 웹 앱의 동작이다.
2. **앱 안 단축키 창**(`E:S42`): 2026-11-09에 손님 상태로 연 tradingview.com의 단축키 창이다. 원문은 저장소에 두지 않고 `editing.md`의 단축키 표가 정리했다.
3. **Charting Library 기본값**(`L:CL*`, `M:S19`): TradingView가 다른 회사에 파는 라이브러리의 기본값이다. 웹 앱의 기본값과 같다는 보장은 없다. 도움말 스크린숏 세 장(`L:IMG3`, `IMG7`, `IMG8`)은 이 값과 맞았다.
4. **스크린숏 읽기**(`L:IMG*`): 사람이 그림을 보고 적은 것이라 가장 약하다.
5. **직접 관찰**: 하지 못했다(`O`). 점 찍는 방식, 고른 상태의 핸들, 떠 있는 막대의 버튼 순서, 오른쪽 클릭 메뉴는 1~4에 없으면 제안서에 `[설계]`로 적었다.
