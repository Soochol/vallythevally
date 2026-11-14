# 완전 자유형 창 배치 구현 플랜 (2026-11-14)

작성일 2026-11-14. 승인 시점의 기록이며 구현 중 바뀐 것은 반영하지 않는다.

## 사용자가 풀려는 문제

지금 화면은 차트 하나와 오른쪽 패널 하나로 고정돼 있다. 사용자는 여러 종류의 창을 원하는 자리에 자유롭게 놓고 싶어 한다.

사용자의 말(그대로):

- "현재 캔들차트 화면이 1개잖아. 화면분할 기능 제안해줘 그리고 각 화면에 우측에 새로운 창을 붙였다 땔 수 있는 기능 제안. 아주 세련된 레이아웃 방식, uiux 관점에서 세련된 방식으로 제안해줘"
- "차트 창이 N개의 종류가 있어. 내가 자유롭게 어떤 창을 어디에 배치할지 완전 자유도 있는 컨셉"
- 컨셉 4안의 미리보기를 본 뒤: "완전 자유형 2개 모두 개발"
- 두 방식을 한 앱에 담는 방법: "옵션으로 설정가능하게"

"완전 자유형 2개"는 컨셉 문서의 **A 도킹 작업대**(가장자리에 놓으면 나누고 가운데에 놓으면 탭으로 쌓는다, 겹치지 않는다)와 **B 자유 캔버스**(아무 자리에 아무 크기로 놓는다, 겹쳐도 된다, 가장자리끼리 달라붙는다)다. C 자리 틀과 D 격자 보드는 만들지 않는다.

컨셉 문서와 미리보기는 저장소 밖에 있다(읽기 전용 참고).

- `/home/dev/.claude/orch/concepts/layout-20261114/concepts.md`
- `/home/dev/.claude/orch/concepts/layout-20261114/concepts.html`

## 지금 구조

- `web/src/App.tsx`는 활성 칸(`activeSlot`)의 `ChartCell` 하나만 그린다. 여러 칸을 그리는 코드는 없다.
- 관심종목·스크리너·개체 목록·지표는 `web/src/features/panel/RightPanel.tsx`의 탭 내용이다.
- 저장 형식의 레이아웃은 `arrangement`(1·2h·2v·3·4)와 `cells`(slot 0~3, 차트 전용)다. 서버(`crates/server/src/user_routes.rs`의 `check_layout`)가 칸 수와 slot을 검사한다.
- 드로잉 범위 "이 칸"은 `(layoutId, slot)`에 묶여 있다(`crates/server/src/drawing_api.rs`, `web/src/chart/drawings/frame.ts`).
- 레이아웃을 바꿔 여는 화면이 없다. 마지막 레이아웃 하나를 되살릴 뿐이다(`web/src/persist/restore.ts`).
- `LayoutSync { crosshair, scroll }`는 저장만 하고 화면에서 쓰지 않는다.

## 확정된 결정

1. A 도킹 작업대와 B 자유 캔버스를 둘 다 만든다.
2. 어느 방식을 쓸지는 사용자가 설정에서 고른다.

## 구조

두 방식은 창과 창 내용, 연동, 저장을 함께 쓰고 **창을 놓는 방식만** 갈아 끼운다.

### 용어

| 용어 | 뜻 |
|---|---|
| 창 | 레이아웃 안에 두는 화면 하나. 종류가 있다 |
| 창 종류 | 차트, 관심종목, 스크리너, 개체 목록, 지표 |
| 칸 | 차트 창이 보이는 차트 하나(종목, 거래소, 봉 주기, 차트 설정). 지금 뜻을 좁혀 유지한다 |
| 활성 칸 | 마지막으로 고른 차트 창의 칸. 위 막대의 조작이 여기에 적용된다 |
| 창 배치 방식 | 창을 놓는 방식. 도킹과 캔버스 가운데 하나 |
| 도킹 | 창이 작업 영역을 빈틈없이 나눠 쓰고 겹치지 않는 방식 |
| 캔버스 | 창을 아무 자리에 아무 크기로 놓고 겹칠 수 있는 방식 |
| 묶음 | 도킹에서 탭으로 쌓여 한 자리를 함께 쓰는 창들 |
| 연동 색 | 종목을 함께 바꾸는 창들을 묶는 색(A·B·C·끔) |

