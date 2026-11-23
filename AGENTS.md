# 저장소 규칙

- 도메인 용어는 [`GLOSSARY.md`](GLOSSARY.md), 관련 설계 결정은 [`docs/adr/`](docs/adr/)를 따른다.
- Rust는 주변 코드의 서식을 유지한다. `cargo fmt`는 실행하지 않는다.
- 새 코드는 이름과 타입으로 뜻을 드러내고, 주석 줄은 쓰지 않는다.
- 비밀값은 커밋하거나 이슈·PR·댓글에 기록하지 않는다.
- 키움 시험은 주입한 합성 transport·세션을 사용한다. 실제 키움은 호출하지 않는다.
- 부하·타이밍 재현은 지연 주입·가짜 시계 같은 결정적 방법이나 그 실행에만 거는 제한으로 한다. 무한 루프, `stress` 도구, 같은 시험을 여러 벌 동시에 돌리는 식으로 PC 전체에 부하를 걸지 않는다. 수단은 [`docs/e2e-tests.md`](docs/e2e-tests.md)와 [`docs/development-builds.md`](docs/development-builds.md)를 따른다.
- 큰 빌드 출력과 임시 파일은 작업 폴더 안에 둔다.
- 이 저장소의 PR은 chute로 머지한다. PR을 올리기 전에 `chute --skill`을 실행해 나온 절차를 따르고, `gh pr merge`나 기본 브랜치로의 직접 push는 하지 않는다.

## 개발 문서

- Rust 빌드·시험·배포 작업 전 [`docs/development-builds.md`](docs/development-builds.md)를 읽는다.
- 데스크톱 앱(`desktop/`) 작업 전 [`docs/desktop-builds.md`](docs/desktop-builds.md)를 읽는다.
- 웹 검사·E2E·브라우저 진단 작업 전 [`docs/web-checks.md`](docs/web-checks.md)를 읽는다.
- e2e 시험을 쓰거나 고치기 전 [`docs/e2e-tests.md`](docs/e2e-tests.md)를 읽는다.
- 히트맵 테마를 넣고 빼거나 고치기 전 [`docs/heatmap-themes-cli.md`](docs/heatmap-themes-cli.md)를 읽는다. 테마는 그 CLI로만 바꾼다.
- `web/`를 고치는 작업은 관련 e2e spec을 돌려 통과를 확인한다. 머지 뒤 검사는 머지된 뒤에야 돈다. 고르는 기준은 [`docs/web-checks.md`](docs/web-checks.md)를 따른다.
