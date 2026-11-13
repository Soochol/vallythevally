# UI 개선 구현 플랜 (2026-11-13)

상태: 구현 완료. PR A #310, PR B #311, PR C #308, PR D #312·#314, PR E #309. 이 문서는 구현 당시의 계획 기록이다.

사용자가 승인한 미리보기를 코드로 옮기는 플랜이다. 구현자는 이 문서와 아래 미리보기 원본만 보고 작업할 수 있어야 한다.

## 먼저 읽을 것

- `AGENTS.md`: 새 코드에 주석 줄 금지, `cargo fmt` 금지, 주변 서식 유지, 실제 키움 호출 금지.
- `GLOSSARY.md`: 화면 문구와 식별자는 용어집을 따른다. "보조지표"가 아니라 **지표**, "즐겨찾기"가 아니라 **관심종목**, **관심종목 그룹**, **차트 설정**, **칸**, **활성 칸**, **봉 주기**, **패널**.
- `docs/design-system.md`: 셸·섬·토큰 규칙. 이번 변경으로 바뀌는 부분은 이 문서도 고친다.
- `docs/web-checks.md`, `docs/development-builds.md`: 검사 명령.
- `docs/adr/0013-indicator-theme-and-custom-colors.md`: 지표 색은 테마 토큰(`ind-1`~`ind-5`)과 사용자 지정 HEX를 구분해 저장한다.

## 미리보기 원본

`docs/mockups/ui-improvements/`에 캔버스 원본 5개를 복사해 두었다. 캔버스 런타임 없이는 렌더링되지 않지만, 마크업의 인라인 스타일에서 크기·간격·색을, 아래 `<script>`에서 동작을 읽을 수 있다.

| 파일 | 내용 |
|---|---|
| `Main.dc.html` | 1. 분봉 선택 |
| `Watchlist.dc.html` | 2. 관심종목 그룹 |
| `ChartSettings.dc.html` | 3·4. 차트 설정 팝오버, 보이는 봉 수, 화면 내 최고·최저 |
| `IndicatorSettings.dc.html` | 5-A. 지표 창(가운데 창 방식) |
| `IndicatorInspector.dc.html` | 5-B. 지표 창(차트 옆 인스펙터 방식) |

미리보기의 색은 `web/src/styles/tokens.css` 토큰을 풀어 쓴 값이다. 구현에서는 HEX를 직접 쓰지 말고 토큰과 기존 클래스(`.ui-island`, `.ui-popover`, `.seg-btn`, `.tb-btn`, `.icon-btn`, `.ui-field`)를 쓴다. 미리보기의 종목명·시세는 가상 값이다.

## 확정된 결정

1. 분봉의 고정 주기(별) 개념을 없앤다.
2. 관심종목 그룹은 용어집 정의대로 한 목록 안의 이름 붙인 묶음이다.
3. 위 막대의 톱니 버튼은 차트 설정을 연다. 지금은 `openIndicatorCommand`에 잘못 연결돼 있다(`web/src/features/topbar/Topbar.tsx`).
4. 차트 설정은 위 막대 버튼 아래에 뜨는 팝오버다(가운데 창도, 우측 패널도 아니다).
5. 지표 창은 5-A와 5-B를 **둘 다** 구현하고, 차트 설정 팝오버의 "지표 창" 항목으로 바꾼다.
6. 지표 창의 탭은 "이 칸에 띄운 지표 / 지표 추가 / 비교 종목"이고, 앞의 두 탭은 같은 레이아웃을 쓴다.

사용자가 답하지 않아 권장안으로 정한 것(바꾸려면 사용자에게 확인):

- 보이는 봉 수는 봉 주기를 바꿔도 유지한다.
- 위 막대의 봉 모양 버튼(`StyleMenu`)은 빼고 차트 설정 팝오버로 옮긴다.
- 지표 창 방식의 기본값은 가운데 창(5-A)이다.

## 작업 순서와 PR 나누기