드로잉 도구 막대는 `docs/design-system.md`에서 "도크"라고 부른다. 창 배치의 "도킹"과 다른 것이다. 코드와 시험 이름에서 섞이지 않게 창 배치 코드는 `web/src/layout/`과 `web/src/features/workspace/`에 두고, 새 E2E 파일 이름은 `win-`으로 시작한다. 기존 `web/e2e/float-dock.spec.ts`는 드로잉 도구 막대의 시험이다.

### 저장 모양

레이아웃은 창 목록과 배치를 가진다.

```ts
type LinkColor = "a" | "b" | "c";

type LayoutWindow = { id: string; link: LinkColor | null } & (
  | { kind: "chart"; symbol: SymbolCode; venue: Venue | null; period: Period; chartSettings: unknown }
  | { kind: "watchlist" }
  | { kind: "screener" }
  | { kind: "objects" }
  | { kind: "indicators" }
);

type Layout = {
  id: string; name: string; sync: LayoutSync;
  windows: LayoutWindow[];
  placement: unknown;
  updatedAt: UnixSeconds; revision: Revision;
};
```

`placement`는 프런트엔드가 모양을 정하고 서버는 그대로 저장한다(칸의 `chartSettings`와 같은 방식).

```ts
type Rect = { x: number; y: number; w: number; h: number };

type DockNode =
  | { kind: "split"; dir: "row" | "column"; ratio: number; first: DockNode; second: DockNode }
  | { kind: "group"; id: string; tabs: string[]; active: string };

type DockPlacement = { root: DockNode; floats: { window: string; rect: Rect }[] };
type CanvasPlacement = { rects: Record<string, Rect>; order: string[] };
type Placement = { v: 1; dock: DockPlacement | null; canvas: CanvasPlacement | null };
```

- `Rect`는 작업 영역에 대한 비율(0~1)이다. 화면 크기가 달라도 비율로 되살린다.
- `ratio`는 `first`가 차지하는 몫(0~1)이다. `dir: "row"`는 좌우, `"column"`은 상하로 나눈다.
- `order`는 뒤에서 앞 순서다.
- 서버가 검사하는 것: 창 1~12개, 창 id가 겹치지 않음, 차트 창 1~8개, 차트가 아닌 종류는 종류마다 하나 이하, 차트 창의 종목·거래소 규칙(지금 `check_layout`의 규칙), `placement`가 64KB 이하의 JSON 객체.
- 프런트엔드가 읽을 때 맞추는 것: `placement`에 없는 창에는 기본 자리를 주고, 없는 창을 가리키는 자리는 지운다.

창 배치 방식은 앱 전체 설정이다. `UiPrefs.layoutMode: "dock" | "canvas"`, 기본 `"dock"`.

### 화면 틀

데스크톱 화면은 위 막대 섬, 그 아래 작업 영역, 바닥의 상태 줄로 이뤄진다. 작업 영역에 창을 그린다. 오른쪽 패널과 세로 탭 막대는 없어지고 그 내용은 창이 된다. 드로잉 도구 막대는 활성 칸의 위쪽 가운데에 붙는다. 휴대폰 화면은 지금과 같다.

## 스스로 정한 결정과 그 이유

