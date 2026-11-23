# 데스크톱 앱 릴리스와 자동 업데이트

배포한 앱이 새 판을 스스로 받고, 변조된 갱신본은 받지 않게 하는 구성과 릴리스 절차다. 계획과 결정(D4 코드 서명, D5 Windows 빌드 기계, D7 배포처)은 [데스크톱 앱 플랜](plans/desktop-app.md)에 있다. 개발 빌드와 실행은 [데스크톱 앱 빌드](desktop-builds.md)를 본다.

이 문서의 명령 가운데 **GitHub Release 만들기, 인증서 구매·발급, 업데이트 서명 키 생성은 모두 사용자 승인 뒤의 일이다.** 저장소에는 서명 비밀키도 인증서도 넣지 않는다.

## 앱이 하는 일

- 릴리스 빌드만 업데이트를 켠다. 저장소의 `tauri.conf.json`에는 `plugins.updater`가 없어서 개발 빌드와 연기 시험의 앱은 갱신 목록을 부르지 않는다. 설정이 없으면 플러그인도 올리지 않는다.
- 켜진 앱은 시작할 때 한 번, 그 뒤 6시간마다 갱신 목록(`latest.json`)을 본다. 목록의 판이 지금 판보다 높을 때만 새 판으로 본다. 같거나 낮으면 알리지 않는다.
- 새 판이 있으면 작은 알림 창("vally 업데이트")이 뜨고 앱 창 제목이 `vally · 새 판 X.Y.Z 있음`이 된다. 사용자가 "지금 설치하고 다시 시작"을 누를 때만 받는다. 자동 재시작은 없다. 장중 주문 중인 사용자를 끊지 않으려는 것이다. "나중에"를 누르면 창만 닫히고 제목 표시는 남는다. 알림 창은 다음 확인(6시간 뒤)에 새 판이 아직 있으면 다시 뜬다.
- 설치 순서는 받기, 서명 검증, 설치, 다시 시작이다. 서명 검증이 설치보다 앞서므로 검증에 실패하면 엔진은 그대로 돌고 설치도 일어나지 않는다. 알림 창이 "다시 시도"를 내놓는다. Windows는 설치 프로그램을 띄우기 직전에 엔진을 멈춘다. 설치 프로그램이 실행 중인 `vally-server.exe`를 덮어쓰지 못하기 때문이다. 그 뒤에 설치가 실패하면 알림 창이 "앱 다시 시작"을 내놓는다. Linux·macOS는 설치가 끝난 뒤 앱을 다시 시작하면서 엔진을 멈춘다.
- 확인 실패(네트워크, 목록 형식, 이 OS 항목 없음, 설정 오류)는 앱 사용을 막지 않는다. 표준 오류에 `[update] …` 한 줄을 남기고 앱 창 제목에 `vally · 업데이트 확인 실패`를 붙인다. 다음 성공한 확인에서 지워진다. 서명 불일치는 갱신본을 받아야 알 수 있으므로 사용자가 설치를 고른 뒤에 알림 창에 이유가 뜨고 제목에 `vally · 업데이트 설치 실패`가 붙는다.
- 업데이트 명령(`update_status`, `install_update`, `dismiss_update_notice`, `restart_app`)은 앱이 가진 로컬 화면(시작 화면, 알림 창)만 부를 수 있다. 엔진이 서빙하는 루프백 화면은 원격 출처라서 별도 capability가 없는 한 어떤 명령도 못 부른다. 설치 명령은 인자가 없고 이미 검증을 거친 새 판 하나만 다룬다.

## 서명 검증이 막는 것

공개키는 앱에 구워 넣고 비밀키는 릴리스 기계에만 둔다. 설정이 `requireSignedVersion`을 켠다.

| 상황 | 결과 | 시험 |
|---|---|---|
| 올바른 서명의 새 판 | 새 판으로 알린다 | `case_ga_a_correctly_signed_newer_release_is_recognized` |
| 갱신본이 한 바이트 바뀜 | 받기 단계에서 서명 검증 실패. 설치하지 않는다 | `case_na_an_artifact_with_one_changed_byte_is_not_installed` |
| 서명이 한 바이트 바뀜 | 같다 | `case_na_a_signature_with_one_changed_byte_is_not_installed` |
| 다른 키로 서명함 | 같다 | `a_signature_made_by_another_key_is_not_installed` |
| 목록의 판이 지금 판 이하 | 알리지 않는다 | `case_da_a_release_not_newer_than_the_running_version_is_not_announced` |
| 목록은 9.9.9인데 서명이 묶인 판은 0.0.5 | 설치하지 않는다(다운그레이드 막기) | `an_older_signed_artifact_cannot_be_passed_off_under_a_newer_announced_version` |

