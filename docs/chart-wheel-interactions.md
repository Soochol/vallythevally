# 차트 휠 동작

2026-11-12 기준. [작업 이슈 #187](https://github.com/Soochol/vallythevally/issues/187).

봉이 보이는 차트 영역에서 세로 휠을 돌리는 경우 다음처럼 동작한다.

| 입력 | 동작 |
|---|---|
| 일반 휠 | 화면 오른쪽 봉을 기준으로 시간축을 확대·축소한다. |
| Shift+휠 | 봉 간격을 유지하며 차트를 좌우로 이동한다. 휠을 위로 돌리면 과거로, 아래로 돌리면 미래로 이동한다. |
| Ctrl+휠 | 포인터 아래 봉의 가로 위치를 유지하며 확대·축소한다. macOS에서는 Command도 같은 역할을 한다. |

가로 휠과 트랙패드의 가로 이동은 기존 라이브러리 처리를 유지한다. 드로잉을 잡고 있는 동안에는 차트를 이동하거나 확대하지 않는다.

## 구현

[ChartController](../web/src/chart/ChartController.ts)의 `onWheel`은 라이브러리의 휠 처리 전에 실행된다. 일반 휠에는 `rightBarStaysOnScroll: true`, Ctrl 또는 Command에는 `false`를 적용한다. 확대·축소 자체는 Lightweight Charts 5.2.1이 처리한다.

Shift+세로 휠은 기본 처리를 막고 `scrollToPosition`으로 이동한다. 휠 이동량을 봉 간격으로 나누므로 이동 중 봉 간격은 바뀌지 않는다. 가로 이동량만 있는 이벤트는 라이브러리가 처리한다. 드로잉 캡처가 휠 조작을 끈 상태에서는 그 설정을 따른다. 차트를 제거할 때 이벤트 리스너도 제거한다.

개선 전에는 라이브러리의 기본 설정을 그대로 사용했다. 기본 휠 처리기는 Shift와 Ctrl을 구분하지 않고 세로 이동량으로 확대·축소한다. 따라서 같은 위치와 같은 세로 이동량에서는 세 입력 모두 포인터 기준으로 확대·축소했다. 근거는 [5.2.1의 공식 소스](https://github.com/tradingview/lightweight-charts/blob/v5.2.1/src/gui/chart-widget.ts)의 `_onMousewheel`과 [시간축 소스](https://github.com/tradingview/lightweight-charts/blob/v5.2.1/src/model/time-scale.ts)의 `zoom`이다.

## TradingView 비교 근거

TradingView의 [공식 단축키 목록](https://in.tradingview.com/support/shortcuts/)은 Shift+휠을 좌우 이동, Ctrl+휠을 초점 확대·축소로 안내한다. [Stay in focus](https://www.tradingview.com/blog/en/stay-in-focus-15704/)는 Ctrl 또는 Command를 누르면 확대·축소 중 고정 위치를 유지한다고 설명한다. Ctrl은 시간축 확대·축소의 기준점을 바꾼다.

일반 휠의 오른쪽 기준 동작은 [Advanced Charts Featuresets](https://www.tradingview.com/charting-library-docs/latest/customization/Featuresets/#right_bar_stays_on_scroll)의 기본 설정에 근거한다. 이 문서는 TradingView의 별도 차트 라이브러리 문서다. TradingView 웹사이트를 직접 조작해 검증한 결과는 아니다.

## 검증

[chart-wheel.spec.ts](../web/e2e/chart-wheel.spec.ts)는 두 드로잉의 화면 좌표를 측정한다. 일반 휠의 오른쪽 기준, Ctrl과 Command의 포인터 기준, Shift 이동 중 봉 간격 유지, 가로 휠, 드로잉 캡처 중 이동 차단을 확인한다. Ctrl+휠 뒤에도 브라우저의 화면 너비가 유지되는지 확인한다.

가격축과 시간축에서의 별도 조작, 트랙패드 핀치의 장치별 감도는 이 검증에 포함하지 않는다.
