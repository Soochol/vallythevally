> 상태: 현재
> 다루는 코드: 없음
> 마지막 확인: 2026-11-10 (커밋 64c49b3)

# 문서 지도

궁금한 것을 표의 왼쪽에서 찾고, 오른쪽 문서를 연다. `docs/` 안의 문서와 폴더는 모두 이 지도에 있다. 경로는 이 파일이 있는 `docs/`를 기준으로 쓴다.

문서는 한 줄에 하나씩 싣는다. 폴더째 싣는 것은 `design/mockup/`, `research/` 아래의 주제 폴더, `verification/issue-<번호>/`뿐이다. 폴더 줄은 그 폴더 아래의 파일과 폴더를 모두 맡는다.

## 제품과 말뜻

| 무엇이 궁금한가 | 문서 |
|---|---|
| 이 도구는 무엇이고, 이 말은 무슨 뜻인가? | [`../GLOSSARY.md`](../GLOSSARY.md) |
| 무엇을 어떤 순서로 만드나? | GitHub 로드맵 이슈 #12(`gh issue view 12`) |

## 결정(ADR)

| 무엇이 궁금한가 | 문서 |
|---|---|
| 누가 이 도구를 쓰나? 여러 사람이 쓰려면 어떻게 하나? | [`adr/0001-personal-use-only.md`](adr/0001-personal-use-only.md) |
| 백엔드는 왜 Rust이고, 왜 Python을 쓰지 않나? | [`adr/0002-rust-backend-no-python.md`](adr/0002-rust-backend-no-python.md) |
| 시세를 왜 저장하지 않고 키움에서 다시 받나? | [`adr/0003-market-data-is-a-cache.md`](adr/0003-market-data-is-a-cache.md) |
| 키움 앱키와 토큰은 어떻게 다루나? | [`adr/0004-dedicated-kiwoom-app-key.md`](adr/0004-dedicated-kiwoom-app-key.md) |
| 지표 알림은 어느 봉으로 판단하고, 나중에 정정하나? | [`adr/0005-alerts-fire-on-realtime-bars.md`](adr/0005-alerts-fire-on-realtime-bars.md) |
| 관심종목과 화면 상태 같은 사용자 자료는 어디에 두나? | [`adr/0006-user-data-in-sqlite.md`](adr/0006-user-data-in-sqlite.md) |
| 거래소(통합·KRX·NXT)는 어디서 고르나? | [`adr/0007-venue-per-cell.md`](adr/0007-venue-per-cell.md) |
| 저장소를 왜 공개했고, 무엇을 커밋하면 안 되나? | [`adr/0008-public-repo-no-real-market-data.md`](adr/0008-public-repo-no-real-market-data.md) |
| 키움 오류에는 어떻게 대응하나? | [`adr/0009-kiwoom-errors-closed-categories.md`](adr/0009-kiwoom-errors-closed-categories.md) |

## 지금의 설계

| 무엇이 궁금한가 | 문서 |
|---|---|
| 백엔드(Rust) 코드는 어떻게 짜여 있나? 브라우저와 주고받는 계약은 무엇인가? | [`design/backend.md`](design/backend.md) |
| 차트 화면은 어떻게 생겼고, 프런트엔드 코드는 어떻게 짜여 있나? | [`design/frontend.md`](design/frontend.md) |
| 빌드 없이 열어 보는 화면 목업과 그 스크린숏은 어디 있나? | [`design/mockup/`](design/mockup/) |

## 제안서와 설계 결정 기록

| 무엇이 궁금한가 | 문서 |
|---|---|
| 설계 1차 수정에서 코디네이터와 사용자는 무엇을 정했나? | [`design/decisions-r1.md`](design/decisions-r1.md) |
| 설계 교차 리뷰는 무엇을 지적했나? | [`design/review-w4.md`](design/review-w4.md) |
| 드로잉 도구 21개와 편집 경험을 어떻게 만들기로 했나? | [`design/drawing-proposal.md`](design/drawing-proposal.md) |
| 키움 오류를 한 곳에서 판정하는 설계는 어떻게 제안됐나? | [`design/kiwoom-errors-proposal.md`](design/kiwoom-errors-proposal.md) |
| 거래소별 시세 모드는 어떻게 검토됐나? | [`design/venue-mode-proposal.md`](design/venue-mode-proposal.md) |

## 키움 실측