1. **이번에 창으로 옮기는 것은 이미 있는 화면 다섯 가지다**: 차트, 관심종목, 스크리너, 개체 목록, 지표. 새 종류는 만들지 않는다. 종목 기본 정보는 자료와 훅(`useFundamentals`)이 남아 있지만 화면은 이전에 일부러 뺐고(커밋 d3ae54d, `web/e2e/fundamentals.spec.ts`가 조회가 없음을 고정), 체결과 알림 기록은 서버 자료가 없다.
2. **차트 창만 여러 개 둘 수 있다(최대 8개). 나머지 종류는 레이아웃에 하나씩이다.** 관심종목·스크리너·개체 목록·지표의 내용은 앱 전체 상태(고른 목록, 고른 조건식, 활성 칸)를 쓰고 있어서 두 개를 띄워도 같은 내용이 보인다. 이미 있는 종류를 더하려 하면 그 창을 앞으로 가져온다.
3. **레이아웃에는 차트 창이 언제나 하나 이상 있다.** 마지막 차트 창은 닫을 수 없다. 위 막대, 단축키, 휴대폰 화면이 활성 칸을 전제로 하기 때문이다.
4. **종목은 차트 창만 가진다.** 개체 목록과 지표 창은 언제나 활성 칸을 따른다(지금과 같다). 연동 색은 차트 창(따르는 창)과 관심종목·스크리너 창(보내는 창)에만 뜻이 있다. 같은 색의 차트 창은 언제나 같은 종목을 보인다. 봉 주기는 연동하지 않는다(용어집 규칙).
5. **용어는 "칸"을 남기고 "창"을 새로 둔다.** 칸을 없애면 화면 문구와 접근성 이름(`칸 1: …`), E2E 도우미(`web/e2e/harness.ts`의 `cell`)를 모두 바꿔야 한다. 화면 문구에서 이름 붙인 배치는 용어집대로 "레이아웃"이라 부른다.
6. **서버는 창 목록을 타입으로 검사하고 배치는 그대로 저장한다.** 차트 창의 종목·거래소는 서버가 검사해야 하고(ADR 0007), 배치는 화면 전용 자료라 서버가 알 필요가 없다. 되돌리기 어려운 저장 모양이므로 ADR을 쓴다.
7. **드로잉 범위 "이 칸"은 slot 번호에서 창 id로 바꾼다.** 창이 옮겨 다녀도 드로잉이 그 차트를 따라가야 한다. 차트 창을 닫으면 그 창을 범위로 둔 드로잉은 "이 레이아웃" 범위로 넓힌다(용어집의 드로잉 범위 규칙).
8. **기존 레이아웃은 지금 화면과 같은 모양으로 옮긴다.** 마이그레이션이 칸을 차트 창으로 바꾸고 관심종목·스크리너·개체 목록 창을 더한다. 도킹의 기본 배치는 왼쪽에 차트, 오른쪽 묶음에 그 세 창의 탭이다.
9. **지표 창 방식 설정(가운데 창 · 차트 옆)은 남긴다.** "차트 옆"은 지표 버튼이 지표 종류의 창을 보이게 한다는 뜻이 된다. 지표 창은 설정과 상관없이 더할 수 있다.
10. **새 차트 창은 활성 칸의 종목·거래소·봉 주기·차트 설정·연동 색을 복사한다.** 같은 종목을 다른 봉 주기로 나란히 보는 쓰임이 가장 흔하다.
11. **배치를 되돌릴 수 있게 한다.** 컨셉 문서가 꼽은 도킹의 가장 큰 위험(배치를 망가뜨리면 되돌리기 어렵다)을 막는다. 창과 배치의 변경 기록을 화면에 있는 동안 20단계 보관하고, 레이아웃 메뉴에 "배치 되돌리기"와 "기본 배치로"를 둔다. 창을 닫으면 알림에 되돌리기를 보인다.
12. **십자선 연동을 넣고 스크롤 연동은 넣지 않는다.** 차트 창이 여러 개가 되면 같은 시각을 함께 가리키는 것이 기본 기대이고 미리보기에도 들어 있다. 저장 형식의 `sync.crosshair`를 스위치로 쓴다. 스크롤 연동은 봉 주기가 다른 차트 사이의 규칙을 따로 정해야 해서 뺐다.
13. **도킹 방식에도 떠 있는 창을 둔다.** 컨셉 A의 "떼기·붙이기"이고 사용자의 처음 요청("붙였다 땔 수 있는")에 해당한다. 캔버스의 창 틀(끌기·크기·달라붙기)을 다시 쓴다. 도킹에서는 묶음이 작업 영역을 가득 채워 "묶음 밖에 놓기"가 어려우므로, 띄우기는 탭 메뉴와 `Shift`를 누른 채 끌기로 한다.
14. **휴대폰 화면은 바꾸지 않는다.** 활성 칸과 아래 탭(차트·관심종목·스크리너)을 그대로 보인다. 창 배치는 데스크톱(`DESKTOP_QUERY`)에서만 쓴다.
15. **끌어 놓기 도킹은 라이브러리 없이 만든다.** 나눔 트리와 탭 묶음은 미리보기에서 이미 동작이 확인됐고, 저장 모양과 최소 크기 규칙, 섬 스타일을 직접 쥐어야 한다. 순수 함수(트리 연산, 좌표 계산)를 화면보다 먼저 만들어 단위 시험으로 고정한다.

