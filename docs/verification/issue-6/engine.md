# 드로잉 엔진 검증

2026-11-10 KST. 승인된 `docs/design/drawing-proposal.md` §7.2를 구현했다. 대표 도구는 추세선과 수평선이다.

## 실행 결과

- #51 병합 전 전체 `scripts/check.sh`를 `unshare -Un --map-current-user --keep-caps`의 루프백 전용 이름공간에서 실행했다. 종료 코드는 0이다.
- cargo clippy, cargo test, 생성 TypeScript 비교, TypeScript 검사, Vitest 320개, Vite 빌드, WASM 빌드·기준값 비교, Playwright 37개가 통과했다.
- 이후 #51의 `11c6a03` 위로 rebase했다. 최종 pre-push 결과는 PR의 Verification에 기록한다. GitHub Actions CI는 사용자 결정으로 꺼져 있다.
- `.env`를 읽지 않았다. 테스트의 REST와 WS 주소를 모두 fake로 명시했다. 현재 main에는 #4의 WebSocket 구현이 없어 WS 환경변수는 무시되지만 실제 연결을 만드는 코드도 없다.

## 화면 증거와 사용감 메모

[데스크톱](desktop.png), [설정 창](settings.png), [휴대폰](phone.png)은 실행한 빌드의 Playwright 화면 캡처다. 실제 캔버스에서 포인터를 누르고 움직이고 놓았으며, 캡처를 직접 판독했다. 사람이 직접 마우스를 움직인 결과는 아니다.

- 핸들은 지름 8px, 판정 반경 6px다. 몸통의 선 판정도 6px다. 핸들 끌기는 해당 점만 바꾸고 다른 점은 그대로 두는 것을 확인했다.
- 클릭과 끌기는 4px에서 나뉜다. Shift 몸통 이동은 8px 움직인 뒤 수평·수직을 정한다. Shift 점 배치와 핸들 편집은 화면 각도를 기준으로 맞춘다.
- 떠 있는 막대는 선택 영역 위 14px에 있고, 위쪽 여백이 부족하면 아래 14px에 놓인다. 칸 밖으로 나가지 않게 제한한다. 캡처의 막대와 축 라벨은 선 끝점을 가리지 않는다.
- 끄는 동안에는 스크롤·확대를 끈다. 원래 옵션의 사본을 보관해 놓은 뒤 복구한다. 드로잉 편집 후 빈 차트를 다시 끌 수 있는 것을 e2e로 확인했다.
- 휴대폰 캡처에는 같은 선이 보이며 도구 막대·선택 핸들·편집 막대는 없다.
- 색상 입력은 현재 테마의 실제 색상값을 표시한다. 내부 저장 토큰을 입력칸이나 안내 문구에 노출하지 않는다. 색을 편집하지 않고 확인하면 저장된 테마 토큰은 유지되는 것을 e2e로 확인했다.
- 입력 지연의 수치나 프레임 성능은 측정하지 않았다. 네이티브 데스크톱 입력으로 평가하는 조작감은 아래 도구 제한 때문에 미확인이다.

## §7.2 e2e 대응

파일은 `web/e2e/drawing-engine.spec.ts`다. 이 파일의 11개 시험은 서버 저장과 실제 Lightweight Charts 캔버스를 사용한다. 일봉·60분봉 시험만 시각을 공유하는 결정적 가짜 봉 응답을 넣는다.

| 요구 | 시험에서 확인한 결과 |
|---|---|
| 일봉 추세선 → 60분봉 | 저장한 시각·가격은 같고 소수 index의 화면 투영이 주기 비율에 맞는다 |
| 새로고침 | 서버에 저장된 앵커가 같은 값으로 다시 그려진다 |
| 핸들 끌기 | 끈 점만 바뀐다 |
| Shift 45° | 화면의 x·y 이동량이 같은 대각선으로 맞는다 |
| 복제 | Ctrl 몸통 끌기는 원본을 남기고 새 id로 만든다 |
| 복사·붙여넣기 | 활성 칸에 새 id를 만들고 탭 메모리 복사본을 사용한다 |
| 되돌리기·다시 하기 | 생성·붙여넣기·여러 개 이동을 한 동작씩 되돌리고 다시 한다 |
| 잠금·숨김 | 잠긴 것은 Delete로 지워지지 않고 숨긴 것은 차트에서 빠진다 |
| 순서 | 메뉴에서 맨 앞으로 보내면 z가 올라간다 |
| 여러 개 선택 | Ctrl 클릭과 Ctrl 빈 곳 상자 선택이 두 도구를 함께 고른다 |
| 개체 목록 | 고르기·눈·잠금·지우기와 그린 순서를 확인한다 |
| Alt 별칭 | Alt+T·Alt+H가 해당 도구를 켜고 Alt+F의 DOM 기본 동작이 차단된다 |

