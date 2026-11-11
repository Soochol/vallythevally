# 작업 규칙

이 저장소에서 일하는 사람과 에이전트가 지킨다. 용어는 [`GLOSSARY.md`](GLOSSARY.md)를, 큰 결정은 [`docs/adr/`](docs/adr/)를 따른다.

## 코드

- Rust 코드는 rustfmt 형식이 아니다. 주변 코드 모양을 손으로 따르고, `cargo fmt`는 돌리지 않는다.
- 새 코드는 이름과 타입으로 뜻을 드러내고, 주석 줄은 쓰지 않는다.
- 비밀값(`.env`, 앱키, 토큰)은 커밋하지 않고, 이슈·PR·댓글에도 쓰지 않는다(ADR 0008).

## 시험

- 서버: `cargo clippy --locked -p server --all-targets -- -D warnings`, `cargo test --locked -p server`(특정 파일만이면 `--test <이름>`)
- fake-kiwoom: `cargo test --locked -p fake-kiwoom`
- 웹: `cd web && pnpm install --frozen-lockfile && pnpm typecheck && pnpm test`
- e2e: `cargo build -p server -p fake-kiwoom`를 먼저 하고, `cd web && ./node_modules/.bin/playwright test [e2e/<파일>]`
- 키움은 fake-kiwoom으로만 시험한다. 시험에서 실제 키움을 부르지 않는다(ADR 0004).
- 로컬 시험은 unshare 없이 돌린다. `scripts/check.sh`는 지금 쓰지 않는다(나중에 CI로 옮긴다).
- 큰 빌드 출력과 임시 파일은 작업 폴더 안에 둔다.

## 커밋과 PR

- 커밋 메시지는 영어, PR 본문은 한국어로 쓴다.
- PR 본문 첫 줄에 `Closes #<이슈>`를 단다. 병합은 merge commit(`gh pr merge --merge`)으로 한다.

## 이슈와 새 기능

새 기능은 **spec부터** 만든다. 기능 하나는 spec 이슈 하나가 대표하고, 실제 작업은 그 아래 작업 티켓으로 나눈다.

```
spec 이슈 (라벨 spec)              ← 기능의 원본: 문제, 해결, 규칙, 시험
 ├─ 작업 티켓 (ready-for-agent)    ← PR 하나 = 이슈 하나, 순서는 막힘 관계(blocked by)
 ├─ 작업 티켓
 └─ 나중에 생긴 개선·버그           ← 같은 spec 아래 sub-issue로 단다
```

- **정할 게 많고 흐릿하면:** 먼저 wayfinder 맵(라벨 `wayfinder:map`)으로 결정을 하나씩 닫은 뒤 spec을 쓴다.
- **방향이 분명하고 PR이 여러 개면:** 바로 spec 이슈를 쓰고 작업 티켓으로 나눈다.
- **PR 하나로 끝나는 작은 일이면:** spec 없이 이슈 하나에 범위와 완료 기준을 적는다.
- **구현 중에 규칙이 바뀌면:** spec 이슈 본문에 반영한다. spec이 닫혀 있어도 그 기능의 원본이다.
- **작업 티켓에 담을 것:** 범위, 확인할 수 있는 완료 기준(돌릴 시험), 담당(백엔드/프론트엔드)

## 알려진 함정

- 키움 종목 목록에 있어도 일봉을 주지 않는 종목이 있다(예: 002785 진흥기업우B). 종목 하나의 실패로 전체 작업을 멈추지 않고, 그 종목만 건너뛰고 기록한다(#116).
- 시험은 "처음부터 실패하는 경우"와 "도중에 실패하는 경우"를 둘 다 덮는다(#118).
- `VALLY_CLOCK_START`(가짜 시계)는 서버의 시간 판단만 바꾼다. HTTP `Date` 헤더는 실제 시각이다. 둘을 함께 쓰는 시계 시험은 `clockStart: null`로 돌린다(#117).
- Playwright `clock.setSystemTime`은 벽시계만 바꾸고 `performance.now`는 그대로다.
- 임시 시험 파일을 `web/` 밖에 두면 ESM 설정이 없어 `import.meta`가 실패한다.
- 웹 `tsconfig`의 lib에는 `Promise.withResolvers`와 `DOMHighResTimeStamp`가 없다.
