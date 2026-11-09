# Lightweight Charts primitive 실험 (2026-11-09)

설치된 `lightweight-charts` 5.2.1로 드로잉 엔진이 기대는 사실을 확인했다. `web/src`에는 넣지 않았다.

## 돌리는 법

```sh
node probe.mjs  /path/to/web   # results.json
node probe2.mjs /path/to/web   # results2.json
node probe3.mjs /path/to/web   # results3.json
```

`web/`의 Playwright와 `lightweight-charts` standalone 빌드를 쓴다. headless Chromium, 900×500 캔버스, `deviceScaleFactor: 1`이다. Orca 터미널에서 돌렸다. 일반 터미널에서는 `docs/dev-environment.md`의 Chromium 샌드박스 함정에 걸린다.

## 결과

| 질문 | 결과 | 근거 |
|---|---|---|
| `hitTest`가 돌려준 id가 `subscribeClick`에 오나 | 온다. `hoveredInfo.objectId === "line-A"`, 선 밖 클릭은 `objectId` 없음 | `results.json` `hitTest.clicks` |
| `hitTest`의 `cursorStyle`이 적용되나 | 된다. 선 위에서 차트 요소의 `cursor`가 `pointer` | `results.json` `hitTest.cursorWhenOverLine` |
| primitive에 누르기·끌기 API가 있나 | 없다. 차트 요소에 `pointerdown`(capture)을 달고 직접 `hitTest`를 불러야 한다 | `typings.d.ts`에 primitive용 pointer 메서드 없음 |
| 끄는 동안 차트 스크롤을 막을 수 있나 | 된다. `pointerdown`에서 `applyOptions({ handleScroll: false, handleScale: false })`, `pointerup`에서 되돌리면 선 끌기에 차트가 움직이지 않았다. 빈 곳 끌기는 평소대로 스크롤했다 | `results.json` `drag` |
| `zOrder` 세 층의 순서 | `bottom`은 봉 아래, `normal`은 봉 위·십자선 아래, `top`은 십자선 위 | `results.json` `zorder_*`, `results3.json` `candleCenter_*` |
| `priceAxisViews`·`timeAxisViews` 라벨 | 둘 다 그려진다. 가격 축 열에 자홍 16px, 시간 축 줄에 초록 34px | `results.json` `axisPixels`, `axis-labels.png` |
| `autoscaleInfo`가 가격 범위를 넓히나 | 넓힌다. `[10, 300]`을 주니 보이는 범위가 −31.6~383.1 | `results.json` `axis` |
| 소수점 논리 index를 x로 바꿀 수 있나 | **안 된다.** `logicalToCoordinate(250.25)`는 `0`을 돌려준다. 정수(`250` → 544, `251` → 550)만 된다 | `results3.json` `fractional`, 라이브러리 소스 `indexToCoordinate`: `!isInteger(index)`면 `return 0` |
| x를 소수점 논리 index로 바꿀 수 있나 | **안 된다.** `coordinateToLogical`은 `Math.ceil`한 정수를 돌려준다 | `results2.json` `coords`, 소스 `coordinateToIndex` |
| 마지막 봉 뒤의 정수 index | 된다. `304`(마지막 봉 299 + 5) → 868 | `results2.json` `coords` |
| 드로잉 수와 비용 | 아래 표 | `results2.json` `perf` |

### 비용

스크롤 120프레임 평균. 한 프레임마다 `scrollToPosition`으로 3봉씩 옮겼다. 봉 2,000개 중 1,000개가 보인다. 드로잉은 모두 화면 안의 추세선이다.

| 드로잉 수 | primitive 하나에 모두 | 드로잉마다 primitive 하나 |
|---|---|---|
| 100 | 그리기 0.02ms + 좌표 0.28ms | 그리기 0.13ms + 좌표 0.21ms |
| 500 | 그리기 0.07ms + 좌표 0.24ms | 그리기 0.31ms + 좌표 0.58ms |
| 2,000 | 그리기 0.16ms + 좌표 0.76ms | 그리기 0.87ms + 좌표 1.53ms |

- `hitTest`는 라이브러리가 마우스가 움직일 때마다 primitive마다 부른다. 60번 움직이는 동안 primitive 하나면 60번, 500개면 30,000번 불렸다(`results.json` `perf`). 60번 움직이는 동안의 `hitTest` 시간 합은 두 번 돌려 500개에서 6.3ms와 14.9ms, 2,000개에서 21.7ms와 23.7ms였다. primitive 하나일 때는 2,000개를 담아도 3.0~3.4ms였다. 호출 수는 두 번 모두 같았고, 시간은 실행마다 흔들린다. 지금 `results.json`은 둘째 실행이다.
- **이 숫자가 재는 것**: JS가 canvas 명령을 내는 시간과 좌표를 바꾸는 시간이다. 래스터화와 합성은 들어 있지 않다. headless에 GPU가 없다. `requestAnimationFrame` 간격은 모든 경우에 16.7ms(60Hz 상한)여서 프레임 시간으로는 차이를 볼 수 없었다(`results.json` `perf[].scroll`). 그래서 프레임 간격 대신 primitive 안에서 직접 잰 시간을 적었다.
- **결론**: 2,000개까지도 한 프레임 16.7ms 예산의 10% 안이다. 차이는 primitive 수에서 난다. primitive 하나에 모두 담는 쪽이 `hitTest` 호출 수와 그리기 시간에서 이긴다.
