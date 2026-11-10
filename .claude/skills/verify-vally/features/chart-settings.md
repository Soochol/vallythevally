# Venue, period, theme and their restore

## Sub-features
- Venue (`통합`, `KRX`, `NXT`; NXT is disabled for symbols not traded there) and period (`1분` … `60분`, `일`, `주`, `월`).
- Theme toggle (`테마 바꾸기`) switches `html[data-theme]`.
- Choices autosave (footer `자동 저장됨 HH:MM:SS`) and survive reload and server restart.

## How to get to it (user POV)
Toolbar `차트 도구 막대`: groups `거래소` and `봉 주기`; theme button at the top right. On narrow screens periods become a navigation `봉 주기` of chips.

## Driving it with verify-vally
Click `toolbar "차트 도구 막대"` → `group "거래소"` → button `NXT`, then `group "봉 주기"` → button `주` (`exact: true`). Proof: both buttons have `aria-pressed="true"`, footer shows `자동 저장됨`, cell `aria-label` names the venue and period, and all of it holds after `page.reload()`. Worked paths: `web/e2e/restore.spec.ts`, `venue-period.spec.ts`, `theme-held-frame.spec.ts`.

## Gotchas
- Server restart inside one run is not offered by `run.sh` yet (the e2e harness has `app.restart()`); restart-survival needs a second run against the same data dir, which `run.sh` does not keep. Prove reload-survival here and leave restart to `web/e2e/restore.spec.ts`.
- `주` needs `exact: true`; other buttons contain the same character.
