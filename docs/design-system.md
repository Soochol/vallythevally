# UI 테마와 공통 컴포넌트 바꾸기

[라임 다크 UI 스펙 #181](https://github.com/Soochol/vallythevally/issues/181)과 [차트 중심 UX 스펙 #200](https://github.com/Soochol/vallythevally/issues/200)의 적용 방법을 설명한다. 설계 배경은 [설계 맵 #178](https://github.com/Soochol/vallythevally/issues/178)에 있다.

## 테마 바꾸기

1. `web/src/styles/tokens.css`에서 배경, 표면, 글자, 간격, 반지름과 글자 크기를 바꾼다. 이 파일을 테마 값의 원본으로 사용한다.
2. 주요 행동과 선택에는 `--accent`를 사용한다. 경고는 `--warning`, 오류와 삭제는 `--danger`, 성공은 `--success`를 사용한다. 상승과 하락의 `--up`, `--down`은 상태 메시지에 사용하지 않는다.
3. 차트 전용 색도 같은 파일에서 바꾼다. `readThemeTokens`가 격자, 봉, 거래량, 지표 기본색과 비교 종목 색을 읽는다. 새 토큰을 추가하면 `web/src/chart/theme.ts`와 Tailwind 연결이 필요한 `web/src/styles/index.css`에도 연결한다.
4. 앱을 다시 빌드해 차트와 지표, 드로잉, 대화상자, PNG 내보내기를 확인한다. 사용자 지정 HEX 색은 테마가 바뀌어도 유지한다.

현재 UI는 라임 다크만 제공한다. 첫 HTML부터 `color-scheme: dark`를 적용한다. `parseUiState`는 과거 `light` 설정을 `dark`로 읽고 다른 설정을 보존한다. 서버의 과거 테마 값 수용 범위는 바꾸지 않는다.

## 화면과 대화상자 추가하기

1. 기존 버튼의 `tb-btn`, `seg-btn`, `icon-btn`, `btn-primary`를 사용한다. 크기와 상태 표현을 새 화면마다 다시 정의하지 않는다.
2. 입력에는 `ui-field`, 대화상자에는 `DialogFrame`을 사용한다. 머리와 하단 행동은 `ui-dialog-head`, `ui-dialog-foot`에 맞춘다. 설정 항목에는 `Row`, 짧은 선택에는 `Segment`, 검증 메시지에는 `Errors`를 사용한다.
3. 탭은 `ui-tabs`와 `tablist`, `tab`, `tabpanel` 역할을 함께 사용한다. 좌우 화살표, Tab, Escape와 닫은 뒤 포커스 복귀를 확인한다.
4. 화면 높이가 줄면 내용 영역 안에서 스크롤하게 한다. 대화상자 하단의 저장과 취소는 내용 밖에 둔다. 페이지 자체의 크기를 늘리거나 필요한 조작을 잘라 숨기지 않는다.

데스크톱 셸은 44px 위 막대, 40px 드로잉 막대, 26px 상태 막대를 사용한다. 오른쪽의 관심종목·스크리너·개체 탭은 `RightPanel`이 소유한다. `UiPrefs.rightPanel`에 선택 탭, `watchCollapsed`에 숨김, `rightPanelWidth`에 기본/넓은 너비를 저장한다. 숨긴 탭은 위 막대 버튼이나 Alt+W로 다시 연다. 스크리너는 기존 `ScreenerPanel`을 탭 안에서 재사용하고, 결과를 골라도 왼쪽 차트를 유지한다. 조건식 편집의 저장, 충돌 처리와 조건 검사는 기존 로직을 유지한다.

거래소 선택은 범례 머리의 `venueAnchor`에 기존 `VenuePicker`를 연결한다. 상태 막대의 재무 표시는 차트의 재무 조회 캐시를 구독하며 별도 수집 요청을 시작하지 않는다. 장 상태와 시계는 HTTP 응답으로 맞춘 서버 기준 한국 시각을 사용한다.

## 색상 선택 연결하기

1. `features/color/ColorPicker.tsx`를 사용한다. `label`, 현재 CSS 색, 선 굵기와 `onChange`를 전달한다. 작은 도구 막대에서는 `compact`를 켠다.
2. 입력이나 저장소에서 온 색은 `normalizeHex` 또는 `isHexColor`로 검사한다. 선택기가 반환한 `HexColor`는 정규화된 `#RRGGBB`이다.
3. 48색 프리셋을 바꾸려면 `lib/colors.ts`의 `PRESET_VALUES`를 수정한다. `PRESET_COLORS`의 개수, 중복과 색 변환 시험을 실행한다.
4. 선택기의 최근 8색은 `vv.recent-colors.v1`에 저장한다. 선택창에서 취소하면 부모의 색은 바뀌지 않는다. 지표의 색과 굵기는 지표 추가 또는 변경 적용 때 차트 설정에 저장한다.

기존 지표의 `ind-1`부터 `ind-5`는 테마를 따르는 색으로 계속 읽는다. 직접 고른 색은 HEX로 저장한다. 이 구분은 [ADR 0013](adr/0013-indicator-theme-and-custom-colors.md)을 따른다.

## 선 굵기 검증하기

지표와 드로잉은 1부터 5까지 제공한다. Lightweight Charts의 기본 선 타입은 4까지만 허용하므로 지표 선은 공통 사용자 렌더러를 사용한다. 가격 패널은 주 종목 종가를 퍼센트 기준으로 사용하고, 아래 지표 패널은 지표 값만 축 범위에 넣는다. `OverlayLineView`를 바꾸면 두 축 규칙, 굵기 5와 PNG 내보내기를 함께 확인한다.

## 변경 확인하기

저장소 루트에서 `python3 scripts/web.py check`와 관련 `python3 scripts/web.py e2e e2e/<파일>`을 실행한다. 도구가 WASM과 개발용 서버·가짜 키움을 준비하고 컴파일 잠금을 관리한다. 변경 없는 WASM은 재사용한다. E2E는 이번 실행의 웹 산출물과 임시 DB를 사용하며 결과는 `target/web-runs/` 아래에 분리한다. 자세한 절차는 [웹 검사](web-checks.md)를 따른다.

1024×768, 1280×720, 1440×900과 높이 300px 창에서 문서가 넘치지 않는지 확인한다. 낮은 창에서는 드로잉 도구를 내부 스크롤로 끝까지 열 수 있어야 한다. 화면 변경 시에는 390×844도 확인한다.

## 겹침 화면 추가하기 (#200·#202)

`features/overlay/Popover.tsx`를 사용한다. `anchor`에 연 버튼의 ref, `onClose`에 닫기 동작을 전달한다. 컨텍스트 메뉴에는 `point`, 이동하는 도구 막대에는 `follow`를 전달할 수 있다. `anchor`는 위치 기준과 실제 여는 버튼이며, 닫은 뒤 돌아갈 대상이 다르면 `focusTarget`을 별도로 전달한다. 좌표로 연 메뉴는 여는 버튼 없이 메뉴 표면만 내부로 보고, 차트는 포커스 복귀 대상으로만 사용한다. 위치를 직접 지정하는 absolute 메뉴나 별도 portal을 만들지 않는다.

- HTML Popover API의 맨 위 층에 렌더링한다. `position.ts`가 가장자리에서 반대쪽을 선택하고 화면 안으로 맞춘다. 내용 크기·창 크기·스크롤이 바뀌면 다시 계산한다.
- Esc와 바깥 누르기는 맨 위의 조작 가능한 화면만 닫고 연 버튼으로 포커스를 돌린다. 배경이 있는 창은 `backdrop`을 전달하며 직접 배경 닫기 핸들러를 달지 않는다. 바깥 pointerdown과 뒤따르는 click은 하나의 입력으로 소비해 부모의 버튼을 함께 실행하지 않는다. 중첩 색상 선택기에서 Esc를 누르면 부모 설정창은 남는다.
- 공통 표면은 `.ui-popover`다. 색·테두리·반경 10과 그림자를 여기서 한 번 정한다. 화면마다 이 네 값을 재정의하지 않는다.
- 일반 메뉴는 `features/menu/Menu.tsx`의 `MenuItem`으로 만든다. `radio`·`check`·`action`·`heading`·`separator`를 지원한다. ↑↓·Home·End·Enter·Space·글자 입력으로 이동/선택한다. 메뉴 키보드는 차트 단축키로 전파하지 않는다.
- 폼의 선택 항목은 `Select`에 `label`, 현재 값, `options`, `onChange`를 전달한다. 브라우저 기본 select를 새로 만들지 않는다. 분봉은 `MinuteMenu`, 자석 세기는 버튼의 우클릭·길게 누르기 메뉴를 쓴다.
- 일반 대화상자는 `DialogFrame`을 사용한다. 되돌릴 수 없는 작업은 `confirmAction(문구)`의 결과를 기다린다. 일반 알림은 `showToast(문구)`를 사용한다. 드로잉 삭제는 `DrawingSync.commitWithUndo(칸, 변경, 문구)`를 사용해 삭제 당시의 history 객체를 작업 식별자로 묶는다. 기록이 바뀌거나 취소된 알림의 되돌리기는 비활성화되고, 실행 시에도 같은 식별자인지 다시 검사한다. 알림은 6초 동안 보인다.
- `TooltipHost`는 기존 `title`을 공통 툴팁으로 표시한다. 단축키가 있는 버튼의 title에는 키도 적는다. 기존 aria-label과 title은 바꾸지 않는다.
- 차트 키 처리에는 `ownsChartKeyboard`를 먼저 검사한다. 열린 조작 표면이나 그 안의 이벤트를 차트 단축키가 가로채지 않는다. 알림만 `blockChartKeys={false}`를 사용해 차트의 Ctrl+Z를 유지한다.
- React 밖에서 만드는 화면은 `topLayer.ts`의 `mountLayer`를 사용하고 반환한 정리 함수를 화면 제거 시 호출한다. 재무 보고기간의 `domSelect`도 같은 위치·닫기·포커스 처리를 쓴다.

상태 화면은 `Skeleton`, `EmptyState`, `ErrorState`를 사용한다. 빈 상태에는 다음 행동, 오류에는 회복 동작을 함께 전달한다. 목록과 차트, 드로잉 패널의 상태를 이 부품으로 표시한다.

## 공통 아이콘과 치수

`features/icons.tsx`의 `Icon`이 24×24·1.5px·currentColor 규칙을 소유한다. 드로잉도 `Icon`에 `path`를 전달한다. 공통 드로잉 그림은 `DRAWING_ICONS`에 두며 도구가 제공하는 기존 `tool.icon` 문자열도 그대로 전달할 수 있다. 새 도구나 아직 쓰지 않는 아이콘은 미리 추가하지 않는다.

DOM 범례는 `iconMarkup("gear" | "eye" | "eyeOff" | "close" | "up" | "down")`으로 같은 그림을 문자열로 얻는다. 이 결과에는 고정된 아이콘 데이터만 들어가며 사용자 문자열을 HTML에 넣지 않는다. 버튼의 title·aria-label은 버튼에 둔다.

`tokens.css`의 반경은 5/7/10/12, 최소 글자는 11px이며 숫자는 전역 `tabular-nums`를 상속한다. `ui.css`와 `colors.css`의 치수는 `--size-*` 토큰을 참조하고 간격은 4px 배수를 사용한다. 색 토큰 값은 #181 그대로 유지한다. 분봉 별표는 `UiPrefs.pinnedMinutes`로 저장하고 잘못된 주기·중복을 읽기 경계에서 제거한다. 서버 API는 바꾸지 않는다.

시안 원본 9장은 [docs/mockups/ux-overhaul](mockups/ux-overhaul/)에 보관한다. 기능 규칙은 시안보다 #200과 #181이 우선이며 색상 선택기의 48색·최근 8색·HEX·선 샘플과 굵기 1~5를 유지한다.