## 작업 나눔과 순서

PR 하나로 검토하고 병합할 수 있는 단위 13개로 나눈다.

| 순서 | 작업 ID | 내용 | 기다리는 작업 | 서버 변경 |
|---|---|---|---|---|
| 1 | `win-model` | 창 종류 표, 배치 타입, 배치 읽기·맞추기(순수 코드) | 없음 | 없음 |
| 2 | `dock-tree` | 도킹 나눔 트리 연산(순수 코드) | `win-model` | 없음 |
| 3 | `canvas-geometry` | 캔버스 좌표 연산: 달라붙기, 최소 크기, 가지런히(순수 코드) | `win-model` | 없음 |
| 4 | `layout-store` | 저장 형식 교체: 서버 타입·마이그레이션, 드로잉 범위, 웹 저장소. 화면은 그대로 | `win-model` | 있음 |
| 5 | `win-shell` | 여러 창을 그리는 화면 틀, 창 내용 떼어 내기, 도킹 그리기와 경계 끌기 | `layout-store`, `dock-tree` | 없음 |
| 6 | `win-manage` | 창 더하기·닫기, 배치 기록과 되돌리기 | `win-shell` | 없음 |
| 7 | `win-link` | 연동 색 | `win-shell` | 없음 |
| 8 | `layout-menu` | 레이아웃 메뉴: 바꿔 열기, 새 이름으로 저장, 이름 바꾸기, 지우기, 기본 배치로 | `win-manage` | 없음 |
| 9 | `dock-interact` | 도킹 끌어 놓기: 나누기, 탭으로 넣기, 탭 순서 | `win-manage` | 없음 |
| 10 | `sync-crosshair` | 십자선 연동 | `layout-menu` | 없음 |
| 11 | `canvas-ui` | 캔버스 방식 화면, 창 배치 방식 설정과 전환 | `layout-menu`, `canvas-geometry` | 없음 |
| 12 | `dock-float` | 도킹의 떠 있는 창: 띄우기·붙이기 | `dock-interact`, `canvas-ui` | 없음 |
| 13 | `layout-finish` | 통합 검사, 문서 맞추기, 남은 옛 코드 정리 | `win-link`, `sync-crosshair`, `dock-float` | 없음 |

병렬로 도는 묶음과 겹치는 파일:

