# #75 화면 확인

2026-11-10, verify-app(가짜 키움, 네트워크 없음), 1440×900 Chromium. 서버 시계 `--clock 20261109100000`(월요일 10:00).

## `indicators.mjs`: 에코프로(086520) 일봉

| 파일 | 내용 |
|---|---|
| `indicators-01-start-default-volume.png` | 처음 연 칸. 기본 거래량 지표 하나가 자기 패널에 있다 |
| `indicators-02-dialog-validation-error.png` | MACD 느린 기간 5. wasm `validateSpec`의 `fast보다 커야 합니다.`가 그 칸 아래에 나오고 추가 버튼이 꺼진다 |
| `indicators-03-dialog-after-adding.png` | 대화상자로 이동평균 5·20·60·120, 볼린저, 일목, RSI, MACD, 스토캐스틱을 더한 뒤. `4개 띄움`, "이 칸에 띄운 지표" 10줄 |
| `indicators-04-chart-ten-indicators.png` | 지표 10개. 가격 패널 6개, 지표 패널 4개. 일목 선행스팬이 마지막 봉 뒤로 이어진다 |
| `indicators-05-after-edit-ma30.png` | 범례 `이동평균 단순 20` 줄의 설정 버튼 → `지표 편집` → 30 → `변경 적용` |
| `indicators-06-after-trade.png` | 가짜 키움 체결 하나(종가 120,000, 수량 300만). 범례의 이동평균 5가 117,600 → 116,500, 거래량이 50만 → 300만 |
| `indicators-07-macd-panel-moved-up.png` | 범례 MACD 줄의 `패널 위로`. 저장된 패널 순서와 화면의 범례 순서가 함께 바뀐다 |
| `indicators-08-after-reload.png` | 새로 고침 뒤. 지표 10개, 이동평균 30, 숨긴 RSI(흐린 글자)가 그대로. 그 뒤 `RSI 14 보이기`로 다시 켜고, 칸에 초점을 둔 채 `I`로 대화상자를 연다 |
| `indicators-09-phone-390.png` | 같은 칸을 390×844로. 지표 패널 범례가 각 패널 위에 놓인다 |
| `indicators-10-phone-390-dialog.png` | 휴대폰 봉 주기 줄 끝의 `지표` 버튼으로 연 대화상자(아래 시트) |

관찰값(`result.json`): 저장된 지표 종류 `volume, ma×4, bollinger, ichimoku, rsi, macd, stochSlow`. 선 시리즈의 마지막 점은 주 시리즈 마지막 봉 대비 두 개가 +3,024,000초(25거래일 뒤, 선행스팬 A·B), 하나가 −3,024,000초(후행스팬), 나머지가 0. page error 0.

## `indicators-panels.mjs`: 삼성전자(005930) 일봉

| 파일 | 내용 |
|---|---|
| `panels-01-dragged-panel.png` | 거래량 패널 경계를 위로 끌었다. 저장된 `panels[0].stretch` 0.25 → 0.535 |
| `panels-02-after-reload.png` | 새로 고침 뒤에도 높이가 그대로 |
| `panels-03-volume-removed-after-reload.png` | 범례 줄의 `패널 닫기`로 거래량을 지우고 새로 고침. 지표가 없는 채로 열린다 |
