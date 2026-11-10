# #6 엔진 작업 절차 기록

## 승인과 설계

이 작업은 TradingView 수준 드로잉의 기반을 만드는 엔진 PR이다. 범위는 승인된 제안서 §7.2이며 추세선·수평선만 등록한다.

이전 Claude 일꾼의 서버·순수 핵심 커밋과 frontend.md 미커밋 변경을 보존해 Codex가 이어받았다. 같은 worktree를 사용했고 메인 체크아웃을 수정하지 않았다. 기존 승인 기록을 복구했으며 새로운 정책 결정을 추정해 넣지 않았다.

- Architect Phase A·B의 탐색과 후보 둘은 이전 실행의 기록에서 복구했다. Phase C는 2026-11-09 승인됐다. Codex에서는 최신 main의 ChartController·봉 받기·UiState를 읽는 별도의 읽기 전용 how 탐색을 수행했다.
- Q1은 Ctrl+끌기다. 서버의 revision, 내용 비교 되돌리기, 묘비 표 생략, 서버 도구 21개·단축키 7개 도구 선등록, #47 전까지 초점 복귀 재조회도 승인된 결정이다. 제안서 §3.11·§5.2·§7.4에 반영돼 있다.
- #37이 0003을 사용해 드로잉 마이그레이션은 0004다. watchColumns와 activeWatchlistId를 보존했다. #51의 11c6a03 위로 rebase했다. #4는 이 기록 작성 시 아직 main에 없다.

## 작업 분할

차단 조건을 먼저 해소하고, 서버 저장, 순수 핵심, 상호작용 상태 기계, 저장 연결·환경, 화면 연결·도구, 문서·검증 순으로 커밋했다. 각 구현 단위에서 타입 검사와 해당 시험을 수행했다.

코드는 한 워커가 현재 worktree에서 작성했다. 이 Task는 하위 에이전트 사용을 선택으로 허용하면서 다른 worktree를 만들지 않도록 명시했다. 읽기 전용 how와 no-comments만 별도 에이전트에 맡겼다. 새 독립 코드 리뷰와 수정 라운드는 PR 뒤 코디네이터의 몫이다.

서버 확정본·요청 줄·기록은 sync.ts가 쓰고, 각 DrawingSurface는 끄는 중 미리보기만 가진다. 도구별 확장은 ToolSpec 등록 경계 안에 둔다. 작업을 나누면서 같은 파일에 동시 쓰기를 만들지 않았다.

## 적용한 스킬

이 Codex 실행에서 SKILL.md를 읽고 절차를 적용했다.

- orchestration, pstack:poteto-mode, pstack:recall, pstack:how, pstack:architect의 승인 설계 유지·구현 단계.
- pstack:principle-sequence-verifiable-units, pstack:principle-model-the-domain, pstack:principle-type-system-discipline, pstack:principle-prove-it-works.
- pstack:typescript-best-practices, vercel-react-best-practices, playwright-best-practices.
- pstack:deslop, pstack:no-comments, pstack:unslop, pstack:technical-writing, pstack:show-me-your-work, mattpocock-skills:pr.
- orca-computer-use는 승인된 시험 Chrome만 대상으로 사용했다. 화면 캡처·hotkey 제한 때문에 네이티브 메뉴와 직접 입력 조작감은 미확인이다.

별도의 사용자 AGENTS 분리 제안에만 skill-creator와 mattpocock-skills:writing-for-agents를 읽었다. 원래 드로잉 Task에서 AGENTS.md나 스킬을 수정하지 않았다.

이전 실행이 완료한 how·architect·arena 설계와 승인 지점은 복구한 기록을 근거로 재사용했다. 이를 이 Codex 실행의 새 설계 경쟁이나 새 승인으로 세지 않는다.

## 플레이북과 건너뛴 단계

- 읽은 플레이북은 Feature와 Opening a PR이다.
- Feature 1은 최신 코드의 how 탐색으로 보강했고, Feature 2는 승인된 설계를 복구해 구현에 적용했다. 새 후보 경쟁과 새 Phase C 질문은 이미 승인된 결정을 보존하라는 인계 지시에 따라 반복하지 않았다.
- Feature 3의 차단 조건·독립 작업·공유 상태·최소 분할을 작업 목록에 기록했다.
- Feature 4의 코드 작성 위임은 이 Task의 선택 허용과 단일 worktree 지시로 조정했다. 구현은 워커가 직접 맡고 독립 리뷰는 코디네이터가 진행한다.
- Feature 5는 실행한 앱과 서버·단위·e2e에서 확인했다. 네이티브 GUI 항목은 INCONCLUSIVE로 명시했다. 코디네이터가 이 제한을 남긴 PR 진행을 승인했다.
- Feature 6은 작은 커밋으로 구성하고 최신 main 위로 rebase했다.
- Feature 7은 `skip: Codex review follows`다. 코디네이터가 PR 뒤 gpt-6-astra/high 독립 리뷰를 붙인다.
- GitHub CI watch는 `skip: 사용자 결정으로 GitHub Actions CI가 꺼져 있고 원래 pre-push hook의 scripts/check.sh가 완료 기준이다`.
- 새 네이티브 provider나 보안 설정 변경은 시도하지 않았다. BASH_ENV 초안은 실행하지 않았다.

no-comments 읽기 전용 검토의 지적을 반영해 불필요한 주석 4줄을 지우고 Q7 미결정을 전제한 시험 이름을 고쳤다. 외부 Lightweight Charts의 소수 index 제약 주석과 생성기 소유 배너·공개 계약 설명은 유지했다. HOLD는 없다.

종합 독립 코드 리뷰와 그에 따른 병합 판정은 이 워커의 완료 선언에 포함하지 않는다. 로컬 결정 기록과 작업 목록은 코디네이터의 로컬 orchestration 기록에 보관한다.