`main`에서 브랜치를 따고 PR 다섯 개로 나눈다. 커밋·푸시는 사용자가 요청할 때만 한다.

| PR | 내용 | 서버 변경 |
|---|---|---|
| A | 차트 설정 팝오버, 보이는 봉 수, 화면 내 최고·최저 | 없음 |
| B | 분봉 선택 | 없음 |
| C | 색상표, 지표 창 5-A(탭 3개, 새 레이아웃) | 없음 |
| D | 지표 창 5-B(인스펙터), 방식 전환 옵션 | 없음 |
| E | 관심종목 그룹 | 있음 |

A~D는 서버가 내용을 검사하지 않는 저장값만 바꾼다. `UiState`는 모르는 키를 그대로 왕복시키고(`web/src/api/generated/UiState.ts`), 칸의 `chartSettings`는 서버에서 `serde_json::Value`다(`crates/server/src/api.rs`).

---

## PR A. 차트 설정

### 저장 모양

`web/src/chart/settings.ts`의 `ChartSettings`에 두 필드를 더한다. `v`는 2 그대로 두고, 저장값에 없으면 기본값으로 읽는다.

```ts
visibleBars: number | null;
showExtremes: boolean;
```

- `visibleBars`: `null`이면 지금처럼 자동(데스크톱 130, 휴대폰 90). 숫자면 10~2000의 정수.
- `showExtremes`: 기본 `false`.
- `readChartSettings`는 두 키가 없으면 기본값, 있는데 모양이 틀리면 지금 규칙대로 `null`을 돌려준다. `migrateV1`과 `DEFAULT_CHART_SETTINGS`도 맞춘다.
- `web/src/stores/layout.ts`에 `setVisibleBars(slot, n)`, `setShowExtremes(slot, on)`을 더한다. 기존 `patchSetting`의 키 범위를 넓히면 된다.

지표 창 방식은 칸이 아니라 앱 전체 설정이다. `web/src/persist/uiState.ts`의 `UiPrefs`에 더한다.

```ts
indicatorWindow: "dialog" | "inspector";
```

기본 `"dialog"`, 없거나 틀리면 기본값. `web/src/stores/ui.ts`에 `setIndicatorWindow`를 더한다. 이 필드는 PR A에서 저장만 넣고 화면 항목은 PR D에서 켠다.

### 보이는 봉 수

`web/src/chart/ChartController.ts`:

- `fitInitialRange()`의 `show`를 `this.view.settings.visibleBars ?? (휴대폰 90 : 130)`으로 바꾼다. 봉 주기를 바꾸면 `feed.open` → `onReset` → `fitInitialRange` 순으로 다시 맞춰지므로 "주기를 바꿔도 유지"가 따로 코드 없이 성립한다.
- 분기봉·연봉(`coarse`)은 지금 전체를 보여 준다. `visibleBars`가 `null`이면 그대로, 숫자면 그 개수를 따른다.
- `apply()`에서 `prev.settings.visibleBars !== next.settings.visibleBars`이고 봉이 있으면, 오른쪽 끝을 유지한 채 `setVisibleLogicalRange({ from: end + 1 - n, to: end + RIGHT_OFFSET })`로 다시 맞춘다. 받은 봉이 부족하면 기존 `subscribeVisibleLogicalRangeChange`가 `feed.needOlder()`를 부른다. 이 호출은 `withDataGuard` 밖에서 해야 과거 페이지 요청이 나간다.
- 설정은 "맞추기"이지 잠금이 아니다. 이후 사용자의 확대·이동은 막지 않는다.

### 화면 내 최고·최저

