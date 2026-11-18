# e2e 중복 시험 정리 플랜 (e2e-overlap 결과 구현)

작성일 2026-11-18. 승인 시점의 기록이며 구현 중 바뀐 것은 반영하지 않는다.

기준: `origin/main` af55994d. 근거 보고서: `/home/dev/.claude/orch/reports/e2e-overlap/e2e-overlap.md`(저장소 밖, 읽기 전용. 2절 후보 표, 5절 추천 묶음, 부록 A·B·C). 보고서의 줄 번호는 e36b2d33 기준이다. af55994d까지 `web/e2e`에서 바뀐 파일은 `budget-reporter.ts`, `order-window.ts`, `win-book.spec.ts`, `win-order-panels.spec.ts`이고 이 플랜이 고치는 파일과 겹치지 않는다. 다만 이 플랜보다 먼저 머지될 e2e-speedup의 `save-poll`·`dock-settle`이 같은 spec의 poll 줄을 바꾸므로 작업자는 줄 번호가 아니라 시험 제목으로 찾는다.

## 사용자가 풀려는 문제

e2e에 같은 것을 다시 확인하는 시험이 있다. e2e-overlap 조사는 47개 spec(시험 약 430개, 시간 합 약 1413초)에서 겹침을 찾았다. 가장 큰 것은 같은 36개 도구를 `pickTool`로 고르는 일이 drawing 쪽에서 네 번 일어나는 것과, 같은 스크리너 단계가 여러 spec에 흩어진 것이다. 사용자는 같은 것을 확인하는 다른 시험이 있어 잃는 것이 없는 후보를 먼저 고르고, 잃는 것이 있는 후보 중 일부를 더했다. 목표는 검증을 약하게 하지 않고 시험 시간 합을 줄이는 것이다.

## 확정된 결정 (사용자)

- 잃는 것 없는 묶음: P1(drawing 도구 반복: A-1, A-2, A-3, A-4, A-4b, A-11), P2(drawing 작은 중복: A-5b, A-6~A-10), P4(win: C1~C7), P6(screener: Z1~Z11).
- 잃는 것 있는 묶음 가운데 다음만 한다(오케스트레이터를 거쳐 받은 범위 추가, 요청서보다 우선).
  - P3의 B-1: 빈 단축키 시험 11개와 빠짐없음 시험을 `toolTitle`·`TOOL_HOTKEYS` 단위 시험으로 옮긴다. `toolTitle`을 export한다.
  - P3의 B-9: 도구별 지우개 시험 4개와 빠짐없음 시험을 `renderItem`과 `hitTest` 단위 시험으로 옮긴다. 지우개 흐름 자체의 e2e(`drawing-modes.spec.ts`의 첫 지우개 시험)는 남긴다.
  - B-1·B-9의 단위 시험은 같은 규칙을 모든 `TOOLS`에 대해 확인한다.
  - P7의 L6·L7·L8·L9: 시험을 합친다. 단언은 모두 남긴다.
  - P7의 L1: `lime-screener.spec.ts`를 지운다. 그 전에 "종류 제외 ETF가 저장본에 `exclude: ["etf"]`로 남는다"는 단언을 남는 스크리너 시험 하나로 옮긴다.
- 하지 않는 것: 그 밖의 B 계열, C8~C25, L2~L5, L4b. B-10은 e2e-speedup의 `wait-clock`과 겹쳐 하지 않는다.
- 후보마다 고치기 전에 보고서의 "겹치는 시험" 줄을 다시 열어 단언을 비교한다. 정말 같은 것을 확인할 때만 빼거나 합친다. 다르면 그 후보는 하지 않고 이유를 PR 본문에 적는다. 보고서 8절이 적었듯 하위 에이전트 결과를 다 다시 확인하지 않았기 때문이다.
- 뺀 단언마다 같은 것을 확인하는 남은 시험의 파일:줄을 PR 본문에 적는다.
- 같은 파일을 고치는 drawing 묶음은 P1 다음에 P2를 한다. 영역 사이(drawing, win, screener)는 병렬로 한다.
- e2e-speedup과 같은 파일은 그 작업이 머지된 main 위에서 고친다.
- 전후 측정은 고친 파일만 `--workers=1`로 한다. 전체 e2e는 돌리지 않는다. 머지 뒤 검사가 돈다.