- `dock-tree` ∥ `canvas-geometry` ∥ `layout-store`: 겹치는 파일이 없다. 앞의 둘은 `web/src/layout/` 안의 새 파일만 쓴다.
- `win-manage` ∥ `win-link`: `web/src/stores/layout.ts`와 창 머리 부품에 각자 몇 줄을 더한다. 두 지시서에 최소 변경으로 하라고 적었다.
- `layout-menu` ∥ `dock-interact`: `layout-menu`는 위 막대와 `web/src/persist/`, `dock-interact`는 도킹 화면 부품을 고친다. 겹치는 파일이 없다.
- `sync-crosshair` ∥ `canvas-ui` ∥ `dock-interact`: `sync-crosshair`는 `web/src/chart/ChartController.ts`와 새 파일, 레이아웃 메뉴에 스위치 한 줄. `canvas-ui`는 캔버스 부품과 레이아웃 메뉴에 조각 버튼 한 줄. 레이아웃 메뉴는 두 작업 모두 최소 변경으로 한다.

순차로 둔 이유:

- `dock-tree`, `canvas-geometry` → `win-model`: 창 종류 표와 배치 타입을 쓴다.
- `layout-store` → `win-model`: 웹 저장소가 배치 읽기·맞추기를 쓴다.
- `win-shell` → `layout-store`, `dock-tree`: 새 저장소의 창 목록을 그리고, 도킹 트리 연산으로 자리를 계산한다.
- `win-manage`, `win-link` → `win-shell`: 창 틀과 창 머리에 조작을 더한다.
- `layout-menu` → `win-manage`: 메뉴의 "배치 되돌리기"가 `win-manage`의 배치 기록을 쓰고, 두 작업 모두 `web/src/stores/layout.ts`에서 레이아웃을 통째로 바꾸는 부분을 다시 짠다.
- `dock-interact` → `win-manage`: 묶음의 창 더하기가 `win-manage`의 더하기 동작을 쓰고, 끌어 놓기의 변경이 배치 기록에 들어가야 한다.
- `sync-crosshair`, `canvas-ui` → `layout-menu`: 스위치와 조각 버튼을 레이아웃 메뉴에 둔다.
- `canvas-ui` → `canvas-geometry`: 좌표 연산을 쓴다.
- `dock-float` → `dock-interact`, `canvas-ui`: 탭 끌기와 캔버스의 창 틀을 함께 쓴다.
- `layout-finish`는 모든 기능이 병합된 뒤에 통합 검사를 한다.

### 진행 중인 다른 작업과의 순서

`layout-store`는 `draw2-polish`, `draw2-finish`, `chart-day-lines`가 `main`에 병합된 뒤에 시작한다.

- `layout-store`는 slot 번호를 창 id로 바꾸면서 `web/src/chart/drawings/`와 `web/src/features/drawings/`의 여러 파일, `web/src/features/chart-settings/ChartSettingsPopover.tsx`, `web/src/chart/ChartController.ts`를 고친다. `draw2-polish`·`draw2-finish`·`chart-day-lines`가 고치는 곳과 같다.
- `win-shell`은 드로잉 도구 막대의 자리와 `web/e2e/float-dock.spec.ts`·`web/e2e/float-shell.spec.ts`를 고친다. `draw2-finish`가 도구 막대 폭을 고치고 `main`의 E2E 실패 5개(`web/e2e/float-dock.spec.ts` 2개, `web/e2e/legend-panel-regressions.spec.ts`, `web/e2e/overlay-input.spec.ts`, `web/e2e/search.spec.ts` 간헐)의 원인을 가린 뒤여야 한다.
- `win-model`, `dock-tree`, `canvas-geometry`는 새 파일만 쓰므로 지금 바로 시작할 수 있다.

화면 틀을 바꾸는 작업(`win-shell` 이후)의 성공 조건은 "작업을 시작한 기준 커밋에서 통과하던 E2E는 모두 통과하고, 그때 이미 실패하던 시험은 목록을 PR에 적고 새 실패를 더하지 않는다"로 적었다.

병합 사이의 상태: `win-shell`이 병합되고 `win-manage`가 병합되기 전에는 오른쪽 창들을 닫거나 접을 수 없다. 두 작업은 이어서 병합하는 것이 좋다.

## 범위 밖