- 순수 함수를 새 파일 `web/src/chart/extremes.ts`에 둔다: 봉 배열과 보이는 인덱스 범위를 받아 최고가 봉(고가 최대)과 최저가 봉(저가 최소)의 인덱스·가격을 돌려준다. 같은 값이면 가장 최근 봉을 고른다.
- 표시는 차트 위 DOM 꼬리표 두 개다(`Legend`가 DOM을 얹는 방식과 같다). 위치는 `timeScale().timeToCoordinate`와 `main.api.priceToCoordinate`로 구한다. 오른쪽 가장자리에 가까우면 왼쪽으로 뒤집는다(미리보기 `tag()` 참고).
- 문구: `최고 71,200 (+6.40%)`, `최저 58,300 (-12.90%)`. 괄호는 마지막 봉 종가 대비다. 숫자 형식은 `web/src/lib/format.ts`와 지수 여부(`isIndexCode`)를 따른다.
- 다시 계산할 때: 보이는 범위 변경, 봉 데이터 변경, 실시간 갱신, 크기 변경, 가격축 방식 변경. 이미 있는 `drawFrame()`에서 함께 그리면 된다.
- `showExtremes`가 꺼져 있거나 봉이 없으면 꼬리표를 지운다.
- 차트 이미지(`snapshot`)에는 넣지 않는다. 넣으려면 별도 작업이다.

### 팝오버

새 파일 `web/src/features/chart-settings/ChartSettingsPopover.tsx`. `Popover`를 위 막대 버튼에 `anchor`로 붙인다. 폭 320px. 구성은 `ChartSettings.dc.html` 오른쪽 패널과 같다.

1. **화면에 보이는 봉**: 60·120·240·480 세그먼트와 직접 입력(숫자, 단위 "봉"). `null`(자동)로 돌리는 "자동" 선택지도 세그먼트 앞에 둔다. 미리보기에는 없지만 기본 상태를 표현하려면 필요하다.
2. **표시**: "화면 내 최고·최저" 스위치.
3. **봉 모양**: 캔들·바·라인·영역. 기존 `setStyle`.
4. **가격 축**: 일반·로그·%. 기존 `setScale`. 비교 종목이 있으면 %로 고정되는 규칙은 `web/src/features/indicator-dialog/compareForm.ts`의 `pressScale`·`AXIS_LOCKED`를 그대로 쓴다. 차트 옆 `AxisMode`는 그대로 둔다.
5. **지표 창**: 가운데 창 / 차트 옆. PR D에서 추가한다.

모든 변경은 활성 칸에 바로 반영한다. 확인 버튼은 없다.

`Topbar.tsx`:

- 톱니 버튼을 슬라이더 모양 아이콘 + "차트 설정" 글자의 `tb-btn`으로 바꾸고 팝오버를 연다. 아이콘은 `web/src/features/icons.tsx`에 `SlidersIcon`으로 더한다(미리보기의 SVG 경로 참고).
- `StyleMenu`를 위 막대에서 뺀다. 다른 곳에서 쓰지 않으면 파일도 지운다.

### 시험

- `web/src/chart/settings.test.ts`: 두 필드가 없는 저장값, 있는 저장값, 틀린 값.
- `web/src/chart/extremes.test.ts`: 범위 안 최고·최저, 동률, 빈 범위.
- E2E(`web/e2e/`): 차트 설정 버튼이 팝오버를 연다, 봉 수를 고르면 보이는 봉 수가 바뀌고 봉 주기를 바꿔도 유지된다, 최고·최저 스위치가 꼬리표를 켜고 끈다, 새로고침 뒤 복원된다. 위 막대를 건드리는 기존 spec(`desktop-shell`, `float-*`, `chart-display`)에서 봉 모양 버튼·톱니 버튼을 찾는 부분을 고친다.

---

## PR B. 분봉 선택

`web/src/features/topbar/MinuteMenu.tsx`를 다시 쓴다. 동작은 `Main.dc.html`의 `pressMinute`와 같다.

- 버튼 문구는 언제나 마지막으로 고른 분봉(`3분 ▾`)이다. 활성 칸이 분봉이면 눌린 모양.
- 활성 칸이 분봉이 아닐 때 누르면 마지막 분봉으로 바꾸고 목록은 열지 않는다.
- 활성 칸이 분봉일 때 누르면 목록을 연다.
- 목록은 세로 한 줄씩(1·3·5·10·15·30·60분), 줄 오른쪽에 단축키(`periodKey`)를 보인다. 고른 줄에 체크. 기존 `features/menu/RadioMenu.tsx`를 쓸 수 있으면 쓰고, 단축키 표시가 안 되면 그 컴포넌트에 선택 항목 보조 문구를 더한다.
- 목록 안의 방향키 이동과 분봉 단축키 처리는 지금 동작을 유지한다.