`requireSignedVersion`이 없으면 목록(서명되지 않음)을 바꿀 수 있는 쪽이 옛 판의 올바른 서명과 갱신본에 큰 판 번호를 붙여 내려받게 할 수 있다. 그래서 릴리스 설정은 이 값을 켜고, 서명에는 판 번호가 들어 있어야 한다(`tauri signer sign --app-version`, 또는 `tauri build`가 만드는 서명. 아래 "서명에 판 번호가 들어가는지" 참고). `release.py manifest`는 서명이 올리려는 판에 묶여 있지 않으면 목록을 만들지 않는다.

## 업데이트 서명 키

릴리스 기계(D5의 Windows PC)에서 한 번 만든다. 저장소 밖 폴더에 둔다.

```sh
cd desktop
pnpm install --frozen-lockfile --ignore-workspace
pnpm tauri signer generate -w "<릴리스 기계의 키 폴더>/vally-update.key"
```

비밀번호를 묻는다. 비밀번호를 쓰고, 키 폴더 밖의 안전한 곳(비밀번호 관리자)에 키 파일과 비밀번호를 따로 백업한다. 만들어지는 파일은 둘이다.

| 파일 | 성격 | 둘 곳 |
|---|---|---|
| `vally-update.key` | 비밀키. 갱신본에 서명한다 | 릴리스 기계와 백업만. 저장소·이슈·PR·로그·채팅에 넣지 않는다 |
| `vally-update.key.pub` | 공개키. 앱이 서명을 검증한다 | 비밀이 아니다. 릴리스 빌드의 입력이므로 릴리스 기계에 둔다 |

**키를 잃으면** 이미 설치된 앱은 새 판을 받지 못한다. 앱에 구워 넣은 공개키와 맞는 서명을 더 이상 만들 수 없기 때문이다. 새 키 쌍으로 앱을 다시 빌드해 사용자가 직접 내려받아 설치하게 해야 한다. 그 설치 뒤부터 자동 업데이트가 다시 된다. **키가 새면** 같은 이유로 공격자가 서명된 악성 갱신을 만들 수 있다. 같은 조치(새 키, 직접 재설치 공지)에 더해 유출된 키로 서명된 Release를 모두 내린다. 키를 바꾸는 것은 이 문서에서 가장 비싼 사고이므로 백업을 먼저 확인한 뒤에만 첫 릴리스를 올린다.

## 릴리스 빌드 순서 (Windows, 결정 D5)

사용자의 Windows 10/11 x64 PC 한 대에서 만든다. Rust(MSVC 툴체인과 Visual Studio Build Tools의 C++ 도구), Node와 pnpm, Python 3.11 이상, Git이 필요하다. NSIS는 `tauri build`가 처음 쓸 때 내려받는다. **이 순서는 Windows에서 돌려 보지 못했다.** 이 PC(Linux)에서 확인한 것은 설정 덧씌우기와 서명 산출물이 Linux AppImage로 만들어지는 것까지다(아래 "이 PC에서 확인한 것").

저장소 루트에서 PowerShell로 실행한다.

