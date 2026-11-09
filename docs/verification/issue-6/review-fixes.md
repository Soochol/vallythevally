# PR #53 독립 리뷰 수정 검증

2026-11-10. 기존 엔진의 F1~F7 반례를 2186032에 실패 회귀로 먼저 고정했다. 다음 수정은 승인된 제안서 §7.2와 기존 서버·삭제 묘비·Ctrl 복제·내용 비교 Undo 정책을 유지한다.

| 지적 | 수정 전 실제 실패 | 수정 후 같은 경로 |
|---|---|---|
| F1 | 완료한 최신 GET 뒤 옛 PUT ACK가 굵기 4를 2로 되돌려 Undo가 다른 탭의 선을 DB에서 삭제. 최초 지연 GET 중 생성하면 기존 항목 소실 | 두 탭 실제 브라우저·HTTP·SQLite에서 굵기 4 유지와 Undo 충돌 알림, 최초 목록 2개 보존 |
| F2 | 새 미전송 DELETE가 옛 PUT 저널을 못 바꾸고, 옛 ACK 뒤 저널 소실. 재시작 뒤 선이 부활 | 동일·60초 뒤진 시계에서 DELETE 저널과 UUID 보존, 재시작 재전송으로 DB 삭제 |
| F3 | 받은 이력보다 오래된 hline 몸통을 끌어도 가격 불변 | 실제 canvas의 이동·Ctrl 복제 모두 가격 변경과 원 t 보존. 정상 이력 대조도 통과 |
| F4 | 첫 끌기의 두 번째 점을 버려 셋째 클릭에서 place 효과가 비어 있음 | 첫 끌기 두 점과 셋째 클릭으로 완료. 세 번 클릭과 oneClick 대조 유지 |
| F5 | 1,100 샘플 뒤 600에서 놓아도 끝점 499.5 | 같은 입력의 끝점 600. 20,501개 포인터 입력에서도 capture 최대 4,096점, 최신 입력과 끝점을 보존하고 finalize 뒤 저장 1,000점 제한 |
| F6 | 실제 글자 픽셀이 있는 곳의 hit가 null | 실측 공통 레이아웃으로 hit=fill. 줄바꿈·여백·회전·기울임·미리보기·임시 도형에서 불투명 글자 픽셀 누락 0 |
| F7 | 실제 PUT 200인 t=9007199254740991 수평선의 좌표 탭이 Invalid time value | 설정 유지, 가격 편집 후 원 t 보존. 시각을 쓰는 도구도 정수 초 입력으로 안전하게 표시·검증 |

## F2 복구 수명과 실패 경계

처음 스케치의 메모리 전용 admission 대기는 코디네이터 검토에서 거절됐다. 두 실제 브라우저 탭의 별도 구조 프로토타입에서도 잠금을 기다리며 닫으면 네 경우 모두 의도를 잃었다. 이 증거는 제품 검증과 구분한다.

최종 제품은 UUID별 pending 기록을 낙관적 화면 반영 전에 동기 저장한다. pending 키와 임의 id의 공유 키는 서로 다른 namespace다. Web Lock은 admission·migration·정확한 UUID 정리에만 사용한다. HTTP·목록 조회 대기 동안 잠금을 유지하지 않는다. PUT revision과 intent order는 새 편집에서 한 번 정하고 복구·재시도에서 보존한다.

- 실제 앱·HTTP·SQLite에서 PUT, DELETE, PUT→PUT, PUT→DELETE 후 다른 탭의 잠금이 풀리기 전에 닫아도 재시작 복구를 확인했다. 닫을 때 고유 pending 기록과 대기 중인 실제 Web Lock도 확인했다.
- 같은 문서의 옛 admission이 새 DELETE를 덮지 않고, DELETE 하나만 전송되며 재조회 후 재전송이 없음을 확인했다.
- 실제 앱에서 고정 revision 복구와 Web Locks 미지원·거절·pending 저장 실패·공유 저장 실패를 확인했다. 실패는 저장 실패로 남고 무잠금 전송은 없다.
- 실제 브라우저의 제품 DrawingJournal과 native Storage/Web Locks로 ACK 정리와 새 admission의 두 잠금 순서, v1 migration과 v2 경합, 멈춘·뒤진 시계의 revision floor, id namespace 분리, 제거된 옛 intent의 재admission·복구 차단을 확인했다. 이 어댑터 검증을 DB 검증으로 세지 않는다.
- cleanup 저장소 오류가 나도 더 오래된 pending을 먼저 정리하기 전에는 최신 DELETE를 제거하지 않는다. 초기 저장소 읽기 실패 뒤 재시도는 기록을 다시 찾아 고정 revision으로 복구한다. 동기 저장에 실패한 Undo는 기록을 소비하지 않는다.

## 실행 경로와 자료

모든 앱·시험은 #51 기본 offline.sh 안에서 실행했다. 앱 fixture는 fake REST·WS를 명시하며 실제 Kiwoom·LOGIN·환경 파일을 열거나 호출하지 않았다. Chromium sandbox를 유지했고 전역 설정·원래 pre-push hook을 바꾸지 않았다.

Vitest의 drawing/좌표/history/입력/geometry와 Playwright의 drawing-engine, f3-regression, sync-settings-regression, journal-regression, admission-recovery, journal-controls, text-layout 회귀를 사용한다. 최종 전체 검사는 원래 pre-push hook의 scripts/check.sh로 실행한다. 원본 로그·trace·잠금/저널 JSON은 코디네이터가 지정한 외부 reports/fix-53에 보존한다.

[극단 시각의 좌표 설정 화면](review-fixes-settings.png)과 [실측 수평선 글자 화면](review-fixes-text.png)을 추가했다. 기존 화면 자료는 덮어쓰지 않았다.

네이티브 screenshot·hotkey·menus 미지원 제한을 다시 시도하지 않았다. 위 실제 Playwright 포인터·DOM·canvas·스크린숏 검증은 네이티브 메뉴나 직접 손 입력 감각의 확인을 뜻하지 않는다. 그 항목은 여전히 미확인이다. 독립 재리뷰와 병합 판정은 코디네이터가 맡는다.

## 절차와 남은 범위

orchestration, poteto-mode Bug fix, how, architect와 arena의 후보 비교·Astra 교차 심판을 실행했다. 첫 Agree에서 F1·F3~F7과 Web Locks 의존을 승인받았고, F2는 동기 pending 수명을 보완한 두 번째 Agree 뒤 구현했다. 입력·레이아웃·저널 구현과 회귀를 분리된 poteto-agent에 맡기고 부모가 diff와 실제 결과를 확인했다.

TypeScript/type-system, model-the-domain, sequence-verifiable-units, prove-it-works, Playwright, React, tdd, deslop, no-comments/comment-sicko, technical-writing, unslop, PR 및 show-me-your-work 스킬을 적용했다. why는 기존 승인·git 이력을 직접 확인했고 전체 외부 조사 fan-out은 실행하지 않았다. no-comments 두 검토 모두 삭제 권고·MUST KILL·HOLD 0건이다.

읽은 플레이북은 Bug fix와 Opening a PR이다. `skip: Codex review follows`이며 코디네이터가 독립 재리뷰를 붙인다. CI 대기는 사용자 지시로 생략한다. 네이티브 미지원 도구 재시도, 실제 Kiwoom, cargo fmt, 새 worktree, ADR/GLOSSARY, 후속 도구·범위·편집 확장·#46 혼합·묘비 추가·병합은 이번 작업 범위에서 제외했다. 삭제 성공 뒤 이미 전송된 옛 PUT의 서버 부활 한계는 승인대로 남는다.
