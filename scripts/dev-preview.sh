#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_SOURCE="$ROOT/deploy/systemd/vally-dev.service"

HOST="${VALLY_PREVIEW_HOST:-}"
PREVIEW_DIR="${VALLY_PREVIEW_DIR:-~/apps/vallythevally-dev}"
PREVIEW_PORT="${VALLY_PREVIEW_PORT:-8082}"
PREVIEW_HTTPS_PORT="${VALLY_PREVIEW_HTTPS_PORT:-8443}"
PREVIEW_SERVICE="${VALLY_PREVIEW_SERVICE:-vally-dev.service}"
NODE_BIN="${VALLY_NODE_BIN:-}"
BUILD_JOBS="${VALLY_BUILD_JOBS:-4}"

MODE="deploy"
TAILNET_HOST=""
SYNC_SCREENER=0
SKIP_SERVER=0
SKIP_WEB=0

usage() {
    cat <<'EOF'
사용법: scripts/dev-preview.sh [옵션]

서버 PC의 프리뷰 서비스(vally-dev.service, 기본 127.0.0.1:8082 / HTTPS :8443)를 설정·배포·확인·중지합니다.

모드 (생략 시 현재 작업 트리를 동기화·빌드·재시작):
  --setup                서버 PC 최초 1회 설정 (폴더, host.conf, 유닛, tailscale serve :8443)
  --status               프리뷰 서비스 상태, tailscale serve 상태, /api/system/kiwoom 확인
  --stop                 프리뷰 서비스 중지 (실서버는 건드리지 않음)
  --help, -h             도움말 출력

옵션:
  --host <user@host>     대상 서버 PC SSH 주소 (또는 VALLY_PREVIEW_HOST 환경 변수)
  --tailnet-host <name>  --setup 시 사용할 MagicDNS 이름 (생략 시 서버 PC의 tailscale status --json 사용)
  --sync-screener        서버 PC의 실서버 screener.duckdb를 프리뷰 폴더로 강제 원자적 복사
  --skip-server          원격 cargo release 빌드 생략
  --skip-web             원격 pnpm install/build 생략

환경 변수:
  VALLY_PREVIEW_HOST        대상 서버 PC SSH 주소
  VALLY_PREVIEW_DIR         원격 작업 경로 (기본 ~/apps/vallythevally-dev)
  VALLY_PREVIEW_PORT        원격 루프백 HTTP 포트 (기본 8082, 8080 금지)
  VALLY_PREVIEW_HTTPS_PORT  Tailscale Serve HTTPS 포트 (기본 8443, 443 금지)
  VALLY_PREVIEW_SERVICE     systemd 사용자 서비스 이름 (기본 vally-dev.service, vally-server.service 금지)
  VALLY_NODE_BIN            원격 Node/pnpm bin 경로 (생략 시 fnm 최신 버전 또는 PATH 자동 탐색)
  VALLY_BUILD_JOBS          원격 Cargo 빌드 작업 수 (기본 4)
EOF
}

fail_usage() {
    printf 'dev-preview: %s\n' "$1" >&2
    exit 2
}

set_mode() {
    if [ "$MODE" != "deploy" ] && [ "$MODE" != "$1" ]; then
        fail_usage "모드 옵션(--setup, --status, --stop)은 하나만 지정하세요"
    fi
    MODE="$1"
}

validate_port() {
    local value="$1"
    local name="$2"
    if [[ ! "$value" =~ ^[0-9]+$ ]] || [ "$value" -lt 1 ] || [ "$value" -gt 65535 ]; then
        fail_usage "${name}는 1~65535 정수여야 합니다: ${value}"
    fi
}

while [ $# -gt 0 ]; do
    case "$1" in
        --help|-h)
            usage
            exit 0
            ;;
        --setup)
            set_mode setup
            shift
            ;;
        --status)
            set_mode status
            shift
            ;;
        --stop)
            set_mode stop
            shift
            ;;
        --sync-screener)
            SYNC_SCREENER=1
            shift
            ;;
        --skip-server)
            SKIP_SERVER=1
            shift
            ;;
        --skip-web)
            SKIP_WEB=1
            shift
            ;;
        --host)
            [ $# -ge 2 ] || fail_usage "--host 뒤에 값을 지정하세요"
            HOST="$2"
            shift 2
            ;;
        --host=*)
            HOST="${1#--host=}"
            shift
            ;;
        --tailnet-host)
            [ $# -ge 2 ] || fail_usage "--tailnet-host 뒤에 값을 지정하세요"
            TAILNET_HOST="$2"
            shift 2
            ;;
        --tailnet-host=*)
            TAILNET_HOST="${1#--tailnet-host=}"
            shift
            ;;
        *)
            fail_usage "알 수 없는 옵션입니다: $1"
            ;;
    esac
done

