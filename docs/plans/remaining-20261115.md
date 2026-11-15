# 미완료 작업 실행 플랜

작성일 2026-11-15. 승인 시점의 기록이며 구현 중 바뀐 것은 반영하지 않는다.

## 사용자가 풀려는 문제

사용자 요청은 "$orch 우선 추천으로 진행 . 미완료 항목도 진행"이다. 이미 승인된 자유형 창 배치를 이어 완성하고, 미뤄 둔 결함·문지기 후속·원고 검토를 빠뜨리지 않되 다른 탭과 같은 일을 중복 구현하지 않는다. 이번 문서는 실행 범위와 순서를 정한다. 기존 [레이아웃 설계](layout-free.md)를 재설계하지 않는다.

추가 요청 "planner도 codex 만들어줘 astra6"에 따라 부모가 planner 설정을 Codex/gpt-6-astra/high로 변경했다. 구현 작업자는 Codex를 쓰고 모델·effort는 orch 설정에 맡긴다.

## 확인한 기준과 현재 소유권

조사 기준은 `e5d0310d3584465905551b4310ebeaa538663b0e`이며 원격 main도 같은 SHA임을 확인했다. 조사 중 구현·시험·다른 탭 조작은 하지 않았다.

| 대상 | 확인한 상태 | 처리 |
|---|---|---|
| [win-manage #361](https://github.com/Soochol/vallythevally/pull/361) | 병합 커밋 `8a84ac4`; 기존 탭에는 running, 작업자 t1qz | 재구현하지 않음. 기존 소유자가 완료 정리 |
| [dock-move #362](https://github.com/Soochol/vallythevally/pull/362) | 병합 커밋 `e5d0310`; 기존 탭에는 running, 작업자 t1r1 | 재구현하지 않음. 두 잔여 결함만 별도 PR |
| 레이아웃 후속 7건 | 기존 탭에는 pending. 조사 중 현 탭에 같은 ID/name으로 등록됨 | 새 tasks.json에서는 제외 |
| 현 탭 layout-menu·dock-interact | 각각 t1r4·t1r5에서 running | 현재 작업자에게 변경 범위 시험 지시서를 전달 |
| 현 탭 나머지 레이아웃 5건 | pending | 같은 ID와 의존 순서로 이어 실행 |
| [#264](https://github.com/Soochol/vallythevally/issues/264) | open, 재무 E2E 간헐 실패 | 현재 Scenario 기반 시험에서 재현부터 확인 |
| [#175](https://github.com/Soochol/vallythevally/issues/175) | open, 주식수 차트가 재무 공개일에 종속 | 연구 도구의 독립 PR |
| [원고 #186](https://github.com/Soochol/vallythevally/pull/186) | open draft, 확인 HEAD `8ac5dd246fc48711dcaaeaa6c667a49dbe24c206` | 사용자 검토 자료만 준비, 승인 대행 안 함 |
| orch gate-ops·gate-probe | `357b91a`, `54fa751`; orch main `a22b60a`에 미통합 | 통합 후보 → done 결함 → 배포 기능 순서 |
| orch 운영 작업 폴더 | agents.json 수정 상태; 부모가 planner 설정 변경이라고 확인 | 다른 작업 변경에 섞거나 stash하지 않음 |

읽기 전용 운영 근거는 `/home/dev/.claude/orch/plans/tb5effe55b20e36c3be20a49416d84d12d.json`(기존 탭, t1jk), `/home/dev/.claude/orch/plans/tbc6d57a1be0e1d31a13676a32a7a975d1.json`(현 탭, t1q0), `/home/dev/.claude/skills/orch/orch.py`다. 초기 요청서의 "현 탭에는 2건뿐"이라는 상태는 조사 중 바뀌었으므로 위 상태를 사용한다. 작업 시작·목록 적재 직전에 다시 확인한다.

## 확정된 결정

- 기존 도킹·캔버스, 창 종류·최대 수·저장·연동·휴대폰 규칙은 layout-free와 ADR 0019를 유지한다.
- 기존 승인 범위의 구현, #264·#175와 보류 결함 조사·수정은 이번 추천 진행 요청에 포함한다. 실행에 필요한 사실은 코드·기록에서 확인하며 같은 사실을 사용자에게 다시 묻지 않는다.
- 작업자는 자기 변경 범위의 이름 붙은 시험만 돌린다. 전체 시험은 오케스트레이터가 병합 전 합쳐진 결과에 돌린다. 기존 지시서의 무인수 `web.py check/e2e` 및 전체 server 시험 조건을 이번 지시서에서 좁혔다.
- 실제 외부 원천 수집은 하지 않는다. #175는 합성 Bundle과 오프라인 HTML, #264는 합성 애플리케이션 응답으로 검증한다.
- 이번 플랜 문서만 커밋·push·PR 생성한다. 기능 PR 병합, 운영 orch 통합, 실제 서버 배포, 원고 최종 승인은 이번 일반 진행 요청으로 완료한 것으로 간주하지 않는다.
- 별도 hc/orch 세션을 만들거나 다른 탭의 계획 파일·창을 직접 고치지 않는다.

## 중복 작업 없이 이어 실행하는 방법

`create_worktree`는 같은 Git 저장소에서 기본 경로 `~/.herdr/worktrees/{repo}/{task}/{worker}`가 있거나 `orch/{task}/{worker}` 브랜치가 있으면 작업자를 띄우기 전에 멈춘다. 검사 사이에 경쟁이 생겨도 `git worktree add -b`가 같은 브랜치의 두 번째 생성을 거절한다. 따라서 기존 7개 **작업 ID와 worker name을 그대로 유지**하는 현 탭 실행안이 타당하다. 이름 변경·임의 worktree 경로·기존 worktree에서 별도 작업자를 띄우는 방식으로 이 검사를 우회하지 않는다.

이는 전역 작업 인수 명령이 아니다. 기존 탭의 pending 기록은 남으며 경로·브랜치를 정리한 뒤에는 같은 일을 다시 시작할 여지가 있다. 기존 소유자 t1jk가 자기 문맥에서 완료된 win-manage/dock-move를 확인해 `done --wait`로 정리하고, 넘긴 pending 항목은 `plan rm`으로 정리해야 한다. 의존 항목을 먼저 빼는 순서는 layout-venue-type → layout-finish → dock-float → sync-crosshair·canvas-ui → dock-interact·layout-menu다. 그 정리 전에는 기존 탭의 `plan start`를 재개하지 않으며, 현 탭도 7건의 브랜치·worktree를 성급히 청소하지 않는다. 현재 플래너가 t1jk인 척 `--terminal`을 지정하거나 JSON을 고치지 않는다.

현 탭에는 이미 7건이 있으므로 새 tasks.json으로 재등록하지 않는다. 실행 중 2건의 지시서는 부모가 정식 `orch send --task ... --message-file ...`로 전달하고, pending 5건은 시작 전 이번 지시서의 성공 조건을 반영한다. 공개 CLI에 지시서 갱신 명령이 없으므로 원본 JSON이나 복사된 지시서를 몰래 덮어쓰지 않는다. 필요하면 부모가 자기 탭에서 pending 후속부터 `plan rm`한 뒤 같은 ID/name·의존 순서로 `plan add`한다. 이미 실행 중인 작업은 제거하지 않는다.

## 작업 나눔과 순서

총 16건의 지시서다. 기존 등록 7건, 새 독립 2건, 레이아웃 뒤 결함 2건, 원고 읽기 전용 검토 1건, orch 로컬 변경 3건, 문지기 분리 제안 1건이다. 제품 구현 작업은 각각 PR 하나로 검토한다. 원격 없는 orch 변경은 로컬 커밋과 diff를 검토 단위로 삼는다.

| 작업 ID | 맡는 일 | 선행 조건 | 현재 적재 방식 |
|---|---|---|---|
| layout-menu | 이름 붙인 레이아웃 전환·저장·삭제·되돌리기 | win-manage 병합됨 | 기존 running 유지 |
| dock-interact | 탭 끌기·나누기·탭 순서·키보드 | win-manage 병합됨 | 기존 running 유지 |
| sync-crosshair | 시각 세로선 연동과 스위치 | layout-menu 병합 | 기존 pending 유지 |
| canvas-ui | 캔버스 조작·방식별 배치 기억 | layout-menu 병합, canvas-geometry 완료 | 기존 pending 유지 |
| dock-float | 도킹 창 띄우기·붙이기 | dock-interact·canvas-ui 병합 | 기존 pending 유지 |
| layout-finish | 두 방식 통합 흐름·접근성·문서 | sync-crosshair·dock-float 병합, win-link 완료 | 기존 pending 유지 |
| layout-venue-type | 주식/지수 거래소 조합을 타입으로 제한 | layout-finish 병합 | 기존 pending 유지 |
| financial-consistency-fix | #264 현재 응답 경쟁·시험 간헐 실패 | 없음 | 새 tasks 배열 |
| shares-publication-fix | #175 주식수별 사용 가능일 독립 선택 | 없음 | 새 tasks 배열 |
| manuscript-review | #186 원고·실물·한계 검토 자료 | shares-publication-fix 병합·결과 확인 | 새 tasks 배열, readonly |
| drawing-line-flake | 선 8종 저장/reload 간헐 실패 | layout-finish 병합 | 후속 plan add |
| dock-style-overlap | 긴 대각선·낮은 칸 스타일 막대 겹침 | layout-finish 병합 | 후속 plan add |
| orch-gate-integrate | 기존 두 브랜치 통합 후보와 교차 검증 | 로컬 쓰기 작업자 실행 경로 확인 | 별도 저장소 실행 보류 |
| orch-done-fix | 종료 사실·정리 실패를 분리하고 재시도 | orch-gate-integrate 운영 통합 | 로컬 순차 |
| orch-auto-deploy | 대기열 소진 후 1회 배포·보류·수동 명령 | orch-done-fix 운영 통합 | 로컬 순차, 운영 배포 보류 |
| gate-extract-proposal | 독립 도구 분리와 직접 push의 별도 제안 | G7 통합 후 2~4주 관측 | readonly 제안, 구현 제외 |

```text
layout-menu ─┬─ sync-crosshair ───────────┐
             └─ canvas-ui ─┐             │
dock-interact ─────────────┴─ dock-float ─┴─ layout-finish ─┬─ layout-venue-type
                                                          ├─ drawing-line-flake
                                                          └─ dock-style-overlap
financial-consistency-fix
shares-publication-fix ── manuscript-review
orch-gate-integrate ── orch-done-fix ── orch-auto-deploy
G7 운영 통합 ── 2~4주 관측 ── gate-extract-proposal ── 사용자 분리 판단
```

순차로 둔 이유:

- 레이아웃의 기존 의존은 앞 작업의 저장 통로·메뉴·캔버스 창 틀을 실제로 사용한다. layout-finish는 그 결과를 이어 검증하고 layout-venue-type은 그 뒤 확정된 소비자를 한 번에 바꾼다.
- 드로잉 선 및 스타일 막대 결함은 기존 추천대로 레이아웃 뒤에 고친다. 통합 마무리가 활성 칸 좌표·드로잉 접근성을 고치는 영역과 겹치기 때문이다. 둘 사이에는 입력/저장과 스타일 위치로 범위가 나뉘어 병렬이다.
- 원고 검토는 #175의 수정 결과를 받아 현재 원고의 실제 자료에는 해당 조합이 없었다는 기존 기록과 구분한다. 읽기 전용이며 최종 승인 작업이 아니다.
- orch 세 변경은 orch.py의 완료/대기열/보고 흐름 및 SKILL.md·시험을 공유한다. 기존 구현 통합을 기준으로 done 수정 후 배포 기능을 붙인다.

병렬로 둔 이유:

- layout-menu는 위 막대·저장기, dock-interact는 도킹 부품을 맡는다. 공유 layout store·CSS·문서에는 각자 맡은 동작/절만 최소 변경한다.
- sync-crosshair는 차트 컨트롤러와 새 시각 통로, canvas-ui는 새 창 틀을 맡는다. 메뉴·layout store 항목 추가는 최소 변경한다. 같은 함수를 다시 짜야 함이 드러나면 부모에게 겹침을 보고하고 그 부분만 순서를 조정한다.
- #264는 제품 재무 응답, #175는 research/leader-cases라 서로와 레이아웃 작업에 독립이다. 공통 harness·DTO를 광범위하게 바꾸는 것은 각 지시서 범위 밖이다.

## 스스로 정한 결정과 그 이유

1. **적재 파일과 전체 작업 목록을 구분한다.** 초안 폴더 tasks.json의 `tasks`만 plan load가 소비하며 현재 탭에 없는 신규 3건만 담는다. `existing_tasks`와 `deferred_tasks`는 부모가 읽는 일정 기록이고 orch가 자동 등록하지 않는다. 재적재 직전에 같은 ID가 이미 등록되었으면 해당 신규 항목을 적재 대상에서 제외하고 지시서·상태를 맞춘다. 한 번 적재한 tasks.json을 다시 load하지 않는다.
2. **다른 저장소를 한 번에 load하지 않는다.** plan_load는 항목별 cwd를 명령의 `--cwd`로 덮어쓴다. orch는 origin이 없어 create_worktree의 fetch도 실패한다. 현재 공개 CLI에는 내부 spawn의 기존 cwd 쓰기 실행 경로가 노출돼 있지 않다. `readonly`로 위장하거나 함수를 직접 호출하지 않는다. 부모가 기존 소유 작업자에 정식 지시할 수 있는지 확인하고, 없으면 지원 실행 경로 마련을 별도로 결정한다. 그 전에도 소스 검토와 통합 지시서는 준비할 수 있다.
3. **간헐 실패를 재현하지 못한 결과도 정직하게 남긴다.** #264는 이슈 당시 settleUpdate와 현재 코드가 다르다. 현재 기준 SHA의 반복 시험으로 확인하고, 실패가 없으면 해결 커밋·이슈 종료를 꾸며내지 않는다. 선 도구도 같은 원칙이다.
4. **막대 배치는 가능한 자리가 있을 때 확실하게 피한다.** 두 재현은 빈 자리가 있는데 겹치는 경우다. 정상 여백이 불가능하면 접하는 배치를 허용하되 조작 가능한 막대를 칸 안에 유지하는 것을 권장한다. 물리적으로 모든 것을 피할 수 없는 사례는 제한을 명시한다.
5. **배포 기능은 보류 상태로 검토한다.** win-manage가 병합됐다는 사실은 과거 보류 이유 하나를 없애지만 실제 운영 배포 승인까지 뜻하지 않는다. 가짜 명령·임시 데이터·loopback으로 기능을 검증한 뒤 대상 SHA·명령·백업·재시작 계획을 제출한다.
6. **원고와 분리는 제안으로 끝낸다.** #186의 기록상 검증과 이번 실물 확인을 분리한다. 문지기 모듈 이동과 병합 방식 변경은 서로 다른 검토 단위이며, 2~4주 실사용 뒤 구현 여부를 판단한다.

## 범위 밖

- 기존 레이아웃 설계 변경, 새 창 종류, 스크롤 연동, 브라우저 밖 창, 휴대폰 재설계.
- 사용자 대신 원고 문장·생애 날짜·화면 디자인을 최종 승인하거나 #186 draft를 해제/병합하는 일.
- 실제 키움/DART/그 밖의 원천 수집, 운영 DB 변경·서비스 재시작, 자동 배포 활성화.
- 다른 탭 상태 파일 직접 수정·창 종료, 터미널 사칭, 중복 검사를 피하는 새 ID/name.
- 문지기 분리 구현·직접 main push·공개 저장소 생성. 이번 조사는 원격 없는 orch 실행 제한을 우회하는 구현도 하지 않는다.

## 사용자가 정해야 하는 결정

이미 승인된 레이아웃 범위와 미완료 결함 조사를 다시 승인받는 단계는 두지 않는다. 다음 결정은 검토 가능한 산출물이 준비된 최종 단계에서 처리한다.

- **이 플랜 문서의 승인:** 신규 작업 분해·실행 경계·권장안을 확인한다. 승인 뒤 부모의 plan load가 플랜 PR을 병합한다. 현재 플래너는 병합하지 않는다.
- **기능 PR 및 orch 운영 통합:** 최종 HEAD·해당 시험·리뷰·병합 검사 결과를 보고받고 승인한다. orch는 원격 없는 실행 경로와 설정 변경 소유권을 부모가 먼저 확인해야 한다.
- **실제 배포:** 구체적인 대상 SHA·명령·백업·복구 절차를 보고 보류 해제 여부를 정한다. 기본값은 보류 유지다.
- **#186 원고:** 생애 날짜, 실적/가격 선후 해석과 한계, 디자인·패널 높이·모바일·절 순서 및 최종 원고를 직접 검토한다. 기본값은 draft 유지다.
- **문지기 분리:** G7 통합 뒤 2~4주 사용 근거와 단계별 제안을 보고 모듈 이동, 병합 방식 변경, 나중의 공개 여부를 각각 정한다. 기본값은 지금 분리하지 않음이다.

## 산출물과 검증

플랜 문서는 `docs/plans/remaining-20261115.md` 하나다. 지시서 16개와 tasks.json 및 부모용 실행 보고는 저장소 밖 `/home/dev/.claude/orch/plans/tbc6d57a1be0e1d31a13676a32a7a975d1-draft-20261115-113711/` 아래에만 둔다. 플랜 PR에 그 로컬 문서를 포함하지 않는다.

문서 검증은 JSON 구조·ID·의존 순서, 지시서 네 절, 참조 경로, 범위 시험 명령, 기존 작업 중복과 git diff 공백 검사를 사용한다. 구현하지 않았으므로 제품 전체 시험이나 실원천 시험을 돌리지 않는다. 코드 및 원본 자료를 확인한 사실과 구현 후 확인할 성공 조건을 구별한다.