## 작업과 순서

| 작업 | 후보 | 고칠 곳 | 방식 | 순서 |
|---|---|---|---|---|
| `dedupe-draw-tools` | P1: A-1, A-2, A-3, A-4, A-4b, A-11 | `drawing-engine.spec.ts`, `drawing-tools-all.spec.ts`, `drawing-tools-line.spec.ts`, `drawing-tools-pattern.spec.ts`(삭제), `rules-baseline.json` | basic: 시험 코드만 고친다 | e2e-speedup `wait-clock` 머지 뒤 |
| `dedupe-draw-small` | P2: A-5b, A-6, A-7, A-8, A-9, A-10 | `drawing-tools-line.spec.ts`, `drawing-select.spec.ts`, `drawing-engine.spec.ts`, `drawing-tools-note.spec.ts`, `drawing-past.spec.ts`, `drawing-dock-collapse.spec.ts` | basic: 시험 코드만 고친다 | `dedupe-draw-tools` 뒤 |
| `dedupe-draw-unit` | B-1, B-9 | `drawing-tools-all.spec.ts`, `drawing-modes.spec.ts`, `web/src/features/drawings/DrawingToolbar.tsx`(export), 필요하면 `web/src/chart/drawings/modes/eraser.ts`(export), 새 단위 시험 | basic: 시험과 동작을 바꾸지 않는 export만 고친다 | `dedupe-draw-tools` 뒤 |
| `dedupe-win` | P4: C1~C7 | `win-shell`, `win-manage`, `win-journey`, `win-dock`, `win-dock-maximize`, `win-canvas`, `win-float`의 spec | basic: 시험 코드만 고친다 | e2e-speedup `retry-clock` 머지 뒤 |
| `dedupe-screener` | P6: Z1~Z11 | `screener-conditions`, `screener-current`, `screener-phone`, `screener-row-menu`, `screener-trade-highs`, `screener-no-conditions`, `sentence-conditions`의 spec | basic: 시험 코드만 고친다 | 처음부터 |
| `dedupe-screener-merge` | L1, L6, L7, L8, L9 | `lime-screener.spec.ts`(삭제), `screener-results.spec.ts`(삭제), `screener-row-menu.spec.ts`, `screener-phone.spec.ts`, `screener.spec.ts` | basic: 시험 코드만 고친다 | `dedupe-screener` 뒤 |

순차로 둔 이유:

- `dedupe-draw-small`은 `dedupe-draw-tools` 뒤다. 둘 다 `drawing-engine.spec.ts`와 `drawing-tools-line.spec.ts`를 고친다. P1은 engine의 도구 고르기 슬라이스와 휴대폰 시험, line의 첫 시험을 지우고, P2는 같은 파일의 다른 시험을 합치거나 지운다. A-4·A-5b가 지나면 line 파일은 핸들 끌기 3개만 남는다. 뒤 작업이 앞 작업이 남긴 파일을 보고 고치는 편이 충돌이 없다.
- `dedupe-draw-unit`은 `dedupe-draw-tools` 뒤다. 둘 다 `drawing-tools-all.spec.ts`를 고친다(P1은 슬라이스 시험과 L473 시험, B-1은 빈 단축키 시험). 사용자가 순서를 정하라고 했다. `dedupe-draw-small`과는 겹치는 파일이 없어 병렬이다.
- `dedupe-screener-merge`는 `dedupe-screener` 뒤다. 둘 다 `screener-row-menu.spec.ts`(Z6·Z7과 L6·L8)와 `screener-phone.spec.ts`(Z5와 L9)를 고친다. L6은 Z6이 지우는 시험의 이웃 시험을 합치므로 같은 영역을 다시 짠다.