저장:

- `UiPrefs.pinnedMinutes`와 `togglePinnedMinute`를 지운다. `parseUiState`에서 `pinnedMinutes` 키는 계속 꺼내 버려서 `extra`로 다시 저장되지 않게 한다.
- `UiPrefs.lastMinute: Period`를 더한다. 기본 `"3m"`, 분봉이 아닌 값이면 기본값.
- 활성 칸의 봉 주기가 분봉으로 바뀔 때마다 `lastMinute`를 갱신한다. 단축키와 휴대폰 칩(`features/phone/PeriodChips.tsx`)으로 바꾼 경우도 잡히도록, 메뉴의 `onChange`가 아니라 활성 칸의 `period`를 지켜보는 한 곳에서 갱신한다.

정리: `web/src/styles/ui.css`의 `.minute-grid` 관련 규칙과 별 버튼 규칙을 지우고 세로 목록 규칙으로 바꾼다. `StarIcon`은 우측 패널 레일에서 쓰므로 남긴다.

시험: `web/e2e/float-menus.spec.ts`의 `[data-pinned]` 검사를 새 동작으로 바꾼다. 단위 시험은 `uiState` 파서(`pinnedMinutes`가 있는 옛 저장값을 읽어도 문제없고 다시 저장되지 않는다, `lastMinute` 기본값).

---

## PR C. 색상표와 지표 창 5-A

### 색상표

`web/src/lib/colors.ts`의 `PRESET_COLORS`(48색 나열)를 구조 있는 표로 바꾼다.

- 열 10개: 빨강·주황·노랑·라임·초록·청록·하늘·파랑·보라·분홍.
- 행 4개: 밝게·기본·진하게·무채색. 값은 `IndicatorSettings.dc.html`의 `SETS`에 있다.
- 테마 색 5개(`ind-1`~`ind-5`)는 표와 별도의 줄이다. 고르면 HEX가 아니라 토큰을 저장한다(ADR 0013). 지금 `IndicatorSettingsForm`은 색을 고르면 항상 HEX로 바꾸므로, `Draft.color`가 토큰도 받도록 `indicatorForm.ts`를 확인한다.
- 최근 사용 색(`readRecent`·`rememberColor`)은 유지한다.

새 컴포넌트 `web/src/features/color/ColorTable.tsx`: 테마 줄(선택 사항), 표, 최근 줄, HEX 표시, "직접 고르기" 버튼. "직접 고르기"는 기존 `ColorPicker`의 사용자 지정(채도·밝기·색조) 화면을 연다.

- 지표 설정에서는 표를 팝업 없이 바로 펼친다.
- 드로잉 스타일(`features/drawings/StyleFields.tsx`)이 쓰는 `ColorPicker`의 "기본 색상" 탭도 같은 표로 바꾼다. 드로잉에는 테마 줄을 넣지 않는다.
- 스와치는 `<button>`에 `aria-label`(색 이름 + HEX)과 `aria-pressed`를 준다.

### 설정 폼

`web/src/features/indicator-dialog/IndicatorSettingsForm.tsx`를 두 구역으로 나눈다: **설정값**(계산 방식, 기간 등 지표별 필드, 자주 쓰는 기간)과 **선**(굵기, 색상표). 맨 위에 선 미리보기 띠를 둔다. 이 폼은 5-A, 5-B, 범례에서 여는 `IndicatorPopover` 세 곳이 함께 쓰므로, 폭이 좁으면 한 줄로 쌓이고 넓으면 설정값과 색상표가 좌우로 놓이게 만든다.

### 탭과 목록

