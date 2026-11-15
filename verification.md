# 캔버스 UI 검증 근거

같은 창 목록을 도킹과 캔버스에서 쓰고 방식별 배치를 따로 기억한다. 차트 컨트롤러와 구독은 전환 중 유지한다.

최종 검증 HEAD는 `9c200f20647b082c72ecd200cd36a1013b531e60`이다. 현재 main `217a6bc3ad258394c2cfdd9d9ec6390d9c5730a4`를 충돌 없이 합친 뒤 autosave의 정확한 PUT 기대 객체에 `layoutMode: "dock"` 한 줄만 추가했다. 알 수 없는 `phone: 1` 키, 전체 `toEqual` 비교와 기존 나머지 단언은 유지한다. 실제 저장 동작은 바꾸지 않았다.

부모 병합 검사와 같은 실패를 합친 리비전에서 재현했다. 타입 검사는 통과했고 정확 비교에서 새 정상 필드만 빠져 실패했다. 수정한 새 최종 HEAD에서 다음 명령이 통과했다.

```sh
python3 scripts/web.py check src/layout/canvas src/layout/modes.test.ts src/layout/placement.test.ts src/persist/uiState.test.ts src/persist/autosave.test.ts src/stores/ui.test.ts src/stores/layout.test.ts src/stores/layout.canvas.test.ts src/features/workspace/manage.test.ts src/chart/crosshairSync.test.ts
python3 scripts/web.py e2e e2e/win-canvas.spec.ts e2e/win-shell.spec.ts e2e/win-manage.spec.ts e2e/win-layouts.spec.ts e2e/drawing-engine.spec.ts e2e/realtime.spec.ts e2e/float-surfaces.spec.ts e2e/win-crosshair.spec.ts
```

타입 검사와 단위 시험 175개, E2E 98개가 통과했다. E2E는 새 캔버스 14개, 지정된 기존 회귀 75개와 합친 main의 십자선 연동 9개다. 두 실행은 clean HEAD와 같은 source 지문 `a4c03d3300df1c8f310a54959c2a78185716d7c77982590217ee191f3720f26d`을 기록했다. 전체 로컬 시험은 실행하지 않았다. 병합 검사가 합쳐진 결과의 전체 시험을 담당한다. 실제 키움이나 실서버는 호출하지 않았다.

새 gpt-6-astra와 gpt-6.1-sol의 독립 리뷰는 같은 최종 HEAD에서 입증된 미해결 결함 0개로 끝났다. 각 리뷰어가 실제 autosave 시험과 합친 저장소·배치 시험을 독립 실행했다. 추가 정확한 canvas/dock PUT 재현에서도 중첩된 알 수 없는 키 보존과 설정 재읽기를 확인했다. 독립 no-comments 검토의 추가 주석·억제 지시문·삭제·HOLD·MUST KILL 수는 모두 0이다.

첨부 PNG는 이 최종 HEAD의 실제 브라우저 캡처다. initial은 첫 도킹 좌표를 보존한 화면, overlap은 겹친 상태, guides는 실제 끌기의 안내선, tidied는 겹침 0인 정리 화면이다. images.json은 각 이미지의 SHA-256이다.

처음 전환할 때 원래 픽셀 사각형을 보존하므로 긴 창 몸통의 아래가 줄어든 캔버스 영역 밖으로 잘릴 수 있다. 창 종류 막대는 별도 아래 공간을 쓴다. 크게 보기나 가지런히로 전체 내용을 볼 수 있다. 아주 작은 묶음에서는 최소 크기와 다른 묶음의 경계를 지키도록 24px 비켜 쌓기를 줄인다. 머리가 새 아래 공간에 숨는 극단적인 배치에서는 머리 접근성을 우선한다.