e2e-speedup과의 순서: 오케스트레이터는 `save-poll`·`dock-settle`이 머지된 뒤 이 플랜을 시작한다. 그 밖에 같은 파일이 두 곳 있다. `tasks.json`의 `after`는 이 플랜 안의 작업만 가리키므로, 해당 지시서에 시작 때 확인하라고 적었다.

- `retry-clock`이 `win-manage.spec.ts`와 `rules-baseline.json`을 고친다. `dedupe-win`은 C2로 `win-manage.spec.ts`의 시험 하나를 지운다.
- `wait-clock`이 `drawing-dock-collapse.spec.ts`와 `rules-baseline.json`을 고친다. `dedupe-draw-small`은 A-10으로 collapse 파일을 고치고, `dedupe-draw-tools`는 pattern spec을 지우면서 `rules-baseline.json`의 그 파일 항목을 고친다.

그래서 `dedupe-draw-tools`(와 그 뒤의 두 drawing 작업)는 `wait-clock`이 머지된 뒤, `dedupe-win`은 `retry-clock`이 머지된 뒤 시작한다. `dedupe-screener`는 바로 시작해도 된다. `screener-row-menu.spec.ts:81`의 poll(Z7)은 `save-poll`이 바꾸는 줄이고, 이 플랜이 시작될 때는 이미 머지돼 있다.

## 스스로 정한 결정과 이유

### 후보를 하는 기준

- 보고서 후보 행의 "잃는 것" 칸에 적힌 단언이 남는 시험에 없으면 그 단언은 지우지 않는다. 남는 시험에 옮길 수 있으면 옮기고 후보를 하고, 옮길 수 없으면 그 부분은 남긴다. 다음 후보는 보고서가 "잃는 것 없음" 표에 두었지만 칸에 작은 차이를 적었다. 지시서에 이 처리를 이름으로 적었다.
  - A-4: `drawing-tools-line.spec.ts`의 첫 시험은 새로고침 두 번 사이 화면 좌표가 같은지 본다. `drawing-tools-all.spec.ts`의 데스크톱 슬라이스는 새로고침 뒤 도구·점·서버 상태만 본다. 그래서 슬라이스 시험에 "새로고침 전과 뒤의 mirror 점 좌표가 같다"를 더한 뒤 line 시험을 지운다. 이렇게 하면 36개 도구 전부가 확인되어 오히려 넓어진다. 앱이 새로고침 때 보기를 바꿔 좌표가 정당하게 달라지면 A-4는 하지 않는다.
  - Z2: 월봉(M)·KRX 조합과 저장 PUT 횟수(`screenSaves` 4) 단언이 다른 곳에 없으면 그 단언은 남긴다.
  - Z10: 9조합을 3조합((D,1),(W,2),(M,3))으로 줄이는 것만 한다. 마지막 편집 단계(값 범위와 줄 추가를 한 번에 저장)는 다른 시험에 같은 조합이 없어 남긴다.
- 테스트 산출물로만 쓰는 스크린샷(`testInfo.outputPath`)은 단언이 아니다. Z1처럼 시험을 지우면 함께 없어진다. `target/ux-screens`에 쓰는 스크린샷(L8의 `screener-results.spec.ts`)은 다른 사람이 볼 수 있어 합친 시험에 같은 이름으로 남긴다.

### A-3의 시간 확인

A-3(휴대폰 9개를 데스크톱 슬라이스 끝에 이어 붙이기)은 절감 약 49초가 추정이다. 보고서가 권한 대로 슬라이스 하나에 먼저 적용해 전후 시간을 잰다. 줄어들면 나머지 슬라이스에 적용한다. 합친 시험이 30초 예산을 넘거나 줄지 않으면 A-3과, A-3에 기대는 A-2를 하지 않고 측정값을 보고한다.

### 단위 시험 위치 (B-1, B-9)

