# Herdr와 pstack 오케스트레이션 저장소 조사

조사일: 2026-11-10. `herder`는 Herdr로 해석했다. GitHub 공개 저장소의 README, 구현 파일, 검증 기록을 조사했다. 이 PC에서 작업 실행이나 설치 검증은 하지 않았다.

현재 환경은 Herdr 데스크톱 앱 0.1.14와 `hc 0.1.19`다. 데스크톱 앱과 기존 Herdr TUI는 별도 프로그램이므로, `herdr plugin install`이나 `HERDR_ENV=1`만 요구하는 저장소를 데스크톱 호환으로 판단하지 않았다. [Herdr 공식 설명](https://herdr.dev/#questions), [herdr-core](https://github.com/herdrdev/herdr-core)

| 저장소 | 제공하는 기능 | 현재 데스크톱 환경과의 관계 |
|---|---|---|
| [conscientiousness/herdr-pstack-orchestrator](https://github.com/conscientiousness/herdr-pstack-orchestrator) | Pi, Codex CLI, Claude Code 작업자 실행과 선택적 원본 pstack 묶음 | 설치된 herdr-core를 우선 사용한다. 같은 작업 공간에 `hcOrch` 뷰어 탭을 표시한다. Core가 없을 때만 구형 Herdr를 사용한다. |
| [TiewKH/pstack-herdr](https://github.com/TiewKH/pstack-herdr) | pstack-claude를 포크한 Claude와 Codex 역할별 위임 | 조사한 README와 어댑터는 `HERDR_ENV=1`, `herdr tab/pane/agent`에 의존한다. hc 지원 근거를 확인하지 못했다. |
| [giuseppecrj/pi-herdr-pstack](https://github.com/giuseppecrj/pi-herdr-pstack) | Pi용 pstack 방법론 묶음 | 실행은 별도 `pi-herdr-agents`가 맡는다. 그 실행기는 Core 작업자 실행을 지원하지만 데스크톱 UI 연동에 제한이 있다. |
| [br1anchen/open-pstack](https://github.com/br1anchen/open-pstack) | 여러 에이전트용 pstack과 pair, trio, kitchen 협업 | README의 Herdr 설치 경로는 TUI 플러그인이다. 조사한 문서에서 hc 지원을 확인하지 못했다. |
| [michael-denyer/pstack-claude](https://github.com/michael-denyer/pstack-claude) | Cursor pstack을 Claude Code, Codex, Pi 등으로 옮긴 스킬 묶음 | 위 어댑터와 비교할 pstack 기반 프로젝트다. README만으로 Herdr 작업자 실행 지원을 판단할 수 없다. |

각 행의 기능은 연결한 저장소의 README를 근거로 정리했다. 소규모 프로젝트의 README 주장과 실제 실행 검증을 구분해야 한다.

## 가장 직접적인 후보의 검증 범위

`conscientiousness/herdr-pstack-orchestrator`는 요청한 Herdr, pstack, 오케스트레이터를 함께 제공한다. [README](https://github.com/conscientiousness/herdr-pstack-orchestrator/blob/main/README.md)와 [core_backend.py](https://github.com/conscientiousness/herdr-pstack-orchestrator/blob/main/skills/herdr-orchestrator/scripts/core_backend.py)에 Core 지원이 있다.

프로젝트가 공개한 검증 범위는 다음과 같다.

- Linux의 Core 0.1.17에서 모델을 쓰지 않는 Pi 테스트 실행기와 실제 설정한 Pi 작업자를 검증했다.
- Codex와 Claude Code는 시작 후 native idle 상태를 확인했다. 실제 설정한 모델의 작업 완료 검증은 남아 있다.
- 원본 pstack 23개 playbook 중 제한된 core workflow 통과는 5개다. 전체 playbook 호환을 보장하지 않는다.
- 영구 예약 후 재개, 원격 Core 오케스트레이션, 원격 또는 클라우드 실행은 현재 제공하지 않는다.
- 실행기는 로컬 POSIX endpoint와 Python 3.11 이상을 요구한다. macOS 검증은 남아 있다.
- 작업자 정의는 사용자 설정 파일이 결정한다. 역할과 모델을 자동으로 전역 선택하는 라우터는 아니다.

근거: [기능 및 검증 한계](https://github.com/conscientiousness/herdr-pstack-orchestrator/blob/main/docs/CAPABILITY-GAPS.md), [도입 검증 기록](https://github.com/conscientiousness/herdr-pstack-orchestrator/blob/main/docs/RELEASE-EVIDENCE.md), [Core 검증 요약](https://github.com/conscientiousness/herdr-pstack-orchestrator/blob/main/e2e/evidence/core-backend.json).

이 PC의 Core 버전은 공개 검증 버전보다 높다. 버전 숫자만으로 호환을 확정할 수는 없다. 현재 환경에서 가장 먼저 검토할 후보라는 판단은 Core 구현과 공개 검증 기록을 근거로 한 추론이다.

## Pi 대안과 오래된 포크

`pi-herdr-pstack`는 실행기가 아니라 방법론 묶음이다. [실행기 pi-herdr-agents](https://github.com/giuseppecrj/pi-herdr-agents)는 Core 일반 작업자 실행을 지원하지만, Core에서 관리하는 worktree와 데스크톱 Agents 탭 및 사이드바의 동등 기능이 아직 없다고 명시한다. 방법론 자체의 실제 모델 평가도 남아 있다. [방법론 README](https://github.com/giuseppecrj/pi-herdr-pstack/blob/main/README.md), [실행기 README](https://github.com/giuseppecrj/pi-herdr-agents/blob/main/README.md).

[Jakeelamb/herdr-pstack-orchestrator](https://github.com/Jakeelamb/herdr-pstack-orchestrator)는 conscientiousness 저장소의 포크다. 조사한 README는 구형 Herdr 0.9.3과 `HERDR_ENV=1`을 요구한다. Core 지원이 있는 원저장소와 구분했다.

## 함께 발견한 프로젝트

- [matteoscurati/harma](https://github.com/matteoscurati/harma)는 모델과 비용에 따라 작업을 배정하며 `herdr`와 `hc`를 지원한다. pstack 전용 어댑터라는 근거는 확인하지 않았다.
- [simoncrypta/bercail](https://github.com/simoncrypta/bercail)은 데스크톱 앱과 Core를 사용하는 작업 환경이다. 현재 README의 기본 구성은 bstack과 beads이며, pstack 검색 결과에 나타난다는 이유만으로 pstack 오케스트레이터로 분류하지 않았다.
- [khanghoang/noesis](https://github.com/khanghoang/noesis)는 Core 기반 TUI 구상이지만, README는 명세만 있고 구현 코드는 아직 없다고 밝힌다.

## 조사 방법과 한계

GitHub 저장소 검색에 `pstack herdr`, `herdr orchestrator`, `herdr-core orchestration`을 사용했다. 웹 검색 결과는 후보 발견에만 사용하고, 기능과 호환성은 저장소가 제공한 자료로 확인했다.

검색 결과 전체를 감사하지 않았고 설치, 모델 호출, 자동 작업 실행도 하지 않았다. 별 개수는 채택 판단에 사용하지 않았다. 공개 메타데이터의 조사 시점 값은 [sources.json](sources.json)에 남겼다.

