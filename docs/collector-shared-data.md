# 공용 자료 파일

수집 데몬이 공용 자료를 파일로 쓰고 `vally-server`가 읽는다. 배경과 결정은 [플랜](plans/collector-shared-data.md)(확정 1, 결정 A1~A5)에 있다. 형식 타입과 쓰기 함수는 `crates/server/src/shared_data/`에 있고, 수집기는 그 타입으로 쓴다.

## 서버 설정

| 변수 | 뜻 |
|---|---|
| `VALLY_SHARED_DATA_DIR` | 자료 폴더. 절대 경로여야 한다. 없으면 서버는 아무것도 읽지 않고 동작이 지금과 같다. |
| `VALLY_SHARED_DATA_POLL_MILLIS` | 폴링 간격. 기본 1000. 1 이상의 정수. |

서버는 간격마다 종류 폴더에서 관측일이 가장 늦은 파일을 `stat`으로 보고, 지난번과 바뀐 파일만 블로킹 스레드에서 읽어 메모리 판을 바꿔 끼운다. 요청은 메모리 판만 읽는다. 읽지 못한 파일(깨짐, 모르는 형식 버전, 폴더와 다른 종류)은 이전 판을 두고 종류별 오류 수를 센다. 같은 파일 버전은 오류를 한 번만 센다.

## 파일 형식

한 파일 자료는 `{"header": {...}, "body": {...}}` JSON 하나다. 덧붙이는 자료는 JSONL이고 첫 줄이 머리(`header` 객체 자체), 이후 한 줄에 항목 하나다.

머리 칸(camelCase):

| 칸 | 뜻 |
|---|---|
| `formatVersion` | 형식 버전. 지금 1. 읽는 쪽은 아는 버전만 읽는다. |
| `kind` | 자료 종류(닫힌 열거형). |
| `observationDate` | 관측일 `YYYYMMDD`. |
| `asOf` | 자료의 기준 시각, Unix 초. 판의 나이는 지금 − `asOf`다. |
| `writtenAt` | 쓴 시각, Unix 초. |
| `sources` | 받은 키 이름과 증권사(`kiwoom`·`kis`) 목록. |

## 쓰는 규칙

- 한 파일 자료(`write_snapshot`): 같은 폴더의 임시 파일(`.<이름>.tmp-<pid>`)에 쓰고 `fsync` 뒤 rename한다. 읽는 쪽은 `<YYYYMMDD>.json`만 본다.
- 덧붙이는 자료(`FeedWriter`): 한 줄을 한 번의 쓰기로 보낸다. 다시 열 때 줄바꿈 없이 끝난 꼬리는 잘라 낸다. 읽는 쪽은 지난번 위치부터 읽고 줄바꿈이 없는 마지막 줄은 다음에 읽는다. 관측일 파일이 바뀌면 처음부터 읽는다. 파일이 줄었어도 처음부터 읽는다.

## 폴더 배치

`<VALLY_SHARED_DATA_DIR>/<종류 폴더>/<관측일>.<확장자>`다. 뒤 작업이 자기 줄을 더한다.

| 종류 | 폴더 | 한 파일(`.json`) | 덧붙임(`.jsonl`) | 본문 |
|---|---|---|---|---|
| `probe` (시험용) | `probe/` | `probe/<YYYYMMDD>.json` | `probe/<YYYYMMDD>.jsonl` | `ProbeBody`, `ProbeItem` |
