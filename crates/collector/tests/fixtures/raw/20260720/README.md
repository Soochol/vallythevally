# 원문 파일 고정 입력

hoga-ops가 2026-07-20에 키움에서 받아 둔 채록을 원문 파일로 옮긴 것이다. 값은 고치지 않았다. 앱키·시크릿·토큰은 없다(채록의 LOGIN 응답에는 토큰이 없다).

| 구간 파일 | 원본 | 채록 시각(KST) | 종목 | 내용 |
|---|---|---|---|---|
| `1955-000.jsonl.zst`, `2000-000.jsonl.zst` | `raw_0d_full.jsonl` | 19:56:20~20:00:00 | `005930_NX`, `000660_NX` | `0D` 2,382건(1,202 + 1,180) |
| `1025-000.jsonl.zst`, `1030-000.jsonl.zst` | `t2_frames_0B0F0w_account2.jsonl` | 10:27:55~10:32:55 | `000660`, `005380`, `005930`, `207940`, `373220` | LOGIN 응답 1, REG 응답 1, REAL 2,633줄. `0B` 6,880건, `0w` 205건, `0F` 24건 |

원본 경로: `/home/dev/.local/share/hoga-ops/data/research_capture/20260720/`

`raw_0d_full.jsonl`은 항목 단위 줄(`{"values":…,"type":…,"name":…,"item":…,"recv_ms":…}`)이다. 옮기는 도구가 줄마다 `{"trnm":"REAL","data":[{"values":…,"type":…,"name":…,"item":…}]}` 프레임으로 감쌌다. `values`의 키 순서와 값은 그대로다. `t2_frames_…`는 WS 프레임 단위 줄이라 `msg`를 그대로 프레임 줄로 옮겼다.

만든 명령(저장소 루트, 빈 폴더에서):

```sh
cargo run -p collector --example import_capture -- --data crates/collector/tests/fixtures --input <원본>/raw_0d_full.jsonl
cargo run -p collector --example import_capture -- --data crates/collector/tests/fixtures --input <원본>/t2_frames_0B0F0w_account2.jsonl
```

이미 파일이 있는 폴더에서 다시 돌리면 번호가 `-001`로 올라 같은 줄이 두 번 들어간다. 지우고 다시 만든다.
