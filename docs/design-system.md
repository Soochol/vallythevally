# UI 테마와 공통 컴포넌트 바꾸기

[라임 다크 UI 스펙 #181](https://github.com/Soochol/vallythevally/issues/181)의 적용 방법을 설명한다. 설계 배경은 [설계 맵 #178](https://github.com/Soochol/vallythevally/issues/178)에 있다.

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

데스크톱 차트와 스크리너 전환은 저장하지 않는 `desktopView`를 사용한다. 스크리너는 기존 `ScreenerPanel`을 재사용한다. 조건식 편집의 저장, 충돌 처리와 조건 검사는 기존 로직을 유지한다.

## 색상 선택 연결하기

1. `features/color/ColorPicker.tsx`를 사용한다. `label`, 현재 CSS 색, 선 굵기와 `onChange`를 전달한다. 작은 도구 막대에서는 `compact`를 켠다.
2. 입력이나 저장소에서 온 색은 `normalizeHex` 또는 `isHexColor`로 검사한다. 선택기가 반환한 `HexColor`는 정규화된 `#RRGGBB`이다.
3. 48색 프리셋을 바꾸려면 `lib/colors.ts`의 `PRESET_VALUES`를 수정한다. `PRESET_COLORS`의 개수, 중복과 색 변환 시험을 실행한다.
4. 선택기의 최근 8색은 `vv.recent-colors.v1`에 저장한다. 선택창에서 취소하면 부모의 색은 바뀌지 않는다. 지표의 색과 굵기는 지표 추가 또는 변경 적용 때 차트 설정에 저장한다.

기존 지표의 `ind-1`부터 `ind-5`는 테마를 따르는 색으로 계속 읽는다. 직접 고른 색은 HEX로 저장한다. 이 구분은 [ADR 0013](adr/0013-indicator-theme-and-custom-colors.md)을 따른다.

## 선 굵기 검증하기

지표와 드로잉은 1부터 5까지 제공한다. Lightweight Charts의 기본 선 타입은 4까지만 허용하므로 지표 선은 공통 사용자 렌더러를 사용한다. 가격 패널은 주 종목 종가를 퍼센트 기준으로 사용하고, 아래 지표 패널은 지표 값만 축 범위에 넣는다. `OverlayLineView`를 바꾸면 두 축 규칙, 굵기 5와 PNG 내보내기를 함께 확인한다.

## 변경 확인하기

Rust 지표 소스와 WASM 빌드 설정이 그대로라면 준비된 WASM을 재사용해 `web`에서 다음 명령을 실행한다.

```sh
./node_modules/.bin/tsc -b
./node_modules/.bin/vitest run
./node_modules/.bin/vite build
```

실제 키움 대신 가짜 키움으로 E2E를 실행한다. 먼저 공통 컴파일 잠금과 `CARGO_BUILD_JOBS=4`로 서버와 가짜 키움을 빌드한다. 임시 경로는 작업 폴더 안의 정규화된 절대 경로로 지정한다. `TMPDIR`에 `..`가 남으면 Chromium 내려받기가 취소될 수 있다.

```sh
mkdir -p ../target/ui-implementation/tmp
TMPDIR="$(realpath ../target/ui-implementation/tmp)" ./node_modules/.bin/playwright test e2e/lime-layout.spec.ts e2e/lime-ui.spec.ts e2e/lime-screener.spec.ts e2e/snapshot.spec.ts --output=test-results/lime-ui
```

1024×768, 1280×720, 1440×900과 높이 300px 창에서 문서가 넘치지 않는지 확인한다. 낮은 창에서는 드로잉 도구를 내부 스크롤로 끝까지 열 수 있어야 한다.
