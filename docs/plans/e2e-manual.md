# e2e를 머지 뒤 자동 검사에서 빼고 수동으로 돌린다

- 작성일: 2026-11-17
- 승인 시점의 기록이며 구현 중 바뀐 것은 반영하지 않는다.

## 사용자가 풀려는 문제

chute가 머지마다 기본 브랜치에서 전체 e2e(`[[post_verify]] e2e`, 약 790개 시험)를 돌린다. 이 검사가 쉬지 않고 돌아 PC 부하를 키우고, 실패하면 범인 찾기가 수십 분에서 몇 시간까지 걸렸다(e2e-time 보고서, 2026-11-17). 사용자는 e2e를 언제 돌릴지 스스로 정하고 직접 돌리기로 했다.

사용자의 말(그대로): "사용자가 판단해서 e2e 하자 이렇게 수동으로 하도록".

## 확정된 결정

- 오케스트레이터가 보인 두 방법 가운데 A를 고른다. `chute.toml`에서 `[[post_verify]]` 단락을 빼고, 수동 실행은 `python3 scripts/web.py e2e`로 한다. 범인 찾기는 없다.
- B(chute에 수동 실행 명령을 만든다)는 하지 않는다.
- 수동 실행 명령은 `chute.toml`에 있던 것을 그대로 쓴다: `env VALLY_COMPILE_LANE=gate python3 scripts/web.py e2e --workers=6`.
- 머지 전 batch 검증(`[[verify]]`의 check, clippy, 크레이트별 시험)은 그대로 둔다.

## 스스로 정한 결정과 이유

- **`post_verify_interval`, `post_verify_hold`는 적지 않는다.** 지금 `chute.toml`에 두 키가 없다. 설치된 chute로 확인하니 `[[post_verify]]`가 없을 때 두 키 가운데 하나라도 0·false가 아닌 값으로 적으면 `chute config-check`가 "post_verify_interval과 post_verify_hold는 [[post_verify]] 단계가 있을 때만 쓴다"로 거절한다. 단락만 빼면 "설정이 올바르다 … 검증 단계 6개"가 나오고 머지 뒤 검사 줄이 사라진다.
- **수동 실행 안내를 `docs/web-checks.md`의 E2E 절에 한 단락 더한다.** 계획 기록(`docs/plans/`)을 뺀 저장소 문서에는 "머지 뒤 e2e가 돈다"거나 그 결과를 기다리라는 안내가 없다. 고칠 문장은 없지만, 자동 검사가 사라지면 전체 e2e가 어디서도 돌지 않는다는 사실과 전체 실행 명령을 적어 둘 곳이 필요하다. `AGENTS.md`가 E2E 작업 전에 이 문서를 읽으라고 하므로 여기에 둔다.
- **`docs/plans/`의 이전 계획 문서는 고치지 않는다.** 승인 시점의 기록이다.
- **`.github/workflows/ci.yml`의 e2e 작업은 건드리지 않는다.** GitHub Actions CI는 사용자가 일부러 꺼 두었고 이번 요청은 chute 머지 뒤 검사만 다룬다.
- **작업은 하나다.** 바뀌는 파일이 `chute.toml`과 `docs/web-checks.md` 둘뿐이고 함께 검토해야 뜻이 통한다.

## 작업

| 작업 ID | 내용 | 방식 | 방식의 이유 | 순서 |
|---|---|---|---|---|
| `e2e-manual` | `chute.toml`의 `[[post_verify]]` 단락을 빼고 `docs/web-checks.md`에 수동 실행 안내를 더한다 | `basic` (`minor-fix`) | 설정과 문서만 바꾼다. 머지 전 검증(`[[verify]]`)은 그대로여서 main에 들어가는 것을 정하는 판정은 바뀌지 않는다 | 단독 |

`chute.toml`을 고치는 PR이라 chute에서 사람 승인을 기다린다(`승인 대기`).

## 범위 밖

- e2e 시험 자체, `scripts/web.py`, Playwright 설정.
- batch의 `[[verify]]` 단계.
- chute 코드, chute에 수동 실행 명령을 만드는 일(방법 B).
- 이전 계획 문서와 GitHub Actions 설정.

## 사용자가 정해야 하는 결정

1. **지금 남아 있는 머지 뒤 검사 상태를 어떻게 할지.** 작성 시점 `chute status`에 기본 브랜치 405028e의 e2e가 검사 중이고, 커밋 7a4db6c의 실패(범인 #423, `chute revert b20261117-120342`)가 남아 있다. 이 PR이 머지되면 새 머지 뒤 검사는 생기지 않는다. 진행 중인 검사를 끝까지 둘지, 남은 실패 기록을 되돌리기(revert)로 처리할지, 그대로 둘지는 사용자가 정한다. 이 플랜의 작업은 chute 상태를 건드리지 않는다.
2. **전체 e2e를 언제 돌릴지.** 이제 자동으로 돌지 않으므로, 예를 들어 웹 화면 작업 묶음이 머지된 뒤처럼 돌릴 시점을 사용자가 정한다. 명령은 위 "확정된 결정"의 것이다.
