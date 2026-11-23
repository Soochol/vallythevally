# UI 고도화 나머지 22항목 플랜

작성일 2026-11-23. 승인 시점의 기록이며 구현 중 바뀐 것은 반영하지 않는다.

기준: `origin/main` d74851db. 원래 플랜은 `docs/plans/ui-polish.md`다(갈림길 16개 확정, 작업 27개). 이 문서는 남은 22개를 어떻게 나누고 어떤 순서로 할지, 원래 플랜 뒤에 바뀐 것만 적는다. 토큰·공통 부품·성능 규칙·표기 규칙과 작업별 결정은 원래 플랜을 따른다.

방식: lane. 사용자가 lane 방식을 지시했고, 22항목은 한 세션이 차례로 하기에 너무 크다. 영역끼리는 독립이라 작업자 여럿이 나눠 맡을 수 있고, 주문 창처럼 위험한 일은 화면 조정과 따로 리뷰받아야 한다(아래 `## 나누는 이유`).

## 사용자가 풀려는 문제

> fable5.2모델로 현재 프로젝트의 모든 ui를 캡쳐하고 uiux를 더 세련되고 , 사용자 편의성, 가독성 개선할 수 있도록 플래닝하고, claude artifact로 제안해줘
> 상용서비스로 사용할 수 있을 정도의 극도의 고도화로 제안해줘

남은 일의 방식은 다음 지시에서 왔다.

> lane 방식으로 ui polish 진행해줘봐