`web/src/features/indicator-command/`:

- `mode`를 `"current" | "add" | "compare"`로 바꾼다. `stores/selection.ts`의 `Dialog`와 `openIndicatorCommand`도 맞춘다. 위 막대의 "지표" 버튼은 띄운 지표가 있으면 `current`, 없으면 `add`로 연다. "비교" 버튼은 `compare`.
- `model.ts`의 `commandRows`: `current`는 띄운 지표만, `add`는 `parseIndicatorInput` 후보만(입력이 비면 전체 종류가 나온다), `compare`는 종목만.
- 검색창에 글자를 치면 `current` 탭에서 `add` 탭으로 자동 전환한다. 지금의 "이평 20 치고 Enter" 흐름이 그대로 돌아야 한다.
- 두 탭 모두 목록을 "가격 패널 / 아래 패널"로 묶는다. `add` 탭은 재무지표 묶음이 하나 더 있다. 줄 모양은 같고, `current`는 색 점 + 숨기기·지우기, `add`는 + 표시다.
- 오른쪽 편집 영역은 두 탭이 같은 컴포넌트다. 주 버튼 문구만 `primaryLabel`대로 달라진다.
- 아래 단축키 안내와 키 처리(`commandKey`)는 유지한다.

창 크기는 미리보기 기준 976×656, 왼쪽 목록 300px이다. 휴대폰 폭에서는 지금처럼 위아래로 쌓는다.

### 시험

- `model.test.ts`, `parseInput.test.ts`, `indicatorForm.test.ts`를 새 모드와 토큰 색에 맞게 고치고 더한다.
- `web/e2e/indicator-command.spec.ts`, `indicators.spec.ts`: 탭 전환, 입력 시 자동 전환, 테마 색을 고르면 토큰이 저장된다, 표의 색을 고르면 HEX가 저장된다.
- 드로잉 색 선택을 쓰는 spec(`drawing-controls` 등)이 "기본 색상 48개" 문구나 스와치 개수에 기대는지 확인한다.

---

## PR D. 지표 창 5-B와 방식 전환

### 인스펙터

우측 패널(`web/src/features/panel/RightPanel.tsx`)에 네 번째 보기 `indicators`를 더한다. `RightPanel` 타입(`persist/uiState.ts`)과 파서, `VIEWS`, `VIEW_ORDER`를 맞춘다. 레일 아이콘은 기존 `IndicatorIcon`.

새 컴포넌트 `web/src/features/indicator-inspector/IndicatorInspector.tsx`. 구성은 `IndicatorInspector.dc.html` 오른쪽 패널과 같다.

- 머리: 제목 "지표"와 검색창. 검색창은 5-A와 같은 입력 규칙(`parseIndicatorInput`)을 쓴다.
- 밑줄형 탭 3개. 모드·목록 모델은 PR C의 `commandRows`를 그대로 쓴다.
- 줄을 누르면 그 자리에서 설정이 펼쳐진다. 한 번에 하나만 펼친다. 접힌 줄에는 요약(`specName` 또는 "단순 · 20봉")을 보인다.
- `current` 탭: 값을 바꾸면 `useLayoutStore.updateIndicator`로 바로 반영한다. `IndicatorPopover`가 쓰는 방식(즉시 반영, Esc로 되돌리기)과 같다.
- `add` 탭: 펼친 후보는 `useIndicatorPreview`로 차트에 미리 그리고, "추가" 버튼으로 확정한다.
- `compare` 탭: 지금 지표 창의 비교 종목 영역을 옮겨 쓴다.
- 별도 선 미리보기 띠는 두지 않는다. 차트가 미리보기다.

5-A와 5-B가 같은 훅·모델을 쓰도록, PR C에서 `IndicatorCommandBody`에 묶여 있는 상태(입력, 선택, 미리보기, 확정)를 훅으로 뽑아 두면 PR D가 작아진다.

### 방식 전환

