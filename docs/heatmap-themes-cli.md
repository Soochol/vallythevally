# 히트맵 테마 CLI

`scripts/themes.py`는 히트맵 **테마**를 명령 하나씩 바꾼다. AI 에이전트가 테마를 넣고 빼고 고칠 때 쓴다. 경로 계약은 [히트맵 테마 API](heatmap-themes-api.md)다. `PUT /api/heatmap/themes`를 curl로 직접 보내지 않는다. 그 경로는 문서 전체를 갈아 끼우므로 테마 하나를 빠뜨리면 그 테마가 지워진다.

## 명령

저장소 루트에서 실행한다. 서버 주소는 `--url`로 주고, 기본은 `http://127.0.0.1:8080`이다. 실서버는 `--url https://server.<tailnet>.ts.net`이다([서버 PC 실서버 운영](server-operations.md)).

```sh
python3 scripts/themes.py list
python3 scripts/themes.py show "반도체 소부장"
python3 scripts/themes.py create "로봇" --after "조선·방산"
python3 scripts/themes.py add "반도체 소부장" 한미반도체 HPSP 403870
python3 scripts/themes.py remove "2차전지" 엘앤에프
python3 scripts/themes.py rename "로봇" "로봇·자동화"
python3 scripts/themes.py move "로봇·자동화" --before "금융"
python3 scripts/themes.py delete "로봇·자동화"
python3 scripts/themes.py add "AI 반도체" 삼성전자 --dry-run
```

| 명령 | 하는 일 |
|---|---|
| `list` | 테마 이름과 종목 수 |
| `show <테마>` | 테마의 종목, 저장 순서 |
| `create <이름> [--before T \| --after T \| --first]` | 빈 테마를 만든다. 자리를 주지 않으면 맨 뒤다. 같은 이름이 있으면 바꾸지 않는다 |
| `rename <테마> <새 이름>` | 이름을 바꾼다 |
| `move <테마> --before T \| --after T \| --first \| --last` | 순서를 바꾼다 |
| `delete <테마>` | 테마를 지운다 |
| `add <테마> <종목>…` | 종목을 맨 뒤에 넣는다 |
| `remove <테마> <종목>…` | 종목을 뺀다 |

고치는 명령은 모두 `--dry-run`을 받는다. 바뀔 내용만 보이고 보내지 않는다. `--json`은 명령 앞에 둔다(`themes.py --json list`). 결과를 JSON 한 줄로 내고, 고치는 명령의 `result`는 `saved`, `unchanged`, `dry_run` 중 하나다.

## 규칙

- **테마는 이름으로 가리킨다.** 이름은 테마끼리 겹치지 않는다. 없는 이름이면 있는 테마 목록을 보이고 실패한다.
- **종목은 이름이나 6자리 코드다.**
  - 코드는 서버 종목 목록에 있어야 넣는다. 다만 `remove`는 목록에서 사라진(상장폐지 등) 코드도 테마에 있으면 뺀다.
  - 이름은 서버 종목 검색 결과 중 이름이 정확히 같은 종목 하나를 고른다. 그런 종목이 없으면 후보를 보이고 실패한다. 예를 들어 `삼성`은 실패하고 `삼성전자`는 된다.
  - 지수는 넣지 않는다.
- **하나라도 정해지지 않으면 아무것도 보내지 않는다.** `add`에 종목 셋을 주고 하나가 애매하면 셋 다 넣지 않는다.
- **이미 있는 종목 넣기, 없는 종목 빼기는 알리기만 한다.** 바뀐 것이 없으면 PUT하지 않는다.
- **명령마다 최신 문서에 적용한다.**
  1. GET으로 최신 테마 문서를 읽고, 명령만 적용한다.
  2. revision은 `max(저장된 값 + 1, 지금 밀리초)`로 보낸다. 셋업 동기화가 revision이 큰 쪽을 이기게 하므로([ADR 0024](adr/0024-setup-storage-and-sync.md)) 브라우저와 같은 밀리초 시각을 쓴다.
  3. 다른 편집과 겹쳐 409를 받으면 다시 읽어 같은 명령을 다시 적용한다. 3번까지 하고 그래도 겹치면 실패한다.
- **상한과 이름 모양은 서버가 검사한다.** 서버가 거절하면 그 이유를 그대로 보인다.

종료 코드는 0(성공, 바뀐 것 없음, `--dry-run` 포함), 1(거절: 애매한 종목, 없는 테마, 서버 400, 계속 겹침), 2(서버에 닿지 못함)다.

## 시험

```sh
python3 -I scripts/test-themes.py
```

루프백의 가짜 서버에 붙어 명령별 결과, 이름 해석, 409 뒤 다시 적용, `--dry-run`, 종료 코드를 확인한다. 실제 서버는 부르지 않는다. 머지 검사(`chute.toml`)는 이 시험을 돌리지 않으므로 `scripts/themes.py`를 고치면 직접 돌린다.