- 앞의 세 작업 `ui2-css-split`(#833), `ui2-tokens`(#836), `ui2-primitives`(#840)는 main에 있다. 약속 작업 둘(토큰, 공통 부품)과 일괄 이관(CSS 나누기)이 끝났으니 lane은 앞 작업을 기다리지 않고 바로 시작한다.
- 사용자는 성능을 가장 중요하게 본다.

## 확정된 결정

1. 원래 플랜의 갈림길 16개는 그대로이고 다시 묻지 않는다. 갈림길 3(밀도)은 사용자가 촘촘을 골랐다. 설정은 기본 34px과 촘촘 28px 둘이고, 처음 값은 촘촘이다.
2. 남은 22항목은 lane 방식으로 나눈다. 항목 ID는 원래 작업 이름(`ui2-*`)을 그대로 쓴다.
3. `ui2-statusbar`와 `ui2-screener`는 이 플랜에 넣지 않는다. 다른 탭의 screener-kis-summary가 `features/status`와 `features/screener`를 고치고 있어서다(2026-11-23 기준 PR 없음). 그것이 병합된 뒤 따로 한다.
4. 실제 키움·한투는 부르지 않는다. 합성 transport와 시험이 주는 합성 키만 쓴다.
5. 성능 항목(`ui2-mw-perf`, `ui2-list-rows`, `ui2-heatmap`)은 고치기 전과 뒤의 그리기 횟수를 시험으로 남긴다(원래 플랜의 성능 규칙 8).
6. 시험·검증을 약하게 하는 일은 넣지 않는다. 단언을 지우거나 느슨하게 하지 않고 시험 제한 시간을 늘리지 않는다.
7. `ui2-onboarding`에서 공개 모드 화면을 뺀다. 오케스트레이터가 권장안대로 진행하라고 전했다(아래 "원래 플랜 뒤에 바뀐 것").

## 나누는 이유

- (가) 규모. 원래 플랜은 한 항목을 400~900줄로 추정했다. 22항목이면 약 9천~2만 줄이고, 한 세션이 차례로 하면 그만큼 끝이 늦어진다. 영역끼리는 고치는 파일이 겹치지 않으니 병렬로 돌릴 때 이득이 크다.
- (다) 위험한 일과 쉬운 일을 가른다. 주문 취소 흐름(`ui2-order-safety`)과 키 입력·실전 주문 켜기(`ui2-settings`)는 화면 조정(`ui2-market-windows` 등)과 리뷰의 무게가 다르다. 쉬운 일을 위험한 일의 PR에 끼우지 않는다.

## 작업

일곱 작업이고 PR도 일곱이다. lane 여섯과 항목 하나짜리 작업 하나다. 크기는 원래 플랜의 항목당 추정(400~900줄)을 더한 것이다.

| 작업 | 영역 | 항목(하는 순서) | 방식 | 먼저 | 예상 크기 |
|---|---|---|---|---|---|
| `lane-order` | 호가주문 창 | `ui2-mw-perf` → `ui2-order` → `ui2-order-safety` | poteto | 없음 | 1,200~2,700줄 |
| `ui2-market-windows` | 시세 창(10호가·체결·프로그램·거래원) | `ui2-market-windows` | basic | `lane-order`(after_ready) | 400~900줄 |
| `lane-lists` | 관심종목·순위 목록 | `ui2-list-rows` → `ui2-ranking` | poteto | 없음 | 800~1,800줄 |
| `lane-pages` | 위 막대·페이지(시장 종합·히트맵·ETF) | `ui2-topbar` → `ui2-page-frame` → `ui2-heatmap` → `ui2-market-page` → `ui2-etf` | basic | 없음 | 2,000~4,500줄 |
| `lane-shell` | 셸 상태·찾기·창 틀 | `ui2-shell-states` → `ui2-search` → `ui2-dock-tabs` → `ui2-dock-fit` | poteto | 없음 | 1,800~3,500줄 |
| `lane-chart` | 차트 칸 | `ui2-chart-axis` → `ui2-chart-legend` → `ui2-chart-tools` → `ui2-drawings` | poteto | 없음 | 1,600~3,600줄 |
| `lane-settings` | 시스템 설정·처음 설정 | `ui2-settings` → `ui2-onboarding` → `ui2-density` | poteto | `lane-lists`(after_ready) | 1,200~2,700줄 |

### 방식과 이유

- `lane-order` poteto: 실시간 구독·렌더 구조(`ui2-mw-perf`)와 주문 취소 흐름(`ui2-order-safety`)을 바꾼다.
- `ui2-market-windows` basic: 화면 조정이다. 위험한 `lane-order`에 끼우지 않으려고 따로 뺐다.
- `lane-lists` poteto: `ui2-list-rows`가 실시간 줄의 구독과 렌더 구조를 바꾼다.
- `lane-pages` basic: 화면 조정과 렌더 범위다. `ui2-heatmap`의 그리기 범위는 원래 플랜에서도 basic이었고, 그리기 횟수 시험(확정된 결정 5)으로 지킨다.
- `lane-shell` poteto: `ui2-dock-fit`이 창 배치 계산과 저장 상태에 닿는다.
- `lane-chart` poteto: `ui2-chart-legend`가 차트 컨트롤러의 배치 계산을 바꾼다.
- `lane-settings` poteto: `ui2-settings`가 키 입력과 실전 주문 켜기에, `ui2-onboarding`이 키 붙여넣기와 계정 덮어쓰기에 닿는다. `ui2-density`는 이 브라우저 저장소의 값과 첫 그리기 전 뿌리 속성을 다룬다.

### lane을 이렇게 묶은 이유

- lane 하나는 한 화면 묶음이고, lane끼리 `paths`가 겹치지 않는다. 함께 고치는 파일은 `shared`에 적고 최소 변경으로 한다. `docs/design-system.md`, `web/src/features/icons.tsx`, `web/src/App.tsx`, `float-*` spec 넷, `PageRail.tsx`다.
- lane 안의 순서는 원래 플랜의 순서 관계를 따른다. `ui2-order`는 `ui2-mw-perf`가 줄 단위로 나눈 구조 위에서 고친다. `ui2-ranking`은 `ui2-list-rows`의 공통 줄을 쓴다. `ui2-page-frame`은 `ui2-topbar`의 위 막대 부품을 쓴다. 히트맵·시장 종합·ETF는 그 페이지 틀을 쓰고, 시장 종합은 히트맵이 공용 자리로 옮긴 색 함수도 쓴다. `ui2-dock-fit`과 `ui2-dock-tabs`는 같은 창 틀 코드를 고친다. `ui2-chart-legend`와 `ui2-chart-axis`는 같은 `ChartController.ts`를 고친다. 마법사는 설정 창이 정리한 키 폼을 쓰고, 밀도 고르기는 설정 창의 메뉴 묶음에 들어간다.
- `ui2-topbar`는 셸이 아니라 `lane-pages`의 첫 항목이다. 페이지 틀이 위 막대에 기대고, 이렇게 해야 `ui2-heatmap`(성능)이 다른 lane을 기다리지 않고 시작한다.
- `ui2-density`는 `lane-settings`의 끝이다. 설정 메뉴가 먼저 정리돼야 하고, 처음 값이 28px로 바뀌면 34px을 전제한 목록 spec들을 한 번에 맞춰야 한다. 그 spec들은 `lane-lists`가 고치므로 `lane-settings` 전체가 `lane-lists` 뒤에 선다.
- 하나뿐인 lane 밖 작업 `ui2-market-windows`는 위험·쉬움을 가른 결과다. 시세 창은 호가주문 창과 다른 화면 묶음이라 영역 수(일곱)는 넘지 않는다.

### 연결

- `ui2-market-windows` ← `lane-order`: after_ready. 같은 시세 창 코드(`features/book`·`trades`·`program`·`market-window`)를 `lane-order`가 줄 단위 구조로 바꾼 뒤 그 위에서 모양을 고친다.
- `lane-settings` ← `lane-lists`: after_ready. `ui2-density`가 `lane-lists`의 공통 줄(`--row-h`)과 34px을 단언하는 spec(`list-format`, `win-ranking`, `watch-render` 등)을 쓴다.

### 핵심 경로

핵심 경로: `lane-lists`(`ui2-list-rows` → `ui2-ranking`) → `lane-settings`(`ui2-settings` → `ui2-onboarding` → `ui2-density`). 모두 poteto 작업이고 항목 다섯이다. 그다음은 `lane-order` → `ui2-market-windows`(poteto 셋, basic 하나)와 `lane-pages`(basic 다섯)다.

### 병렬

`lane-order`, `lane-lists`, `lane-pages`, `lane-shell`, `lane-chart` 다섯이 함께 시작한다. `ui2-market-windows`와 `lane-settings`는 각자의 앞 작업이 merge-ready가 되면 그 위에서 시작한다.

### 성능 항목의 그리기 횟수

- 세는 spec(`mw-render`, `watch-render`, `heatmap-render`)을 먼저 쓰고, 고치기 전 코드에서 돌려 횟수를 센다. 고친 뒤 같은 spec이 상한을 단언한다.
- 고치기 전과 뒤의 수는 항목 커밋 메시지와 PR 본문의 표에 적는다. 고치기 전의 수를 단언하는 시험은 남기지 않는다. 고친 코드에서 실패하기 때문이다.
- 상한은 원래 지시서의 것이다. 호가 한 가격이 바뀌면 사다리 줄 1개, 종목 하나의 시세가 오면 관심종목 줄 틀 0개, 히트맵 시세 하나면 타일 1개만 다시 그린다.
- 반복 확인은 `VALLY_E2E_CPU_THROTTLE=4`에 `--workers=1 --repeat-each=5`로 한다. 원래 `ui2-mw-perf` 지시서의 `--workers=6` 반복은 같은 시험을 여러 벌 동시에 돌리는 것이라 쓰지 않는다.

### 원래 지시서를 근거로 쓴다

- 작업 지시서는 원래 플랜의 작업 지시서 22개를 항목의 근거로 가리킨다. 그 22개는 저장소 밖 `/home/dev/.claude/orch/plans/tb15262ef8f663646e9c3c9e8f8b65563d-draft-20261123-154712-ui-polish/briefs/`에 있다. 거기서 가리키는 캡처·진단·목업은 `/home/dev/.claude/orch/plans/tb75c4a5b936467916a652e0588d11762c-draft-20261123-130618-ui-polish/`에 있다. 두 폴더는 지우지 않는다.
- 항목별 성공 조건은 원래 지시서의 것을 작업 지시서에 옮겼다. 고친 곳은 `ui2-onboarding`(공개 모드 제외)과 `ui2-density`(원래 플랜 문서를 고치는 조건 제외), 반복 명령이다.
- 공통 부품은 `ui2-primitives`가 실제로 만든 이름을 쓴다(`features/ui`, `overlay/State.tsx`, `menu/Select.tsx` 등).

### 원래 플랜 뒤에 바뀐 것

- #839가 브라우저 키 화면(`web/src/public-mode/keys/`)과 `web/e2e/browser-keys.spec.ts`를 지웠다. 웹 공개판은 운영하지 않고 데스크톱 앱으로 간다(`docs/plans/desktop-app.md`).
- 그래서 `ui2-onboarding`에서 공개 모드 화면을 뺐다. 사용 불가 화면, 공개 마법사, 공개 판 설정 틀, 공개 계정 메뉴, 한도 안내다. 운영하지 않는 화면이라서다. 설정 마법사, 덮어쓰기 확인, 계정 메뉴, 다른 소유자 화면, 로그인 실패 알림은 남는다.
- 원래 `ui2-density` 지시서는 `docs/plans/ui-polish.md`를 고쳐 처음 값 촘촘을 적게 했다. 그 문서는 승인 기록이라 고치지 않고, 이 문서가 기록한다(확정된 결정 1).
- order-ledger(#826), kis-rest-edges(#829), kis-orders, ladder-gap-narrow는 병합됐다. 그래서 기다릴 다른 탭 작업이 없다.

### 건드리지 않는 곳

`features/status`, `features/screener`, `features/screen-dialog`, `styles/screener.css`는 어느 lane도 고치지 않는다(확정된 결정 3). 그쪽도 고칠 수 있는 `App.tsx`, `list-format.spec.ts`, `screener.spec.ts`, `float-shell.spec.ts`는 필요한 몇 줄만 바꾼다.

## 범위 밖

- `ui2-statusbar`, `ui2-screener`(확정된 결정 3).
- 공개 모드 화면(확정된 결정 7).
- 원래 플랜이 범위 밖으로 둔 것:
  - 휴대폰 화면 다시 짜기
  - 랜딩과 로그인 뒤 시작 화면
  - 수집 현황판
  - 밝은 테마
  - 체결 알림, 키보드 주문, 끊긴 동안 주문 막기
  - 스크리너 조건별 남은 종목 수
  - 서버 오류 문구

## 산출물

- 작업 목록: `/home/dev/.claude/orch/plans/tb15262ef8f663646e9c3c9e8f8b65563d-draft-20261123-182706-ui-polish-rest/tasks.json`(저장소 밖)
- 지시서: 같은 폴더의 `briefs/<작업 ID>.md` 일곱 개

## 미해결 사항

- `lane-pages`가 가장 크다(추정 최대 4,500줄). 리뷰 한 번에 벅차면 같은 영역 안에서 `ui2-topbar`·`ui2-page-frame`과 `ui2-heatmap`·`ui2-market-page`·`ui2-etf`로 나눌 수 있다. 그러면 뒤쪽이 앞쪽 뒤에 `after_ready`로 선다. 지금은 PR 수를 줄이려고 하나로 두었다.

## 사용자가 정해야 하는 결정

없다. 공개 모드 제외(확정된 결정 7)는 오케스트레이터가 권장안대로 진행하라고 전했다. 검증을 약하게 하는 작업(검증 단계 삭제, 시간 제한 증가, `paths` 축소)도 없다.