1. 판을 올린다. `desktop/src-tauri/tauri.conf.json`의 `version`을 새 판(semver)으로 고치고 커밋한다. 이 값이 앱이 아는 "지금 판"이고 갱신 비교의 기준이다.
2. 엔진과 화면을 만든다. [번들](desktop-builds.md#번들)과 같다. 대상 triple은 `x86_64-pc-windows-msvc`다.

   ```powershell
   cargo build --locked --release -p server
   New-Item -ItemType Directory -Force desktop\src-tauri\binaries | Out-Null
   Copy-Item target\release\vally-server.exe desktop\src-tauri\binaries\vally-server-x86_64-pc-windows-msvc.exe
   python .claude\skills\verify-vally\scripts\build_ui.py web\dist
   ```

3. 릴리스 설정 덧씌우기를 만든다. 공개키와 갱신 목록 주소가 여기서 들어간다. 저장소 기본 설정은 바꾸지 않는다.

   ```powershell
   $env:VALLY_UPDATER_PUBKEY_FILE = "<키 폴더>\vally-update.key.pub"
   python desktop\scripts\release.py config --output "$env:TEMP\vally-release.conf.json"
   ```

   덧씌우기는 `bundle.createUpdaterArtifacts: true`, `plugins.updater`(공개키, 갱신 목록 주소, `requireSignedVersion`)를 더한다. 갱신 목록 주소 기본값은 `https://github.com/Soochol/vallythevally/releases/latest/download/latest.json`(D7)이고 `VALLY_UPDATER_ENDPOINT`로 바꾼다. https가 아니면 만들지 않는다. 릴리스 프로필 빌드의 플러그인도 https가 아닌 주소를 거부한다.

4. 서명 키를 환경에 올리고 빌드한다. 비밀키는 이 셸 세션에만 둔다.

   ```powershell
   $env:TAURI_SIGNING_PRIVATE_KEY = "<키 폴더>\vally-update.key"
   $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = Read-Host "서명 키 비밀번호"
   cd desktop
   pnpm install --frozen-lockfile --ignore-workspace
   pnpm tauri build --bundles nsis --config src-tauri/tauri.bundle.conf.json --config "$env:TEMP\vally-release.conf.json"
   ```

   `tauri build`는 서명 키가 설정의 공개키와 맞는지 먼저 본다. 맞지 않으면 빌드가 멈춘다. 산출물은 `desktop\src-tauri\target\release\bundle\nsis\`의 `vally_<판>_x64-setup.exe`와 `vally_<판>_x64-setup.exe.sig`다.

5. 갱신 목록을 만든다. 서명이 이 판에 묶여 있는지 검사하고, 서명 파일을 목록에 옮긴다.

   ```powershell
   python scripts\release.py manifest --version <판> --notes "<변경 요약>" --artifact windows-x86_64=src-tauri\target\release\bundle\nsis\vally_<판>_x64-setup.exe --output latest.json
   ```

   갱신 본 주소는 `https://github.com/Soochol/vallythevally/releases/download/v<판>/<설치 파일 이름>`으로 만든다. 태그는 `v<판>`이다.
6. 올리기 전에 직접 본다. `latest.json`의 `version`, `url`, `signature`가 비어 있지 않은지, 설치 파일과 `.sig`가 같은 빌드에서 나왔는지, 이전 판이 깔린 Windows PC에 설치 파일을 직접 실행해 앱이 뜨는지 본다.

## 코드 서명

사용자가 처음 설치 파일을 실행할 때 보는 SmartScreen 경고와 macOS Gatekeeper는 코드 서명이 있어야 줄어든다. 업데이트 서명 키와는 다른 것이다. 업데이트 서명은 앱이 갱신본을 믿는 근거이고 코드 서명은 운영체제가 설치 파일을 믿는 근거다. 값은 [플랜](plans/desktop-app.md)의 "조사한 것"을 옮긴 것이다. **확인 날짜는 2026-11(웹 검색)이다. 이 작업에서 다시 확인하지 않았으므로 구매 전에 다시 확인한다.**

| 선택지 | 대략의 비용 | 메모 |
|---|---|---|
| 서명하지 않음 | 0 | SmartScreen 경고가 뜬다. 비공개로 시험하는 동안의 권장안(D4)이다. 사용자에게 경고를 안내한다 |
| SignPath Foundation | 무료 | 조건을 갖춘 오픈소스에만 해 준다. 이 저장소가 조건에 맞는지는 확인하지 않았다. 공개 배포 전에 먼저 확인한다 |
| OV 코드 서명 인증서 | 연 $150~300 정도(CA마다 다름) | 하드웨어 토큰이나 클라우드 서명이 필요하다. 유효기간은 2026-03부터 약 15개월(458~460일)이 상한이다. 평판은 파일마다 쌓인다 |
| EV 코드 서명 인증서 | 연 $400 이상 | 2024년부터 SmartScreen을 바로 통과하지 못한다. 값만큼의 이득이 없다 |
| Azure Artifact Signing(옛 Trusted Signing) | 월 $9.99 | 개인은 미국·캐나다, 조직은 미국·캐나다·EU·영국만 받는다. 한국 개인과 조직은 쓸 수 없다 |
| Apple Developer Program(macOS) | 연 $99 | 공증에 필요하다. Mac이 있어야 한다. 첫 지원 OS는 Windows(D2)라 지금은 쓰지 않는다 |

코드 서명은 기본으로 꺼져 있다. 결정 D4가 정해지면 아래 자리에 값을 넣는다. 설정 파일을 고치지 않고 릴리스 기계의 환경 변수만 설정한다.

| 대상 | 자리 | 환경 변수 |
|---|---|---|
| Windows | `bundle.windows.signCommand`. `release.py config`가 환경 변수가 있을 때만 덧씌우기에 넣는다. 명령 안의 `%1`이 서명할 파일 경로가 된다 | `VALLY_WINDOWS_SIGN_COMMAND` (예: `signtool sign /fd sha256 /sha1 <지문> /tr <타임스탬프 주소> /td sha256 %1`) |
| macOS 서명 | Tauri가 환경에서 직접 읽는다 | `APPLE_SIGNING_IDENTITY`, `APPLE_PROVIDER_SHORT_NAME` |
| macOS 공증 | 같다 | `APPLE_ID`, `APPLE_PASSWORD`(앱 암호), `APPLE_TEAM_ID`. API 키 방식은 `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH` |

macOS 쪽 이름은 Windows PC와 Linux PC에서 시험하지 못했다. `APPLE_SIGNING_IDENTITY`와 `APPLE_PROVIDER_SHORT_NAME`은 이 PC의 Tauri CLI 2.12.6 안에서 확인했다. 공증 변수는 Tauri 문서의 이름이다. macOS를 지원할 때 Mac에서 확인한다.

## GitHub Releases에 올리기

**사용자 승인 뒤에만 한다.** 아래 명령은 `gh`가 로그인된 릴리스 기계에서 돌린다. 초안(draft)으로 먼저 올리고, 자산이 모두 올라간 것을 확인한 뒤 공개한다. `latest`는 공개된 가장 최근 Release를 가리키므로 초안 상태에서는 앱이 이 판을 보지 못한다.

1. 태그와 초안 Release를 만든다.

   ```sh
   gh release create v<판> --repo Soochol/vallythevally --draft --title "vally <판>" --notes-file <변경 요약 파일>
   ```

2. 자산을 올린다. 설치 파일, 서명 파일, 갱신 목록이다.

   ```sh
   gh release upload v<판> --repo Soochol/vallythevally vally_<판>_x64-setup.exe vally_<판>_x64-setup.exe.sig latest.json
   ```

3. 초안 Release의 자산 세 개와 크기를 확인한다(`gh release view v<판> --repo Soochol/vallythevally --json assets`).
4. 공개한다. 이 순간부터 앱이 새 판을 본다.

   ```sh
   gh release edit v<판> --repo Soochol/vallythevally --draft=false
   ```

5. 공개 주소로 갱신 목록이 새 판을 가리키는지 본다: `curl -sL https://github.com/Soochol/vallythevally/releases/latest/download/latest.json`.
6. 이전 판이 깔린 Windows PC에서 앱을 켜고 알림이 뜨는지, 설치 뒤 새 판으로 다시 열리는지 본다.

`latest`는 사전 릴리스(pre-release)와 초안을 건너뛴다. 먼저 일부에게만 시험하려면 사전 릴리스로 올리고 갱신 목록 주소를 그 자산의 직접 주소로 둔 시험용 빌드를 쓴다.

## 되돌리기 (문제 판을 내릴 때)

앱은 목록의 판이 지금 판보다 높을 때만 갱신한다. 그래서 이미 문제 판을 받은 사용자를 이전 판으로 되돌리는 길은 없다. 되돌리기는 두 층이다.

1. **아직 받지 않은 사용자를 막는다.** 문제 판 Release를 초안으로 되돌리거나(`gh release edit v<판> --repo Soochol/vallythevally --draft`) 삭제한다. 그러면 `latest`가 그 직전에 공개한 Release를 가리켜 `latest.json`도 직전 판이 된다. 직전 판을 쓰는 앱은 갱신할 것이 없고, 문제 판을 쓰는 앱은 "지금 판 이하"라 아무것도 하지 않는다. 직전 Release의 `latest.json`이 직전 판의 것인지 먼저 본다.
2. **이미 받은 사용자를 고친다.** 문제를 고친 새 판(문제 판보다 높은 번호)을 올린다. 이미 문제 판을 쓰는 앱은 이 판으로 갱신한다. 문제 판 번호를 재사용하지 않는다.

`allowDowngrades`는 켜지 않는다. 켜면 갱신 확인이 "높은 판만"에서 "다른 판이면"으로 바뀌어 옛 판의 올바른 서명으로 되돌려질 수 있고, 서명 검증이 지키는 것이 줄어든다. 설치가 아예 안 되는 판이 나갔다면 사용자가 직접 설치 파일을 내려받아 설치해야 한다.

서명 키가 새거나 잃었을 때의 조치는 위 "업데이트 서명 키"에 있다.

## 시험

| 무엇 | 명령 | 보는 것 |
|---|---|---|
| 서명 검증 (가)·(나)·(다) 등 | `cd desktop/src-tauri && cargo test --locked updates` | 위 표의 시험. 시험마다 임시 키 쌍(메모리에서 만든다)과 루프백 정적 서버를 쓴다. 비밀키는 저장소에도 디스크에도 없다 |
| 릴리스 설정·갱신 목록 도구 | `cd desktop/scripts && python3 -m unittest test_release` | 덧씌우기 내용, 판이 묶이지 않은 서명 거부, 저장소에 비밀키가 없음(`git grep`) |
| 기본 설정 앱은 갱신 확인을 보내지 않음 | `xvfb-run -a desktop/scripts/smoke.sh` | 앱 프로세스 트리의 `connect`가 모두 엔진의 루프백 포트로만 갔다. 연결 한 건도 밖으로 나가지 않았다 |
| 설정이 켜진 앱의 알림·실패 표시 | `xvfb-run -a desktop/scripts/update-smoke.sh` | 갱신 설정을 심은 앱을 따로 빌드(`target/update-smoke`)해 루프백 정적 서버를 부른다. 새 판 알림과 확인 실패 표시를 창 제목으로 본다 |

`cargo test`는 앱 전체를 띄우지 않고 목 런타임에서 실제 업데이트 플러그인 경로(설정 읽기, 확인, 내려받기, 서명 검증)를 돈다. 갱신본을 실제로 설치하는 단계는 시험에서 돌리지 않는다. 시험 실행 파일이 덮어써지기 때문이다.

## 이 PC에서 확인한 것과 확인하지 못한 것

확인했다(Linux 개발 PC, 2026-11-23):

- 위 시험 전부와 기본 설정 앱의 무음 단정.
- `release.py config`가 만든 덧씌우기로 `pnpm tauri build --bundles appimage`(릴리스 프로필)가 끝까지 돌아 AppImage와 `.sig`가 나왔다. 서명의 신뢰된 주석에 `version:<판>`이 들어 있어서 `requireSignedVersion`과 맞는다. 이 빌드가 한 가지를 잡았다. `plugins` 설정이 있으면 `generate_context!`가 `serde_json`을 쓰므로 앱 크레이트가 `serde_json`을 일반 의존성으로 가진다.
- 설정이 켜진 앱의 알림 창과 확인 실패 표시는 `update-smoke.sh`로 확인한다(위 표).

확인하지 못했다. 첫 릴리스 전에 Windows PC에서 확인한다.

- Windows에서 서버 엔진(`vally-server.exe`)과 앱의 릴리스 빌드, NSIS 설치 파일 만들기.
- Windows NSIS 설치가 실행 중인 앱을 닫고 새 판으로 다시 여는 흐름. 엔진을 먼저 멈추는 순서가 설치 프로그램과 부딪치지 않는지.
- 한 판에서 다음 판으로 실제 설치와 재시작. Linux/macOS의 다시 시작은 `tauri-plugin-single-instance`와 함께 쓸 때 옛 프로세스가 아직 살아 있는 동안 새 프로세스가 뜨는 경쟁이 있을 수 있다. 첫 릴리스 전에 두 판 사이 갱신으로 본다.
- 코드 서명 명령과 macOS 공증.
