# Account login (landing to the account server and back)

## Sub-features
- Landing (`web/src/features/landing/`) shown while the connector is `signed_out`, the top-bar login button, the login dialog.
- Connector `POST /api/account/login`, account server `/v1/auth/{provider}/start` and `/callback`, the IdP stand-in, connector `/auth/complete`, the connector state file (`VALLY_ACCOUNT_STATE_PATH`), logout and token revocation.
- All of it runs as real processes: the connector (`vally-server`), `vally-account`, and `vally-fake-idp` (the VERIFICATION-ONLY IdP of `crates/account-server/src/fake_idp.rs`, which redirects straight back with a code and never shows a page). Google, Naver and Kiwoom are never called.

## Start it
```sh
python3 scripts/dev.py build                                          # connector
python3 scripts/dev.py cargo build -p account-server --all-targets    # target/debug/vally-account and vally-fake-idp
python3 .claude/skills/verify-vally/scripts/build_ui.py target/verify-vally/ui
python3 .claude/skills/verify-vally/scripts/vv.py up --account
```
`--all-targets` is what makes `vally-fake-idp` appear: its `[[bin]]` has `required-features = ["fake-idp"]`, and the crate's self dev-dependency turns that feature on only for test-like targets. A plain `cargo build -p account-server` builds `vally-account` only. `dev.py cargo` refuses `--features`, so use `--all-targets`.

`up --account` also starts the loopback Kiwoom stand-in and connects the connector to it, as in local-only mode. The printed state adds `mode`, `account_url`, `idp_url`, `account_db_path`, `account_state_path`, `idp_pid`, `account_pid`. The account DB is `account-data/account.db` and the connector state file `account-state/account.json`, both inside the run folder. Client ids and secrets are `FAKE-` values.

## Journey `account-login` (`drive.mjs <base_url> <evidence> account-login`)
Needs a fresh account-mode run. Steps, each one entry in the evidence JSON `steps`:
1. `goto /`: `data-testid=landing` is visible, no request to `/api/layouts`, `/api/watchlists`, `/api/ui-state` or `/api/setup/*`; the wheel moves the story (`region 스크롤 이야기`) to `data-step="4"`.
2. Top button `로그인` opens `dialog 로그인`; `Google로 로그인` is pressed. Asserted request order: connector `POST /api/account/login`, account `GET /v1/auth/google/start` 302, IdP `GET /google/authorize` 302, account `GET /v1/auth/google/callback` 302, connector `GET /auth/complete` 302. Then `/api/account` is `signed_in`, provider `google`, and the `처음 설정` dialog is open.
3. The state file mode is 600 and its folder 700 (the connector creates the folder). The token is read in memory only; the account DB (`connector_tokens`, `sha256(token)`) holds exactly one row for it. The file content is never logged, and the run fails if the token text appears in the evidence.
4. `닫기` the wizard, `시스템 설정` then tab `계정`, `로그아웃`: the landing returns, `/api/account` is `signed_out`, the state file is gone, the token row is gone from the account DB.
5. `네이버로 로그인` along the same path. The local owner stays the Google account (logout does not clear it, `crates/server/src/account/owner.rs`), so the Naver account differs from the owner: `/api/account` is `owner_mismatch` with provider `naver`, the `main 계정 바꾸기 확인` screen opens, and the Naver token row exists.

Screenshots: `account-login-01-landing.png`, `-02-login-popover.png`, `-03-signed-in-wizard.png`, `-04-landing-after-logout.png`, `-05-owner-mismatch-after-naver.png`. `foreignHosts` allows exactly the connector, the account server and the IdP stand-in (all `127.0.0.1`). Query values of `code`, `state`, `code_challenge`, `nonce`, `token` are replaced by `…` in the recorded requests.

`vv.py doctor` additionally checks: the connector, `vally-account` and `vally-fake-idp` listen only on `127.0.0.1` and hold only loopback connections; the account server and the IdP stand-in env contains no real IdP host (`accounts.google.com`, `googleapis.com`, `nid.naver.com`, `openapi.naver.com`, `kiwoom.com`); the account server has explicit loopback values for its public URL and all five IdP URLs and a `FAKE-` client id; the connector points at this run's account server and a state path inside the run folder.

## Gotchas
- Known app defect (not fixed here, `web/` is out of scope for the task that added this journey): the first-run wizard does not open by itself after a real login. `markLoginStarted()` sets `vv.login-started` in `sessionStorage`, then the page navigates away through a chain of redirects. The old landing document stays alive until the final `/` commits, receives the connector's `signed_in` push over the WebSocket, and `useWizardOpening` consumes the marker (`takeLoginMarker`) there. The returning document finds no marker. The journey records `wizardAutoOpened` in step 2 and, when it is `false`, opens the wizard with the account menu button `셋업 마법사 다시 열기` so the rest of the path is still proven. When the defect is fixed, `wizardAutoOpened` becomes `true` with no change here; make step 2 require it then.
- The journey needs a fresh run: after the first Google login the connector keeps the Google owner, so a second pass in the same run starts at `owner_mismatch` or `signed_in` and fails its precondition. `down` and `up --account` again.
- Node prints an `ExperimentalWarning` for `node:sqlite` on stderr. It is the read-only check of the account DB and is harmless.
- `vv.py all account-login` cannot be mixed with local-only journeys such as `search-chart`: in account mode the connector starts `signed_out` and shows the landing instead of the chart.
- The fake IdP always signs in subject `subject-1` with `person@example.test`. Google and Naver are different identities even so, which is why step 5 is an `owner_mismatch`.