추가로 설정 초안의 취소·확인, 좌표 편집, 한글 조합 중 Enter, 마지막 스타일·자석 세기 복원, 전체 숨김 중 새 드로잉, 미전송 편집 복구, 오래된 revision의 409, 다른 탭이 고친 내용의 되돌리기 거절을 확인했다.

## 실제 Chrome GUI 검증의 한계

코디네이터가 새 임시 프로필의 headed Chrome과 `orca computer` 검증을 승인했다. #51의 기본 `scripts/offline.sh` 안에서 fake·서버·Chrome을 함께 실행했고 `chromiumSandbox: true`를 유지했다. 새 창의 접근성 트리에서 `vallythevally`, 시험용 localhost 주소, 차트·도구를 확인했다. 완료 신호 뒤 Playwright fixture가 자신이 만든 Chrome·fake·서버를 정리했고 Chrome PID가 종료된 것을 확인했다.

이 PC의 `orca-computer-use-linux`가 보고한 기능은 `observation.screenshot: false`, `actions.hotkey: false`, `surfaces.menus: false`다. 화면 읽기는 `screenshot_failed`로 이미지를 반환하지 않았고, `Alt+F` 입력은 `unsupported_capability: orca-computer-use-linux does not support actions.hotkey`로 거절됐다. 보안 설정과 격리 방식을 바꾸지 않았다.

따라서 네이티브 Chrome 메뉴가 실제로 열리지 않는지는 미확인이다. 임시 headed 시험의 성공은 격리된 브라우저·서버의 실행과 정리 성공만 뜻한다. 위 e2e의 DOM 기본 동작 차단을 네이티브 메뉴 검증으로 대신 주장하지 않는다.

코디네이터는 이 기능 제한과 화면 증거를 확인하고, 네이티브 확인을 미확인으로 남긴 PR 작성을 승인했다. 이는 네이티브 검증 완료나 병합 승인이 아니다.

## 도구 묶음의 경계

도구 일꾼은 `web/src/chart/drawings/tools/<id>.ts`와 테스트를 만들고 `tools/index.ts`에 한 줄을 더한다. 묶음 내부 도우미는 `tools/_<묶음>.ts`에 둔다. 서버 enum·점 수 표 21개와 단축키 표 7개 도구는 이미 있다. SQL·interaction·DrawingLayer·공통 설정 입력칸은 바꾸지 않는다. 새 Shape·StyleField·Placement·ToolContext 종류가 필요하면 코디네이터에게 엔진 변경을 청한다.

편집 확장은 `modes/index.ts`의 ModeSpec 등록과 `commands/index.ts`의 DrawingCommand 등록을 쓴다. 엔진은 경로·미리보기·완료 효과·일시적인 도형의 수명·되돌리기·저장을 맡고, 실제 시연 커서·지우개·템플릿·그룹 본문은 후속 PR에서 구현한다.

## 남아 있는 의존

- #4가 main에 없으므로 다른 탭의 변경은 창 초점·visibilitychange에서 다시 받는다. data_changed 연결은 승인된 #47의 일이다.
- 지운 기록 표는 승인대로 만들지 않았다. 삭제 뒤 늦은 옛 PUT이 드로잉을 되살릴 수 있다.
- 범위는 저장·칸별 거르기만 구현했다. 범위 선택과 레이아웃 삭제·칸 축소 시 범위를 넓히는 처리는 후속 범위 PR의 일이다.
- 독립 코드 리뷰는 PR 뒤 코디네이터가 gpt-6-astra/high로 진행한다.