| 무엇이 궁금한가 | 문서 |
|---|---|
| 키움 REST API는 실제로 무엇을 답하나? 봉 개수, 과거 한도, WebSocket은 어떤가? | [`kiwoom.md`](kiwoom.md) |
| 키움 WebSocket의 오류 코드와 close 코드는 무슨 뜻인가? | [`kiwoom-ws-errors.md`](kiwoom-ws-errors.md) |

## 개발 환경

| 무엇이 궁금한가 | 문서 |
|---|---|
| 이 PC에서 무엇이 막히고, 어떻게 푸나? push 전에 어떤 검사가 도나? | [`dev-environment.md`](dev-environment.md) |

## 조사와 검증

| 무엇이 궁금한가 | 문서 |
|---|---|
| 종목 분석 리포트 미리보기(삼성전자)는 어떤 원자료와 스크립트로 만들었나? | [`research/2026-11-08-samsung-preview/`](research/2026-11-08-samsung-preview/) |
| 드로잉 제안서의 근거는 어디 있고, 얼마나 믿을 만한가? | [`research/2026-11-09-drawing/`](research/2026-11-09-drawing/) (안내: 그 폴더의 `README.md`) |
| PR이 실제 화면을 확인한 스크린숏과 기록은 어디 있나? | [`verification/issue-<번호>/`](verification/) (번호는 그 PR이 닫은 이슈) |

## 에이전트와 문서 규칙

| 무엇이 궁금한가 | 문서 |
|---|---|
| 에이전트는 이 저장소에서 어떻게 일하나? | [`../AGENTS.md`](../AGENTS.md) |
| 어느 문서를 누가, 언제 고치나? 새 폴더는 어떻게 만드나? | [`agents/document-policy.md`](agents/document-policy.md) |
| 에이전트는 용어집과 ADR을 언제 읽나? | [`agents/domain.md`](agents/domain.md) |
| 이슈는 어떻게 만들고 읽나? | [`agents/issue-tracker.md`](agents/issue-tracker.md) |
| 분류 라벨은 무엇이 있나? | [`agents/triage-labels.md`](agents/triage-labels.md) |

## 새 문서 양식

| 무엇을 쓰나 | 양식 |
|---|---|
| 기능 한 장: 사용자가 무엇을 할 수 있게 되나 | [`templates/feature.md`](templates/feature.md) |
| 정책: 사용자가 정한 운영 규칙을 지금 지킬 명령문으로 | [`templates/policy.md`](templates/policy.md) |
| 설계: 지금 코드의 경계, 타입, 실패 처리 | [`templates/design.md`](templates/design.md) |
| ADR: 한 번 내린 결정과 그 이유, 택하지 않은 안 | [`templates/adr.md`](templates/adr.md) |
| 제안서: 구현 전 선택지와 추천 | [`templates/proposal.md`](templates/proposal.md) |
| 실측: 바깥 시스템을 직접 잰 값 | [`templates/measurement.md`](templates/measurement.md) |
| 하는 법: 할 일의 순서와 막히는 곳 | [`templates/guide.md`](templates/guide.md) |
| 조사·검증: 질문, 출처, 근거의 세기 | [`templates/research.md`](templates/research.md) |

## 새 문서를 쓸 때

1. 위 표에서 맞는 양식을 골라 복사한다.
2. 첫 세 줄을 채운다.
3. 같은 PR에서 이 지도에 질문 한 줄을 더한다.

문서를 옮기거나 지우는 PR은 같은 PR에서 이 지도와, 그 경로를 적은 다른 문서(양식 포함)를 고친다. 누가 어느 문서를 고치는지는 [`agents/document-policy.md`](agents/document-policy.md)에 있다.

모든 문서의 첫 세 줄은 같은 모양이다.

| 줄 | 쓰는 값 |
|---|---|
| `상태` | 넷 중 하나. `현재`는 지금의 코드나 운영과 맞는 문서다. `제안`은 사용자가 아직 정하지 않은 문서다. `결정됨(#PR)`은 사용자가 결정한 문서이고, 괄호에 그 결정을 담은 PR을 쓴다. `대체됨(→ 문서)`은 다른 문서가 대신하는 문서이고, 화살표 뒤에 그 문서의 경로를 쓴다. |
| `다루는 코드` | 이 문서가 설명하는 코드의 경로. 여럿이면 쉼표로 나눈다. 없으면 `없음`이라고 쓴다. |
| `마지막 확인` | 문서를 코드와 대조한 날짜와 그때 커밋의 짧은 해시. 예: `2026-11-10 (커밋 64c49b3)`. |