if [ -z "$HOST" ]; then
    fail_usage "--host <user@host> 또는 VALLY_PREVIEW_HOST 환경 변수를 지정하세요"
fi

if [[ "$HOST" == -* ]] || [[ "$HOST" =~ [[:space:]] ]]; then
    fail_usage "올바른 SSH 호스트 형식이 아닙니다: ${HOST}"
fi

if [ "$PREVIEW_SERVICE" = "vally-server.service" ] || [ "$PREVIEW_SERVICE" = "vally-server" ]; then
    fail_usage "실서버 서비스(${PREVIEW_SERVICE})는 프리뷰 스크립트로 조작할 수 없습니다"
fi

validate_port "$PREVIEW_PORT" "VALLY_PREVIEW_PORT"
validate_port "$PREVIEW_HTTPS_PORT" "VALLY_PREVIEW_HTTPS_PORT"

if [ "$PREVIEW_PORT" = "8080" ]; then
    fail_usage "실서버 포트(8080)는 프리뷰 포트로 사용할 수 없습니다"
fi

if [ "$PREVIEW_HTTPS_PORT" = "443" ]; then
    fail_usage "실서버 HTTPS 포트(443)는 프리뷰 포트로 사용할 수 없습니다"
fi

if [[ "$PREVIEW_DIR" == '~/'* ]]; then
    RSYNC_DEST="${PREVIEW_DIR#'~/'}"
else
    RSYNC_DEST="$PREVIEW_DIR"
fi

run_stop() {
    ssh -o BatchMode=yes "$HOST" "systemctl --user stop $(printf '%q' "$PREVIEW_SERVICE")"
}

run_status() {
    ssh -o BatchMode=yes "$HOST" bash -s -- "$PREVIEW_SERVICE" "$PREVIEW_PORT" <<'EOF'
set -euo pipefail
service="$1"
port="$2"
printf 'service(%s): ' "$service"
systemctl --user is-active "$service" || true
printf '\ntailscale serve status:\n'
tailscale serve status || true
printf '\nkiwoom status:\n'
curl -fsS "http://127.0.0.1:${port}/api/system/kiwoom" || true
printf '\n'
EOF
}

run_setup() {
    if [ ! -f "$UNIT_SOURCE" ]; then
        printf 'dev-preview: 유닛 템플릿이 없습니다: %s\n' "$UNIT_SOURCE" >&2
        exit 1
    fi
    local unit_b64
    unit_b64="$(base64 < "$UNIT_SOURCE" | tr -d '\n')"
    ssh -o BatchMode=yes "$HOST" bash -s -- "$PREVIEW_DIR" "$PREVIEW_SERVICE" "$PREVIEW_PORT" "$PREVIEW_HTTPS_PORT" "$TAILNET_HOST" "$unit_b64" <<'EOF'
set -euo pipefail
raw_dir="$1"
service="$2"
port="$3"
https_port="$4"
given_host="$5"
unit_b64="$6"

case "$raw_dir" in
    "~/"*) preview_dir="$HOME/${raw_dir#"~/"}" ;;
    *) preview_dir="$raw_dir" ;;
esac

unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
dropin_dir="${unit_dir}/${service}.d"

mkdir -p "$preview_dir" "$HOME/vally-data/dev" "$HOME/.local/state/vallythevally/dev" "$dropin_dir"

if [ -n "$given_host" ]; then
    dns_name="${given_host%.}"
else
    dns_name="$(tailscale status --json | python3 -c 'import json, sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
fi

if [ -z "$dns_name" ]; then
    printf 'dev-preview setup: MagicDNS 이름을 확인하지 못했습니다\n' >&2
    exit 1
fi

case "$dns_name" in
    *:*) host_entry="$dns_name" ;;
    *) host_entry="${dns_name}:${https_port}" ;;
esac

host_conf="${dropin_dir}/host.conf"
tmp_conf="$(mktemp "${dropin_dir}/.host.conf.XXXXXX")"
printf '[Service]\nEnvironment=VALLY_TAILNET_HOSTS=%s\n' "$host_entry" > "$tmp_conf"
chmod 644 "$tmp_conf"
mv -f "$tmp_conf" "$host_conf"

unit_target="${unit_dir}/${service}"
tmp_unit="$(mktemp "${unit_dir}/.${service}.XXXXXX")"
printf '%s' "$unit_b64" | base64 -d > "$tmp_unit"
chmod 644 "$tmp_unit"
if [ ! -f "$unit_target" ] || ! cmp -s "$tmp_unit" "$unit_target"; then
    mv -f "$tmp_unit" "$unit_target"
else
    rm -f "$tmp_unit"
fi

systemctl --user daemon-reload
tailscale serve --bg --https="$https_port" "http://127.0.0.1:${port}"
printf 'dev-preview setup 완료: https://%s -> http://127.0.0.1:%s\n' "$host_entry" "$port"
EOF
}

