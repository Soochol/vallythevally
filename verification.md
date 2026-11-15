# 캔버스 UI 검증 근거

같은 창 목록을 도킹과 캔버스에서 쓰고 방식별 배치를 따로 기억한다. 차트 컨트롤러와 구독은 전환 중 유지한다.

검증 HEAD는 `c9c7f2853f2137f864a1da67c0d3af86bc2b1447`이다. 반영한 기준은 `50769abd5dc4814c2e58a124871d28b55d702d63`이다. 세 최종 실행은 clean HEAD와 같은 source 지문 `5ffe25b622be80a90374550e877464197c734b8fa1a705d94daf096c452d9743`을 기록했다.

다음 명령이 통과했다.

```sh
python3 scripts/web.py check src/layout/canvas src/layout/modes.test.ts src/layout/placement.test.ts src/persist/uiState.test.ts src/stores/ui.test.ts src/stores/layout.test.ts src/stores/layout.canvas.test.ts src/features/workspace/manage.test.ts
python3 scripts/web.py e2e e2e/win-canvas.spec.ts --workers=1
python3 scripts/web.py e2e e2e/win-shell.spec.ts e2e/win-manage.spec.ts e2e/win-layouts.spec.ts e2e/drawing-engine.spec.ts e2e/realtime.spec.ts e2e/float-surfaces.spec.ts
```

단위 시험은 146개, 캔버스 E2E는 14개, 지정된 기존 E2E는 75개 통과했다. 전체 로컬 시험은 실행하지 않았다. 병합 검사가 합쳐진 결과의 전체 시험을 담당한다. 모든 브라우저 입력은 합성 Scenario를 썼고 실제 키움이나 서버를 호출하지 않았다.

독립 gpt-6-astra와 gpt-6.1-sol 리뷰는 같은 최종 HEAD에서 입증된 미해결 결함 0개로 끝났다. 이전의 본문 클릭, 활성 창 닫기 되돌리기, 크게 보기 중 기존 창 요청, 암묵적인 도킹 배치 기억과 키보드 활성화 실패는 실제 재현 시험으로 고쳤다. 부모 세션도 원래 브라우저 실패 3개와 순수 배치 실패를 다시 실행해 통과를 확인했다. 독립 no-comments 검토의 추가 주석·억제 지시문·삭제·HOLD·MUST KILL 수는 모두 0이다.

첨부 PNG는 최종 clean HEAD의 실제 브라우저 캡처다. initial은 처음 도킹 좌표를 보존한 화면, overlap은 겹친 상태, guides는 실제 끌기의 안내선, tidied는 겹침 0인 정리 화면이다. images.json은 각 이미지의 SHA-256이다.

처음 전환할 때 원래 픽셀 사각형을 보존하므로 긴 창 몸통의 아래가 줄어든 캔버스 영역 밖으로 잘릴 수 있다. 창 종류 막대는 별도 아래 공간을 쓴다. 크게 보기나 가지런히로 전체 내용을 볼 수 있다. 아주 작은 묶음에서는 최소 크기와 다른 묶음의 경계를 지키도록 24px 비켜 쌓기를 줄인다. 머리가 새 아래 공간에 숨는 극단적인 배치에서는 머리 접근성을 우선한다.
