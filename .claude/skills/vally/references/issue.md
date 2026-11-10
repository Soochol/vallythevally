# Writing a vally issue

Create issues with `gh issue create --title "<type>(<area>): <user-visible problem>" --body-file <file>` and label `ready-for-agent` when the completion conditions are complete, `needs-info` when the user must answer first. Write the body in plain Korean for the user. Keep commit hashes, internal procedure names, and long evidence in a comment or under `reports/`.

Bug:

```markdown
## 문제
사용자 입장에서 무엇이 잘못 보이나. 한두 문장.

## 재현
1. …
기대: …
실제: …

## 완료조건
- 위 재현에서 수정 전 실패, 수정 후 통과를 시험으로 보인다.
- …

## 관련
#이슈, 문서 경로
```

Feature:

```markdown
## 목표
사용자가 무엇을 할 수 있게 되나. 한 문단.

## 완료조건
- 사용자가 확인할 수 있는 문장

## 범위 밖
- 이번에 하지 않는 것

## 관련
#이슈, 문서, ADR
```

Split work that needs more than one PR into GitHub sub-issues of a parent issue, one PR each.