- 차트 설정 팝오버에 "지표 창" 세그먼트(가운데 창 / 차트 옆)를 더하고 `UiPrefs.indicatorWindow`에 저장한다.
- `openIndicatorCommand(slot, mode)`가 설정을 본다. `"dialog"`면 지금처럼 가운데 창, `"inspector"`면 `showRightPanel("indicators")`로 우측 패널을 열고 해당 탭과 검색창에 초점을 준다.
- 레일의 지표 아이콘은 `"inspector"`일 때만 보인다. `"dialog"`로 바꿨는데 `rightPanel`이 `"indicators"`면 `"watch"`로 돌린다.
- 데스크톱이 아니면(`DESKTOP_QUERY` 불일치) 설정과 상관없이 가운데 창을 쓴다. 우측 패널은 데스크톱에만 있다.
- 단축키 `I`와 범례의 지표 설정 진입도 같은 함수로 모은다.

### 시험

- `uiState` 파서: `indicatorWindow`, `rightPanel: "indicators"`.
- E2E: 옵션을 바꾸면 "지표" 버튼이 창 대신 패널을 연다, 인스펙터에서 색을 바꾸면 저장된 지표 스타일이 바뀐다, 지표 추가가 된다, 옵션을 되돌리면 패널이 관심종목으로 돌아간다, 새로고침 뒤 유지된다.

---

## PR E. 관심종목 그룹

### 저장 모양

`Watchlist`에 그룹 목록을 더한다. 기존 `symbols`는 목록의 전체 종목으로 그대로 둔다. 실시간 구독, 스크리너의 "관심종목에 넣기", 검색 목록 등 `symbols`를 읽는 코드가 바뀌지 않기 때문이다.

```rust
pub struct WatchGroup { pub id: String, pub name: String, pub symbols: Vec<SymbolCode> }
pub struct Watchlist { pub id: String, pub name: String, pub symbols: Vec<SymbolCode>, #[serde(default)] pub groups: Vec<WatchGroup> }
```

불변식(서버가 검사하고 어기면 400):

- 그룹의 종목은 모두 그 목록의 `symbols`에 있다.
- 한 종목은 한 목록 안에서 그룹 하나에만 속한다.
- 그룹 이름은 한 목록 안에서 겹치지 않고 1~20자다. 그룹은 목록당 20개까지.
- 어느 그룹에도 없는 종목이 "그룹 없음"이다. 따로 저장하지 않는다.

화면 순서: 그룹을 `groups` 순서대로, 그룹 안은 그 그룹의 `symbols` 순서대로, 마지막에 "그룹 없음"을 `symbols` 순서대로.

접힘 상태는 관심종목 자료가 아니라 UI 설정에 둔다(`UiPrefs.collapsedWatchGroups: string[]`, 그룹 id). 접고 펼 때마다 관심종목 저장 순서 번호가 올라가지 않게 하기 위해서다.

이 저장 모양은 되돌리기 어려우므로 `docs/adr/`에 ADR을 하나 쓴다(전체 종목 목록을 유지하고 그룹을 부분집합으로 둔 이유).

### 서버

- `crates/server/src/api.rs`: 위 타입. ts-rs가 `web/src/api/generated/`를 다시 만든다. 생성 방법은 기존 타입이 갱신되는 경로(서버 시험 실행 시 내보내기)를 확인해서 따른다.
- `crates/server/src/userdata.rs`: `get_watchlists`·`put_watchlists`. 지금은 `watchlists` 테이블과 종목 테이블에 나눠 저장한다. 그룹 테이블 두 개(그룹, 그룹-종목)를 마이그레이션으로 더한다. 기존 자료는 그룹 없이 그대로 읽힌다.
- `crates/server/src/user_routes.rs`: PUT 본문에서 위 불변식을 검사한다.
- 시험: 왕복(순서 유지), 옛 본문(그룹 키 없음) 수용, 불변식 위반 400. 실제 키움은 부르지 않는다.

### 웹

