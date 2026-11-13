# 저장소 규칙

- 도메인 용어는 [`GLOSSARY.md`](GLOSSARY.md), 관련 설계 결정은 [`docs/adr/`](docs/adr/)를 따른다.
- Rust는 주변 코드의 서식을 유지한다. `cargo fmt`는 실행하지 않는다.
- 새 코드는 이름과 타입으로 뜻을 드러내고, 주석 줄은 쓰지 않는다.
- 비밀값은 커밋하거나 이슈·PR·댓글에 기록하지 않는다.
- 키움 시험은 주입한 합성 transport·세션을 사용한다. 실제 키움은 호출하지 않는다.
- 큰 빌드 출력과 임시 파일은 작업 폴더 안에 둔다.

## 개발 문서

- Rust 빌드·시험·배포 작업 전 [`docs/development-builds.md`](docs/development-builds.md)를 읽는다.
- 웹 검사·E2E·브라우저 진단 작업 전 [`docs/web-checks.md`](docs/web-checks.md)를 읽는다.
