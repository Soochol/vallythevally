# #76 화면 확인

2026-11-10, verify-app(가짜 키움, 네트워크 없음), 1440×900 Chromium. 서버 시계 `--clock 20261109100000`(월요일 10:00). 여정 `.claude/skills/verify-app/journeys/compare-percent.mjs`, 칸은 삼성전자(005930) 일봉.

가짜 키움은 주식 봉 요청에 모두 005930 응답을, 지수 봉 요청에 모두 코스피 응답을 준다. 그래서 비교 종목 삼성SDI·삼성화재의 선은 주 종목과 겹치고, 오늘 체결로 끝에서만 갈라진다.

| 파일 | 내용 |
|---|---|
| `compare-01-start-bollinger-normal-axis.png` | 지표 대화상자로 볼린저 밴드 20 2를 더한 직후. 일반 축 |
| `compare-02-dialog-three-compares-fourth-refused.png` | `비교 종목` 탭. 삼성SDI·삼성화재·코스피를 넣어 `비교 종목 3/3`. 삼성물산을 고르면 `삼성물산 추가`가 꺼지고 `비교 종목은 3개까지입니다`가 나온다. `가격축을 % 변화로` 스위치는 켜짐으로 잠기고 그 이유가 적혀 있다 |
| `compare-03-chart-percent-three-compares-bollinger.png` | 대화상자를 닫은 차트. 가격 패널 축이 %이고, 거래량 패널 축은 그대로다. 범례에 비교 종목 세 줄 |
| `compare-04-realtime-compares-moved.png` | 가짜 키움 체결: 삼성전자 194,000, 삼성SDI 196,500, 삼성화재 190,000. 비교 종목 줄의 마지막 종가가 193,400에서 각 체결가로 바뀐다 |
| `compare-05-zoomed-left-edge-inside-data.png` | 휠로 확대해 왼쪽 끝 봉이 첫 봉 뒤로 들어왔다. 그 봉이 0%다. 볼린저 밴드 세 선이 봉을 감싼다(라이브러리 % 모드 그대로면 선마다 자기 첫 보이는 점이 0%라, 세 선이 밴드가 시작하는 봉에서 한 점으로 모인다) |
| `compare-06-after-scroll-new-left-edge-base.png` | 끌어서 과거로 스크롤. 왼쪽 끝 봉이 다시 첫 봉이 되고 범례 %가 그 기준으로 바뀐다 |
| `compare-07-after-reload-settings-kept.png` | 새로 고침 뒤. 비교 종목 셋과 % 축이 그대로 |
| `compare-08-percent-axis-without-compares.png` | 범례 줄의 지우기 버튼으로 셋을 모두 지우면 저장된 일반 축으로 돌아간다. 그 뒤 위 막대 `%`로 비교 종목 없이 % 축을 켰다. 거래량 패널 축은 일반 축이다 |
| `compare-09-phone-390-compare-tab-switch-off.png` | 390×844. 봉 주기 줄 끝의 지표 버튼으로 연 시트의 `비교 종목` 탭. 스위치를 꺼 일반 축으로 돌렸다 |

관찰값(`result.json`):
- 저장된 `compare`는 `["006400","000810","IDX:001"]`, `scale`은 비교 종목이 있는 동안에도 `normal`.
- 가짜 키움이 REG한 항목은 0B `000810_AL`·`005930_AL`·`006400_AL`, 0J `001`.
- 범례(삼성SDI·삼성화재·코스피): 처음 −29.19%·−31.53%·−27.90%, 확대 뒤 −31.41%·−33.68%·−28.54%, 스크롤 뒤 다시 −29.19%·−31.53%·−27.90%.
- page error 0.