- `web/src/lib/watchlist.ts`에 순수 함수를 더한다: 그룹 만들기, 이름 바꾸기, 위·아래 옮기기, 그룹 풀기(종목은 남김), 그룹 지우기(종목도 뺌), 종목을 그룹으로 옮기기(그룹 없음 포함), 그룹 안 순서 바꾸기, 화면 순서로 펼치기. 이름 검사는 `nameProblem`과 같은 규칙.
- 기존 함수가 불변식을 지키게 한다: `removeSymbol`과 `transferSymbol`(옮기기)은 그룹에서도 뺀다. 목록 복제는 그룹도 복제하되 그룹 id는 새로 만든다. `isWatchlists`는 `groups`가 없어도 받아들인다.
- `web/src/stores/watchlist.ts`: 위 동작과 `load`의 동일성 비교에 그룹을 넣는다. `removeWithUndo`는 되돌릴 때 원래 그룹과 그 안의 자리까지 복원한다(`features/watch/removalUndo.ts`와 그 시험).
- `web/src/features/watch/Watchlist.tsx`: 구성은 `Watchlist.dc.html`과 같다.
  - 머리에 "+ 그룹" 버튼. 누르면 새 그룹이 이름 입력 상태로 생긴다.
  - 그룹 머리 줄: 접기 화살표, 이름, 종목 수, 메뉴 버튼(이름 바꾸기, 위로, 아래로, 그룹 풀기, 그룹 지우기). 지우기는 `ConfirmHost`로 확인한다.
  - 종목 우클릭 메뉴에 "그룹으로 옮기기" 하위 메뉴(그룹들, 그룹 없음, 새 그룹…). 지금 속한 그룹에 체크.
  - 그룹이 하나도 없으면 "그룹 없음" 머리를 보이지 않고 지금 화면과 똑같이 보인다.
  - 키보드로 종목 순서를 바꾸는 기존 동작은 같은 그룹 안에서 움직인다.
  - 휴대폰 관심종목(`PhoneWatch`)도 같은 목록을 쓴다.

### 시험

- `lib/watchlist` 단위 시험: 각 함수와 불변식.
- `removalUndo.test.ts`: 그룹 안 종목 되돌리기.
- E2E: 그룹 만들기·이름 바꾸기·접기, 종목을 그룹으로 옮기기, 그룹 풀기와 지우기, 새로고침 뒤 복원, 그룹이 없을 때 기존 화면과 같음. `web/e2e/harness.ts`의 `Scenario`가 관심종목 응답을 만들므로 그룹 필드를 넣는다.

---

## 문서

- `GLOSSARY.md`: 새 용어를 더한다. 제안: **보이는 봉 수**(차트에 한 번에 보이게 맞춘 봉의 개수), **화면 내 최고·최저**(지금 보이는 봉 안의 최고가·최저가 표시), **지표 창**(지표를 찾고 띄우고 설정하는 화면. 가운데 창과 차트 옆 두 방식). **차트 설정**의 정의에 보이는 봉 수와 표시 선택이 들어가도록 고친다.
- `docs/design-system.md`: 위 막대 구성, 우측 패널 보기 목록, 색상표.
- ADR: 관심종목 그룹 저장 모양(PR E).

## 검사 명령

저장소 루트에서 실행한다.

```sh
python3 scripts/web.py check
python3 scripts/web.py e2e e2e/<고친 spec>.spec.ts
python3 scripts/dev.py cargo clippy -p server --all-targets -- -D warnings
python3 scripts/dev.py cargo test -p server
```

PR마다 고친 범위의 단위 시험과 E2E를 돌리고, 마지막에 E2E 전체를 한 번 돌린다. Rust 명령은 PR E에서만 필요하다.

## 범위 밖

- 테마(다크·라이트) 전환. 지금 파서는 `theme`을 항상 `"dark"`로 읽는다.
- 차트 이미지에 최고·최저 꼬리표 넣기.
- 휴대폰용 차트 설정 진입점. 필요하면 별도로 정한다.
- 관심종목 그룹의 끌어서 옮기기. 메뉴와 키보드로만 옮긴다.
