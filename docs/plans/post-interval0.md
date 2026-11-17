# 머지 뒤 e2e 간격을 0으로 되돌린다

- 작성일: 2026-11-17
- 승인 시점의 기록이며 구현 중 바뀐 것은 반영하지 않는다.

## 사용자가 풀려는 문제

PR #452가 `chute.toml`에 `post_verify_interval = 180`을 넣어 머지 뒤 e2e가 앞 검사를 시작하고 180분이 지나야 다시 돈다. 사용자는 머지 뒤 검사가 곧바로 돌기를 바란다. 사용자의 말(그대로): "timer 0으로 변경해줘 그럼 바로 돌리는거지".

0이면 기본 브랜치가 움직인 뒤 지금 검사가 끝나는 대로 다음 검사가 돈다(chute README의 `post_verify_interval` 행과 "머지 뒤 검사 · 큐와 따로 돈다"). 오늘 오후 PC 부하가 높았던 원인 가운데 하나가 이 동작이었다는 것을 사용자는 들었고, 그래도 바꾸기로 했다.

## 확정된 결정

- `chute.toml`의 `post_verify_interval`을 0으로 한다.
- `docs/web-checks.md`의 "`post_verify_interval = 180`은 …" 문장과, `AGENTS.md`·`docs/web-checks.md`의 "머지 뒤 검사가 몇 시간 늦게(간격으로만) 돈다"는 문구를 0에 맞게 고친다.
- `web/`를 고치는 작업이 관련 e2e spec을 직접 돌린다는 규칙은 남긴다. 머지 뒤 검사는 머지된 뒤에야 돌기 때문이다.
- `[[post_verify]] e2e` 단락, `post_verify_hold`, batch `[[verify]]`는 그대로 둔다.

## 스스로 정한 결정과 이유

- **줄을 지우지 않고 `post_verify_interval = 0`으로 적는다.** 0은 chute 기본값이라 줄을 지워도 동작은 같다. 적어 두면 간격을 일부러 두지 않았다는 것이 파일에 보이고, 다음에 간격을 다시 바꿀 사람이 키 이름을 찾지 않아도 된다. 설치된 chute로 둘 다 확인했다. 현재 `chute.toml`에서 값만 0으로 바꾼 임시 파일과 줄을 지운 임시 파일 모두 `chute config-check --file …`이 종료 코드 0, "설정이 올바르다 … (검증 단계 6개)", "머지 뒤 검사 단계 1개 e2e · … 시간 제한 1800초"를 냈다.
- **문서의 간격 설명은 chute README의 뜻대로 적는다.** "머지마다 돈다"가 아니라 "기본 브랜치가 움직이면 앞 검사가 끝나는 대로 그때의 tip을 검사한다"로 쓴다. tip만 검사하고 사이 커밋을 하나씩 검사하지 않는다는 기존 문장은 그대로 둔다.
- **관련 spec 규칙의 이유를 "머지된 뒤에야 돈다"로 바꾼다.** 간격이 0이어도 머지 뒤 검사는 PR이 기본 브랜치에 들어간 뒤에 돈다. 실패를 알게 되는 것은 머지 뒤이고 범인 찾기와 되돌리기가 뒤따른다. 그래서 머지 전에 작업자가 관련 spec을 돌리는 규칙은 여전히 필요하다. `AGENTS.md`의 규칙 줄과 `docs/web-checks.md`의 고르는 기준은 이유 구절만 바꾸고 나머지는 그대로 둔다.
- **사람 승인을 기다리지 않는다.** `chute.toml`의 `approval = "agent"`이고, chute #84(3f37163) 뒤로 `chute.toml`을 고치는 PR도 신뢰 모드에서 승인 없이 큐에 들어간다. 지금 도는 chute 데몬 두 개는 18:42에 시작했고 실행 파일(`~/.cargo/bin/chute`, 18:42)에 #84의 문구("신뢰 모드에서도 사람 승인이 필요하다")가 들어 있다. 예외(PR의 `chute.toml`을 읽지 못하거나 파일을 지울 때)에 걸리지 않도록 파일을 지우지 않고 값만 바꾼다.
- **작업은 하나, PR 하나로 한다.** 바뀌는 파일은 `chute.toml`, `AGENTS.md`, `docs/web-checks.md` 셋이고 문서는 설정의 값을 설명한다. 따로 머지하면 한동안 문서와 설정이 어긋난다.
- **머지되면 곧바로 머지 뒤 검사가 돈다.** 데몬은 batch가 가져온 기본 브랜치의 `chute.toml`을 읽으므로, 이 PR이 머지된 뒤 tip이 마지막 통과(c995df4)나 마지막 실패(7a4db6c)와 다르면 바로 검사를 시작한다. `paths`는 마지막 통과 커밋과 비교하므로 그 뒤 `web/`가 바뀐 지금은 e2e가 돈다. 작업자가 따로 할 일은 없다.

## 작업

| 작업 ID | 내용 | 방식 | 방식의 이유 | 순서 |
|---|---|---|---|---|
| `post-interval0` | `chute.toml`의 `post_verify_interval`을 0으로 바꾸고, `AGENTS.md`와 `docs/web-checks.md`의 간격 문구를 맞춘다 | `basic` (`minor-fix`) | 설정 값 하나와 문서 문구만 바꾼다. 머지 전 batch 판정(`[[verify]]`)과 `post_verify_hold`는 그대로여서 main에 들어가는 것을 정하는 판정은 바뀌지 않는다. 값은 chute 기본값이고 설치된 chute로 확인했다 | 단독 |

## 범위 밖

- `[[post_verify]] e2e` 단락의 `run`, `probe`, `timeout`, `failed`, `paths`와 `post_verify_hold`, batch `[[verify]]`, `preflight`.
- e2e 시험, `scripts/web.py`, Playwright 설정, chute 코드, orch 절차 문서.
- 머지 뒤 검사의 부하를 줄이는 다른 장치(`machine.toml`의 `max_verify`, worker 수).
- `docs/plans/`의 이전 계획 문서.

## 사용자가 정해야 하는 결정

없다. 참고로 작성 시점 `chute status --json`의 `post_verify`는 마지막 통과 c995df4(11:52), 마지막 실패 7a4db6c(`e2e/list-format.spec.ts:70`, 범인 #423, batch `b20261117-120342`), 마지막 시작 17:48이다. 이 PR이 머지되면 바로 tip을 검사한다. 같은 시험으로 실패하고 #423이 기본 브랜치에 남아 있으면 범인을 다시 찾지도 알리지도 않는다. 다른 시험으로 실패하면 c995df4와 tip 사이의 머지(작성 시점 28개)를 이분 탐색해 전체 e2e를 대략 5번 더 돈다. #423의 실패를 먼저 처리할지는 이 플랜과 별개다.