- B-1: `toolTitle`은 보고서가 적은 `chart/drawings`가 아니라 `web/src/features/drawings/DrawingToolbar.tsx:25`에 있다. 단위 시험은 그 옆(`web/src/features/drawings/`)에 둔다. 확인하는 것은 모든 `TOOLS`에 대해 `toolTitle` 결과에 `()`가 없고, `TOOL_HOTKEYS`(`web/src/chart/drawings/hotkeys.ts`)의 단축키 문자열이 비어 있지 않다는 것이다.
- B-9: 사용자 문구는 `renderItem`+`hitTest`지만, 지우개(`web/src/chart/drawings/modes/eraser.ts`)는 `geometry.ts`의 `hitTest`가 아니라 `hitShape`와 핸들 거리로 고른다. 단위 시험이 지우개와 다른 함수를 확인하면 같은 규칙이 아니므로, 지우개가 쓰는 판정 경로를 부른다(필요하면 eraser.ts의 판정 함수를 export한다. 동작은 바꾸지 않는다). 모든 `TOOLS`마다 `renderItem`을 만들고, 핸들에서 떨어진 몸통 위 한 점에서 맞고 몸통에서 먼 한 점에서는 맞지 않음을 본다. 핸들 거리로 맞는 것은 몸통 맞음이 아니므로 그 점은 핸들에서 `HANDLE_HIT_PX`보다 멀리 둔다.

### 고정 대기 허용 목록

`drawing-tools-pattern.spec.ts`를 지우면 `rules-baseline.json`의 그 항목(1)을 지운다. 파일이 없는데 0을 남기면 쓸모없는 항목이 된다. e2e-speedup은 남은 파일의 0 항목을 지우지 않기로 했는데, 그것은 파일이 남는 경우다. 다른 줄은 건드리지 않는다.

### 측정과 흔들림 확인

- 전후 시간은 같은 base에서 고치기 전과 뒤에 `python3 scripts/web.py e2e --workers=1 e2e/<고친 파일>…`로 잰다. 지운 spec은 전 측정에만 넣는다. 결과의 `results/durations.json`에서 파일별 시험 시간 합을 표로 적는다.
- 합친 시험 가운데 늦은 응답·충돌·화면 폭 전환을 이어서 다루는 것(A-3, L7, L9)은 `env VALLY_E2E_CPU_THROTTLE=4 python3 scripts/web.py e2e --workers=1 --repeat-each=3 e2e/<파일>.spec.ts:<줄>`로 반복해 확인한다. 같은 시험을 동시에 여러 벌 돌리지 않는다.

## 범위 밖

- P3의 B-2~B-8, B-10, P5(C8~C25), P7의 L2~L5·L4b.
- 보고서 8절의 스크리너 기본 상태 바꾸기(`readyStatus()`로 시작), 자동 저장 디바운스를 가짜 시계로 넘기기.
- 대상 밖 spec(`list-format`, `watchlist-actions`, `indicator-inspector` 등)은 고치지 않는다. 이 플랜의 근거로 쓰이므로 지우지 않는다(Z5, Z6, C1의 근거).
- `docs/testing-screener-migration.md`의 시험 수 갱신.
- 앱 코드 변경. 예외는 B-1의 `toolTitle` export와 B-9에 필요하면 지우개 판정 함수 export이고, 동작은 바꾸지 않는다.

## 사용자가 정해야 하는 결정

- 없음. 검증을 약하게 하는 후보는 사용자가 고른 B-1, B-9, L1(ETF 단언은 옮김)뿐이다. 보고서가 적은 그 후보들의 잃는 것은 다음과 같다.
  - B-1: 도구 36개마다 별표 고정 클릭이 저장 설정까지 가는 배선은 `hline` 하나(`drawing-controls.spec.ts`)와 설정을 주입한 `drawing-pinned-dock.spec.ts`만 확인한다. 브라우저의 `title`이 `toolTitle` 결과인지는 더 보지 않는다.
  - B-9: 실제 캔버스의 몸통 좌표를 클릭으로 지우는 확인은 지우개 흐름 시험 하나로 줄어든다. 단위 시험의 투영은 가짜다.
  - L1: 장중 시계(`clockStart: 20261109100030`)에서의 편집과 그 시험의 스크린샷이 빠진다.
- L6·L7·L9는 시험 독립성을 잃는다. 하나가 실패하면 그 뒤 단언이 가려진다. 사용자가 받아들였다.