run_deploy() {
    rsync -az --delete \
        --exclude=.git \
        --exclude=target \
        --exclude=node_modules \
        --exclude=web/dist \
        --exclude=web/pkg \
        --exclude=web/test-results \
        --exclude=web/playwright-report \
        --exclude=.env \
        --exclude=.env.* \
        --exclude=*.db \
        --exclude=*.db-* \
        --exclude=proposal-*.html \
        --exclude=.audit \
        --exclude=data \
        "${ROOT}/" "${HOST}:${RSYNC_DEST}/"

    ssh -o BatchMode=yes "$HOST" bash -s -- "$PREVIEW_DIR" "$PREVIEW_SERVICE" "$PREVIEW_PORT" "$SYNC_SCREENER" "$SKIP_SERVER" "$SKIP_WEB" "$NODE_BIN" "$BUILD_JOBS" <<'EOF'
set -euo pipefail
raw_dir="$1"
service="$2"
port="$3"
sync_screener="$4"
skip_server="$5"
skip_web="$6"
node_bin="$7"
build_jobs="$8"

case "$raw_dir" in
    "~/"*) preview_dir="$HOME/${raw_dir#"~/"}" ;;
    *) preview_dir="$raw_dir" ;;
esac

mkdir -p "$HOME/vally-data/dev" "$HOME/.local/state/vallythevally/dev"

prod_screener="$HOME/vally-data/server/screener.duckdb"
dev_screener="$HOME/vally-data/dev/screener.duckdb"
if [ "$sync_screener" = "1" ] || [ ! -f "$dev_screener" ]; then
    if [ -f "$prod_screener" ]; then
        tmp_screener="$(mktemp "$HOME/vally-data/dev/.screener.duckdb.tmp.XXXXXX")"
        if cp "$prod_screener" "$tmp_screener" && mv -f "$tmp_screener" "$dev_screener"; then
            printf 'dev-preview: screener.duckdb 복사 완료\n'
        else
            rm -f "$tmp_screener"
            exit 1
        fi
    fi
fi

if [ "$skip_server" != "1" ]; then
    export PATH="$HOME/.cargo/bin:$PATH"
    (cd "$preview_dir" && CARGO_BUILD_JOBS="$build_jobs" cargo build --locked --release -p server)
fi

if [ "$skip_web" != "1" ]; then
    if [ -n "$node_bin" ]; then
        export PATH="${node_bin}:$PATH"
    else
        detected_node_bin="$(find "$HOME/.local/share/fnm/node-versions" -maxdepth 3 -path '*/installation/bin' -type d 2>/dev/null | sort -V | tail -n 1 || true)"
        if [ -n "$detected_node_bin" ]; then
            export PATH="${detected_node_bin}:$PATH"
        fi
    fi
    (cd "$preview_dir/web" && pnpm install --frozen-lockfile && pnpm build)
fi

unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
unit_source="$preview_dir/deploy/systemd/vally-dev.service"
unit_target="${unit_dir}/${service}"
mkdir -p "$unit_dir"
if [ -f "$unit_source" ]; then
    if [ ! -f "$unit_target" ] || ! cmp -s "$unit_source" "$unit_target"; then
        tmp_unit="$(mktemp "${unit_dir}/.${service}.part.XXXXXX")"
        if cp "$unit_source" "$tmp_unit" && chmod 644 "$tmp_unit" && mv -f "$tmp_unit" "$unit_target"; then
            systemctl --user daemon-reload
        else
            rm -f "$tmp_unit"
            exit 1
        fi
    fi
fi

systemctl --user restart "$service"

ready=0
for _ in $(seq 1 30); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/api/screener/status" || true)"
    if [ "$code" = "200" ]; then
        ready=1
        break
    fi
    sleep 1
done

if [ "$ready" != "1" ]; then
    printf 'dev-preview: http://127.0.0.1:%s/api/screener/status 준비 실패\n' "$port" >&2
    exit 1
fi

kiwoom_json="$(curl -fsS "http://127.0.0.1:${port}/api/system/kiwoom")"
if ! printf '%s' "$kiwoom_json" | grep -Eq '"environment"[[:space:]]*:[[:space:]]*"mock"'; then
    systemctl --user stop "$service" || true
    printf 'dev-preview: 투자구분이 mock이 아닙니다. 서비스를 중지했습니다: %s\n' "$kiwoom_json" >&2
    exit 1
fi

printf 'dev-preview: 배포 및 모의 투자구분 확인 완료 (127.0.0.1:%s)\n' "$port"
EOF
}

case "$MODE" in
    stop) run_stop ;;
    status) run_status ;;
    setup) run_setup ;;
    deploy) run_deploy ;;
esac