- C 자리 틀, D 격자 보드.
- 새 창 종류: 종목 기본 정보, 체결, 알림 기록, 호가.
- 차트가 아닌 종류의 창을 여러 개 두기, 창마다 다른 관심종목 목록·조건식 고르기.
- 스크롤 연동(`sync.scroll`은 지금처럼 저장만 한다).
- 휴대폰과 1280px보다 좁은 창을 위한 별도 배치(묶음 합치기, 창 넘기기). 좁은 창에서는 최소 크기만 지킨다.
- 창을 브라우저 밖 별도 창이나 다른 모니터로 떼어 내기.
- 밝은 테마. 지금 앱은 어두운 화면만 제공한다.
- 레이아웃 목록의 순서 바꾸기.

## 사용자가 정해야 하는 결정

아래는 사용자가 말하지 않아 권장안으로 정하고 작업을 나눈 것이다. 다른 선택지를 고르면 해당 작업의 지시서를 고친다.

1. **창 배치 방식 설정의 위치**
   - 권장(적용): 앱 전체 설정 하나. 레이아웃 메뉴에서 바꾼다. 지표 창 방식 설정과 같은 자리 매김이고, 어느 레이아웃을 열어도 같은 방식으로 조작한다.
   - 다른 선택지: 레이아웃마다 방식을 기억한다(예: "장중 매매"는 도킹, "복기"는 캔버스). 고르면 `canvas-ui`와 `layout-store`의 저장 위치가 바뀐다.
2. **기본값**
   - 권장(적용): 도킹. 지금 화면(차트 + 오른쪽 탭)과 같은 모양으로 시작하고, 겹치지 않아 배치가 무너지지 않는다.
   - 다른 선택지: 캔버스.
3. **방식을 바꿀 때 열려 있는 창의 배치**
   - 권장(적용): 창은 그대로 두고, 방식마다 배치를 따로 기억한다. 어떤 방식을 처음 쓸 때만 다른 방식의 배치에서 만들어 낸다(도킹 → 캔버스는 각 창이 지금 차지한 자리 그대로, 캔버스 → 도킹은 차트를 왼쪽에 쌓고 나머지를 오른쪽 묶음의 탭으로). 그 뒤로는 방식을 오가도 각 방식의 배치가 남는다.
   - 다른 선택지: 바꿀 때마다 지금 배치를 다른 방식으로 변환한다. 도킹 → 캔버스 → 도킹으로 돌아오면 처음 도킹 배치가 사라진다.
4. **두 방식의 배치 저장**
   - 권장(적용): 함께 쓴다. 레이아웃 하나가 창 목록 하나와 두 방식의 배치를 함께 가진다. 레이아웃 목록은 하나다.
   - 다른 선택지: 방식마다 레이아웃 목록을 따로 둔다.
5. **"차트 창이 N개의 종류"의 뜻**: 컨셉 작업이 "창의 종류가 여럿"으로 읽었고 사용자의 확인을 받지 못했다. 이 플랜도 그렇게 읽었다. "차트 자체의 종류가 여럿"(예: 캔들 차트와 재무 차트)이라는 뜻이었다면 창 종류에 차트 종류를 더하는 작업이 필요하다.
6. **새 창 종류를 만들지**: 이번 플랜은 이미 있는 화면 다섯 가지만 창으로 옮긴다. 종목 기본 정보(자료와 훅이 있고 화면은 이전에 뺐다), 체결, 알림 기록(서버 자료부터 필요하다)을 원하면 따로 플랜을 쓴다.

## 검사 명령

저장소 루트에서 실행한다. 자세한 절차는 `docs/web-checks.md`와 `docs/development-builds.md`에 있다.

```sh
python3 scripts/web.py check
python3 scripts/web.py e2e e2e/<고친 spec>.spec.ts
python3 scripts/dev.py cargo clippy -p server --all-targets -- -D warnings
python3 scripts/dev.py cargo test -p server
```

Rust 명령은 `layout-store`에서만 필요하다.
