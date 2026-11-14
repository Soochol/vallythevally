# hoga-ops의 두 목록 옮기기

도구는 hoga-ops schema 4의 관심종목과 히트맵을 읽고, vallythevally의 **관심종목**, **히트맵** 두 목록으로 바꾼다. 그룹명, 그룹 순서, 그룹별 종목 순서, 빈 그룹, 여러 그룹 소속을 보존한다. `0158S0` 같은 영숫자 종목코드도 받는다. 메모는 제외하고 보고서에 그룹과 위치를 기록한다.

## 원본과 대상 확인

원본 파일을 두 번씩 읽어 바이트가 같은 스냅샷만 사용한다. 세 번 연속 바뀌면 중단한다. 관심종목은 `folders[].items`의 code 항목이 소속을 정한다. 히트맵은 `entries[].folder_id`와 `order`가 소속과 순서를 정한다. 관심종목의 `entries`는 종목 메타데이터여서 소속 없는 항목을 임의로 그룹 없음에 넣지 않는다. 그런 항목이나 잘못된 참조, 같은 그룹 안의 중복 종목, 중복 그룹 id와 이름은 오류로 보고한다.

다음 명령을 저장소 루트에서 실행한다. `--apply`가 없으면 dry-run이다. `--output`은 매번 새 경로를 지정한다. 기존 백업과 보고서는 덮어쓰지 않는다.

```sh
python3 scripts/import-hoga-watchlists.py \
	--watchlist /home/dev/.local/share/hoga-ops/data/watchlist.json \
	--heatmap /home/dev/.local/share/hoga-ops/data/heatmap.json \
	--url http://127.0.0.1:8080 \
	--dry-run --output target/hoga-plan-1
```

출력의 `counts`와 `exclusions`를 확인한다. 산출물은 다음과 같다.

- `watchlist-source.json`, `heatmap-source.json`: 실제 읽은 원본 바이트. 순서 비교에는 이 스냅샷을 사용한다.
- `plan.json`: 적용할 목록, 그룹, 종목, 제외한 메모 위치, 원본 SHA-256.
- `target.json`: GET으로 읽은 대상 전체 문서와 revision.
- `report.json`: 변경 여부, 원본과 대상의 개수, 해시, 서버 capability.

출력 디렉터리는 0700, 각 파일은 0600으로 만든다. 사용자 자료이므로 산출물을 커밋하지 않는다. dry-run은 원본과 대상 자료를 바꾸지 않는다. DB를 열거나 서버를 관리하지 않고 GET만 보낸다.

## 적용

다중 그룹 소속을 지원하는 서버와 UI를 함께 배포하고, 구버전 탭과 다른 구버전 쓰기 주체를 종료한 뒤 적용한다. GET 응답의 `X-Vally-Watchlists-Version: 2`가 필요하다. 이 헤더만으로 모든 브라우저가 최신인지 확인할 수는 없다. 구버전 서버에 새 DB를 노출하거나 키움 자격증명을 상속해 실제 서버를 재시작하지 않는다. 도구는 이 준비를 자동으로 수행하지 않는다.

안전한 실행 상태를 확인한 뒤 새 출력 경로로 실행한다.

```sh
python3 scripts/import-hoga-watchlists.py \
	--watchlist /home/dev/.local/share/hoga-ops/data/watchlist.json \
	--heatmap /home/dev/.local/share/hoga-ops/data/heatmap.json \
	--url http://127.0.0.1:8080 \
	--apply --output target/hoga-apply-1
```

서버 revision이 `r`이면 도구는 정확히 `r + 1`로 전체 문서 PUT 하나를 보낸다. 그 전에 `backup.json`에 원래 대상 문서를, `journal.json`에 원래 문서와 적용할 문서, revision, 원본 해시를 저장하고 파일과 디렉터리를 fsync한다. 백업 저장 실패 시 PUT하지 않는다. 이 백업은 관심종목의 논리 문서이며 SQLite 전체 백업은 아니다.

PUT 성공 응답을 받은 뒤 `ack.json`에 적용한 revision과 문서 해시를 기록하고 파일과 디렉터리를 fsync한다. 그 뒤 GET으로 목록 id, 이름, 순서, 그룹과 소속 전체를 비교한다. PUT 응답이 유실돼도 GET으로 확인하며 PUT을 반복하지 않는다. 가져올 내용이 이미 있으면 `unchanged`를 보고하고 PUT하지 않는다. 같은 원본으로 다시 실행할 때도 새 출력 경로를 지정한다.

`receipt.json`의 `applied`는 PUT 성공 응답을 저장하고 적용할 내용과 정확한 PUT revision을 확인했다는 뜻이다. HTTP 거절 뒤 같은 내용이 있거나 같은 내용이 다른 revision에 있으면 `satisfied-concurrent`를 보고한다. 응답 유실 뒤 정확한 revision에서 같은 내용이 확인되면 `satisfied-unowned`를 보고한다. 두 상태 모두 이 실행의 쓰기를 입증하지 않으므로 자동 복원할 수 없다. PUT 뒤 원래 문서가 그대로면 `unchanged`, 다른 문서나 확인 불가 상태면 `ambiguous`로 기록하고 실패한다. 충돌 때 최신 revision으로 다시 덮어쓰지 않는다.

## 복원

적용한 디렉터리의 `backup.json`을 지정한다. 옆의 `journal.json`과 `ack.json`도 필요하다.

```sh
python3 scripts/import-hoga-watchlists.py \
	--restore target/hoga-apply-1/backup.json \
	--url http://127.0.0.1:8080 \
	--output target/hoga-restore-1
```

도구는 성공 확인 파일의 해시와 revision이 journal과 일치하고 현재 문서도 그 문서와 정확한 revision일 때만 복원한다. 내용이 같아도 이후에 한 번 저장했으면 복원하지 않는다. PUT 성공 응답을 저장한 뒤 GET이 실패하거나 최종 `receipt.json`이 없어도 이 조건으로 복원할 수 있다. 원래 내용이 이미 복원돼 있으면 PUT하지 않는다.

PUT 전 journal만 있거나 HTTP 거절·응답 유실로 성공 확인이 없으면 자동 복원을 거절한다. 서버 적용과 성공 확인 파일 저장 사이에 프로세스가 중단된 경우도 같다. 같은 문서와 revision은 다른 쓰기 주체가 저장했을 수도 있다. 이 경우 백업과 journal은 읽기 전용 복구 자료로 보존하며 자동으로 복원 권한을 만들지 않는다.

복원도 새 백업과 journal을 만든 뒤 현재 revision의 `+1`로 PUT한다. 예전 백업의 revision을 그대로 보내지 않는다. 적용 이후 편집이 있거나 상태가 모호하면 현재 자료를 덮어쓰지 말고 `target.json`, `journal.json`, `ack.json`, `receipt.json`을 비교한다.

## 합성 자료로 검증

```sh
python3 scripts/test-import-hoga-watchlists.py
```

시험은 임시 원본과 loopback API를 사용한다. 기본 dry-run과 명시한 dry-run의 원본·대상 무변경, 소속과 순서, 영숫자 코드, 멱등성, 충돌, 백업 실패, 응답 유실, 조건부 복원을 확인한다. 실제 키움을 호출하지 않는다.
