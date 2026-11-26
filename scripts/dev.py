#!/usr/bin/env python3
import argparse
import contextlib
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import tomllib
import urllib.error
import urllib.request

import evidence


BINARIES = ("vally-server", "dart-smoke")
BUILD_ENV_PREFIXES = ("CARGO_", "RUST", "CC", "CXX", "AR", "CFLAGS", "CPPFLAGS", "LDFLAGS", "SDKROOT", "MACOSX_")
LOCAL_BUILD_ENV = {"CARGO_TARGET_DIR", "CARGO_BUILD_JOBS", "CCACHE_DIR", "CCACHE_BASEDIR"}
DEFAULT_DEV_PORT = 8082
DEFAULT_VITE_PORT = 5173
SAMPLE_HOGA_SUBPATHS = (
    "store",
    "shared/quote-minutes",
    "shared/quote-minutes-live",
    "shared/minute",
    "shared/trade-minute",
    "shared/symbol-flow",
)


def output(args, root):
    return subprocess.check_output(args, cwd=root, text=True).strip()


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def say(message):
    print(f"dev-build: {message}", flush=True)


@contextlib.contextmanager
def locked(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        yield


def remove(path):
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.exists():
        shutil.rmtree(path)


def install(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=f".{destination.name}-", dir=destination.parent)
    os.close(descriptor)
    staged = Path(name)
    try:
        shutil.copy2(source, staged)
        staged.replace(destination)
    finally:
        staged.unlink(missing_ok=True)


def cache_root(root):
    configured = os.environ.get("VALLY_DEV_CACHE_DIR")
    if configured:
        location = Path(configured).expanduser()
        if not location.is_absolute():
            raise ValueError("VALLY_DEV_CACHE_DIR에는 절대 경로를 지정하세요")
        return location.resolve()
    worktrees = subprocess.check_output(["git", "worktree", "list", "--porcelain", "-z"], cwd=root)
    primary = next(field[9:] for field in worktrees.decode().split("\0") if field.startswith("worktree "))
    return Path(primary) / "target" / "dev-cache"


def toolchain(root):
    rust = output(["rustc", "-vV"], root)
    host = next(line.removeprefix("host: ") for line in rust.splitlines() if line.startswith("host: "))
    compilers = {name: output([*shlex.split(os.environ.get(name, compiler)), "--version"], root) for name, compiler in (("CC", "cc"), ("CXX", "c++"))}
    return {"host": host, "rustc": rust, "cargo": output(["cargo", "-vV"], root), "compilers": compilers, "libc": platform.libc_ver()}


def load_pin(root):
    pin = json.loads((root / "scripts/duckdb-prebuilt.json").read_text())
    packages = tomllib.loads((root / "Cargo.lock").read_text())["package"]
    for name in ("duckdb", "libduckdb-sys"):
        versions = [package["version"] for package in packages if package["name"] == name]
        if versions != [pin["crate_version"]]:
            raise ValueError(f"{name} 버전과 scripts/duckdb-prebuilt.json을 함께 갱신하세요: {versions}")
    return pin


def source_files(directory):
    for base, directories, files in os.walk(directory):
        if Path(base).parent == directory:
            directories[:] = [name for name in directories if name != "target"]
        for name in files:
            path = Path(base) / name
            if path.is_file():
                yield path


def cargo_configs(root, environment):
    cargo_home = Path(environment.get("CARGO_HOME", Path.home() / ".cargo")).expanduser().resolve()
    paths = {parent / ".cargo" / name for parent in (root, *root.parents) for name in ("config", "config.toml")}
    paths.update(cargo_home / name for name in ("config", "config.toml"))
    return sorted(path for path in paths if path.is_file())


def require_default_target(root, environment):
    if environment.get("CARGO_BUILD_TARGET"):
        raise ValueError("개발 캐시는 기본 호스트 출력 경로를 사용합니다. CARGO_BUILD_TARGET을 해제하세요")
    for path in cargo_configs(root, environment):
        config = tomllib.loads(path.read_text())
        if "target" in config.get("build", {}) or "CARGO_BUILD_TARGET" in config.get("env", {}):
            raise ValueError(f"개발 캐시는 사용자 target 설정을 지원하지 않습니다: {path}")


def fingerprint(root, tools, bundled, environment, binaries=BINARIES):
    inputs = [root / "Cargo.toml", root / "Cargo.lock", root / "scripts/dev.py", root / "scripts/duckdb-prebuilt.json"]
    inputs.extend(path for name in ("rust-toolchain", "rust-toolchain.toml") if (path := root / name).is_file())
    inputs.extend(path for directory in (root / "crates", root / ".cargo") for path in source_files(directory))
    key = hashlib.sha256()
    for path in sorted(inputs):
        key.update(path.relative_to(root).as_posix().encode() + b"\0")
        key.update(bytes.fromhex(digest(path)))
    for path in cargo_configs(root, environment):
        if path.parent != root / ".cargo":
            key.update(str(path).encode() + b"\0" + bytes.fromhex(digest(path)))
    build_env = {name: value for name, value in environment.items() if name.startswith(BUILD_ENV_PREFIXES) and name not in LOCAL_BUILD_ENV}
    key.update(json.dumps({"format": 1, "tools": tools, "bundled": bundled, "binaries": binaries, "environment": build_env}, sort_keys=True).encode())
    return key.hexdigest()


def verify_engine(path, version):
    library = ctypes.CDLL(str(path))
    library.duckdb_library_version.restype = ctypes.c_char_p
    actual = library.duckdb_library_version().decode()
    if actual != version:
        raise ValueError(f"DuckDB 엔진 버전 불일치: {actual}, 필요: {version}")


def library_entry(cache, artifact):
    return cache / "duckdb" / artifact["library_sha256"]


def valid_library(entry, artifact):
    library = entry / artifact["library"]
    return library.is_file() and digest(library) == artifact["library_sha256"]


def prepare_duckdb(cache, pin, host):
    artifact = pin["artifacts"].get(host)
    if artifact is None:
        raise ValueError(f"사전 빌드 DuckDB가 등록되지 않은 호스트: {host}. --bundled를 사용하세요.")
    entry = library_entry(cache, artifact)
    with locked(cache / "locks" / f"duckdb-{artifact['library_sha256']}.lock"):
        if valid_library(entry, artifact):
            verify_engine(entry / artifact["library"], pin["engine_version"])
            say(f"DuckDB 재사용: {entry}")
            return entry
        entry.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".duckdb-", dir=entry.parent) as temporary:
            staged = Path(temporary)
            archive = staged / "archive.tar.gz"
            say(f"DuckDB 내려받기: {artifact['url']}")
            request = urllib.request.Request(artifact["url"], headers={"User-Agent": "vallythevally-dev-build/1.0"})
            with urllib.request.urlopen(request, timeout=60) as response, archive.open("wb") as stream:
                shutil.copyfileobj(response, stream)
            if digest(archive) != artifact["archive_sha256"]:
                raise ValueError("DuckDB 아카이브 SHA-256이 고정값과 다릅니다")
            with tarfile.open(archive) as packed:
                member = packed.getmember(artifact["library"])
                if not member.isfile():
                    raise ValueError("DuckDB 라이브러리는 일반 파일이어야 합니다")
                with packed.extractfile(member) as source, (staged / artifact["library"]).open("wb") as destination:
                    shutil.copyfileobj(source, destination)
            if not valid_library(staged, artifact):
                raise ValueError("DuckDB 라이브러리 SHA-256이 고정값과 다릅니다")
            verify_engine(staged / artifact["library"], pin["engine_version"])
            archive.unlink()
            remove(entry)
            staged.replace(entry)
        return entry


def lld_link_flags(root):
    try:
        sysroot = Path(output(["rustc", "--print", "sysroot"], root))
        host_line = next(line for line in output(["rustc", "-vV"], root).splitlines() if line.startswith("host: "))
        host = host_line.removeprefix("host: ")
        gcc_ld = sysroot / "lib/rustlib" / host / "bin/gcc-ld"
        if (gcc_ld / "ld.lld").is_file():
            return f"-C link-arg=-B{gcc_ld} -C link-arg=-fuse-ld=lld"
    except (OSError, StopIteration, subprocess.CalledProcessError):
        pass
    return ""


def build_jobs_for(environment):
    cpus = os.cpu_count() or 4
    limit = 12 if environment.get(COMPILE_LANE_ENV) == "gate" else 8
    return str(max(4, min(cpus, limit)))


def build_environment(root, cache, library):
    environment = os.environ.copy()
    environment["CARGO_TARGET_DIR"] = str(root / "target")
    environment["CARGO_BUILD_JOBS"] = build_jobs_for(environment)
    temporary = root / "target" / "tmp"
    temporary.mkdir(parents=True, exist_ok=True)
    environment["TMPDIR"] = str(temporary.resolve())
    if lld := lld_link_flags(root):
        existing = environment.get("RUSTFLAGS", "").strip()
        environment["RUSTFLAGS"] = f"{existing} {lld}".strip()
    if library is not None:
        environment["DUCKDB_LIB_DIR"] = str(library)
        environment["DUCKDB_DOWNLOAD_LIB"] = "0"
        environment.pop("DUCKDB_STATIC", None)
        install(library / "libduckdb.so", root / "target/debug/libduckdb.so")
    if shutil.which("ccache"):
        for name, compiler in (("CC", "cc"), ("CXX", "c++")):
            command = environment.get(name, compiler)
            if "ccache" not in command.split():
                environment[name] = f"ccache {command}"
        environment["CCACHE_DIR"] = str(cache / "ccache")
        environment["CCACHE_BASEDIR"] = str(root)
    return environment


def cargo_command(arguments, bundled):
    allowed = ("build", "check", "clippy", "test")
    if not arguments or arguments[0] not in allowed:
        raise ValueError("cargo 명령은 build, check, clippy, test를 지원합니다")
    head, separator, tail = arguments, [], []
    if "--" in arguments:
        at = arguments.index("--")
        head, separator, tail = arguments[:at], ["--"], arguments[at + 1:]
    if any(arg in ("--release", "-r") or arg.startswith(("-F", "--profile", "--target", "--features", "--all-features", "--manifest-path", "--target-dir", "--config")) for arg in head):
        raise ValueError("개발 명령은 기본 dev 프로필·현재 workspace·호스트 target을 사용합니다")
    if "--locked" not in head:
        head = [*head, "--locked"]
    if not bundled and "--no-default-features" not in head:
        head = [*head, "--no-default-features"]
    return ["cargo", *head, *separator, *tail]


def needs_duckdb(command):
    head = command[:command.index("--")] if "--" in command else command
    packages = []
    for index, arg in enumerate(head):
        if arg in ("-p", "--package") and index + 1 < len(head):
            packages.append(head[index + 1])
        elif arg.startswith("--package="):
            packages.append(arg.removeprefix("--package="))
    return "--workspace" in head or not packages or any(name not in ("domain", "indicators", "indicators-wasm", "account-server", "setup") for name in packages)


COMPILE_LANE_ENV = "VALLY_COMPILE_LANE"
COMPILE_LOCKS = {"": "compile.lock", "gate": "compile-gate.lock"}


def compile_lock_path(root):
    lane = os.environ.get(COMPILE_LANE_ENV, "")
    if lane not in COMPILE_LOCKS:
        raise ValueError(f"{COMPILE_LANE_ENV}는 비우거나 gate여야 합니다: {lane}")
    common = output(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], root)
    return Path(common) / COMPILE_LOCKS[lane]


def compile_command(root, command, environment):
    lock = compile_lock_path(root)
    say(f"컴파일 잠금({lock.name}) 대기 / Cargo 실행")
    evidence.command(["flock", str(lock), *command], root, environment)


DEFAULT_TEST_THREADS = "8"


def run_cargo(root, command, environment):
    if command[1] == "test" and "--no-run" not in command:
        at = command.index("--") if "--" in command else len(command)
        compile_command(root, [*command[:at], "--no-run", *command[at:]], environment)
        evidence.command(command, root, {"RUST_TEST_THREADS": DEFAULT_TEST_THREADS, **environment})
    else:
        compile_command(root, command, environment)


def valid_binaries(entry, key, binaries=BINARIES):
    try:
        manifest = json.loads((entry / "manifest.json").read_text())
        return manifest["key"] == key and all(
            (entry / name).is_file() and os.access(entry / name, os.X_OK)
            and digest(entry / name) == manifest["binaries"][name]
            for name in binaries
        )
    except (OSError, ValueError, KeyError, TypeError):
        return False


def restore_binaries(entry, destination, binaries=BINARIES):
    for name in binaries:
        install(entry / name, destination / name)


def publish_binaries(source, entry, key, binaries=BINARIES):
    entry.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".binaries-", dir=entry.parent) as temporary:
        staged = Path(temporary)
        restore_binaries(source, staged, binaries)
        hashes = {name: digest(staged / name) for name in binaries}
        (staged / "manifest.json").write_text(json.dumps({"key": key, "binaries": hashes}, sort_keys=True))
        remove(entry)
        staged.replace(entry)


def cached_build(root, cache, key, current_key, build, binaries=BINARIES):
    entry = cache / "binaries" / key
    destination = root / "target/dev/bin"
    with locked(cache / "locks" / f"binaries-{key}.lock"):
        if valid_binaries(entry, key, binaries):
            restore_binaries(entry, destination, binaries)
            if current_key() != key:
                raise ValueError("복원 중 빌드 입력이 바뀌었습니다. 다시 실행하세요")
            say(f"실행 파일 재사용 (Cargo 빌드 생략): {', '.join(binaries)} / {key[:16]}")
            evidence.artifact("server", destination, "reused", key, files=binaries)
            return
        say(f"새 빌드 입력: {key[:16]}")
        build()
        if current_key() != key:
            raise ValueError("컴파일 중 빌드 입력이 바뀌어 공유 캐시에 게시하지 않았습니다. 다시 실행하세요")
        publish_binaries(root / "target/debug", entry, key, binaries)
        restore_binaries(entry, destination, binaries)
        say(f"실행 파일 캐시 저장: {key[:16]}")
        evidence.artifact("server", destination, "direct", key, files=binaries)


def validate_port(port, name="port"):
    if isinstance(port, bool) or not isinstance(port, int) or not (1 <= port <= 65535):
        raise ValueError(f"{name}는 1~65535 정수여야 합니다: {port}")
    return port


def validate_remote_token(value, name):
    if not isinstance(value, str) or not value or value.startswith("-") or any(character.isspace() for character in value):
        raise ValueError(f"{name} 값이 올바르지 않습니다: {value!r}")
    return value


def dev_server_environment(
    root,
    base_env,
    *,
    port=DEFAULT_DEV_PORT,
    data_dir=None,
    state_dir=None,
    runtime_dir=None,
    hoga_dir=None,
    shared_dir=None,
    financial_db=None,
    tailnet_hosts=None,
    static_dir=None,
):
    validate_port(port, "port")
    root_path = Path(root).expanduser().resolve()
    home_path = Path(base_env["HOME"]).expanduser() if base_env.get("HOME") else Path.home()
    resolved_data = Path(data_dir).expanduser().resolve() if data_dir is not None else (home_path / "vally-data" / "dev-local").resolve()
    if state_dir is not None:
        resolved_state = Path(state_dir).expanduser().resolve()
    elif base_env.get("XDG_STATE_HOME"):
        resolved_state = Path(base_env["XDG_STATE_HOME"]).expanduser().resolve()
    else:
        resolved_state = (home_path / ".local" / "state").resolve()
    if runtime_dir is not None:
        resolved_runtime = Path(runtime_dir).expanduser().resolve()
    elif base_env.get("XDG_RUNTIME_DIR"):
        resolved_runtime = Path(base_env["XDG_RUNTIME_DIR"]).expanduser().resolve()
    else:
        resolved_runtime = Path(f"/tmp/vallythevally-{os.getuid()}")
    resolved_static = Path(static_dir).expanduser().resolve() if static_dir is not None else (root_path / "web" / "dist").resolve()

    environment = {
        key: value
        for key, value in base_env.items()
        if not key.startswith("VALLY_") and key != "OPENDART_API_KEY"
    }
    environment.update(
        {
            "VALLY_KIWOOM_ENV": "mock",
            "VALLY_BIND": f"127.0.0.1:{port}",
            "VALLY_SCREENER_UPDATE_ON_START": "off",
            "VALLY_DB_PATH": str(resolved_data / "vally.db"),
            "VALLY_SCREENER_DB_PATH": str(resolved_data / "screener.duckdb"),
            "VALLY_LOCK_PATH": str(resolved_runtime / "vallythevally" / "dev-local" / "server.lock"),
            "VALLY_TOKEN_PATH": str(resolved_state / "vallythevally" / "dev-local" / "token.json"),
            "VALLY_KIWOOM_KEY_PATH": str(resolved_state / "vallythevally" / "dev-local" / "kiwoom-key.json"),
            "VALLY_STATIC_DIR": str(resolved_static),
        }
    )

    duckdb_library = root_path / "target" / "dev" / "bin" / "libduckdb.so"
    if duckdb_library.is_file():
        library_dir = str(duckdb_library.parent)
        existing_ld = environment.get("LD_LIBRARY_PATH", "")
        environment["LD_LIBRARY_PATH"] = f"{library_dir}:{existing_ld}" if existing_ld else library_dir

    effective_hoga = Path(hoga_dir).expanduser().resolve() if hoga_dir is not None else (resolved_data / "hoga" if (resolved_data / "hoga").is_dir() else None)
    if effective_hoga is not None:
        environment["VALLY_HOGA_DATA_DIR"] = str(effective_hoga)

    effective_shared = (
        Path(shared_dir).expanduser().resolve()
        if shared_dir is not None
        else (effective_hoga / "shared" if effective_hoga is not None and (effective_hoga / "shared").is_dir() else None)
    )
    if effective_shared is not None:
        environment["VALLY_SHARED_DATA_DIR"] = str(effective_shared)

    effective_financial = Path(financial_db).expanduser().resolve() if financial_db is not None else (resolved_data / "financials.db" if (resolved_data / "financials.db").is_file() else None)
    if effective_financial is not None:
        environment["VALLY_FINANCIAL_DB_PATH"] = str(effective_financial)

    if tailnet_hosts is not None and tailnet_hosts.strip():
        environment["VALLY_TAILNET_HOSTS"] = tailnet_hosts.strip()

    return environment


def select_recent_dates(raw_names, days):
    if isinstance(days, bool) or not isinstance(days, int) or not (1 <= days <= 5):
        raise ValueError(f"days는 1~5 정수여야 합니다: {days}")
    valid = sorted({name.strip() for name in raw_names if re.fullmatch(r"\d{8}", name.strip())})
    return valid[-days:]


def fetch_remote_hoga_dates(host, remote_data_dir="vally-data"):
    validate_remote_token(host, "host")
    clean_remote = validate_remote_token(remote_data_dir.strip("/"), "remote_data_dir")
    remote_cmd = f'ls -1 "$HOME"/{shlex.quote(clean_remote)}/hoga/store'
    raw = subprocess.check_output(["ssh", "-o", "BatchMode=yes", host, remote_cmd], text=True)
    return raw.splitlines()


def sync_sample_plan(host, data_dir, *, days=1, remote_data_dir="vally-data", dates=None):
    validate_remote_token(host, "host")
    if isinstance(days, bool) or not isinstance(days, int) or not (1 <= days <= 5):
        raise ValueError(f"days는 1~5 정수여야 합니다: {days}")
    clean_remote = validate_remote_token(remote_data_dir.strip("/"), "remote_data_dir")
    resolved_data = Path(data_dir).expanduser().resolve()
    resolved_dates = select_recent_dates(dates if dates is not None else fetch_remote_hoga_dates(host, clean_remote), days)
    commands = [
        ["rsync", "-a", f"{host}:{clean_remote}/server/screener.duckdb", str(resolved_data / "screener.duckdb")],
    ]
    for date in resolved_dates:
        for subpath in SAMPLE_HOGA_SUBPATHS:
            commands.append(
                [
                    "rsync",
                    "-a",
                    "--ignore-missing-args",
                    f"{host}:{clean_remote}/hoga/{subpath}/{date}/",
                    f"{resolved_data / 'hoga' / subpath / date}/",
                ]
            )
    return commands


def wait_for_server_ready(url, process, timeout=30.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise ValueError(f"vally-server가 준비 전에 종료했습니다 (exit={process.returncode})")
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                if response.status == 200:
                    return
        except (urllib.error.URLError, OSError):
            pass
        time.sleep(0.2)
    raise TimeoutError(f"vally-server 준비 대기 시간 초과 ({timeout:.0f}초): {url}")


def run_serve(root, args):
    validate_port(args.port, "--port")
    if not args.backend_only:
        validate_port(args.vite_port, "--vite-port")
    if not args.no_build:
        execute(root, argparse.Namespace(action="build", bin="vally-server", bundled=args.bundled))
    binary = root / "target" / "dev" / "bin" / "vally-server"
    if not binary.is_file():
        raise FileNotFoundError(f"실행 파일이 없습니다: {binary}")
    server_env = dev_server_environment(
        root,
        os.environ,
        port=args.port,
        data_dir=args.data_dir,
        hoga_dir=args.hoga_dir,
        shared_dir=args.shared_dir,
        financial_db=args.financial_db,
        tailnet_hosts=args.tailnet_host,
    )
    for key in ("VALLY_DB_PATH", "VALLY_LOCK_PATH", "VALLY_TOKEN_PATH", "VALLY_KIWOOM_KEY_PATH"):
        Path(server_env[key]).parent.mkdir(parents=True, exist_ok=True)
    children = []
    try:
        with evidence.interrupts():
            server = subprocess.Popen([str(binary)], cwd=root, env=server_env, start_new_session=True)
            children.append(server)
            wait_for_server_ready(f"http://127.0.0.1:{args.port}/api/screener/status", server, timeout=30.0)
            print(f"Backend: http://127.0.0.1:{args.port}", flush=True)
            if not args.backend_only:
                print(f"Frontend (HMR): http://127.0.0.1:{args.vite_port}", flush=True)
                vite_env = {
                    **os.environ,
                    "VITE_FAKE_API": "0",
                    "VITE_API_TARGET": f"http://127.0.0.1:{args.port}",
                }
                vite = subprocess.Popen(
                    ["pnpm", "--dir", str(root / "web"), "dev", "--port", str(args.vite_port)],
                    cwd=root,
                    env=vite_env,
                    start_new_session=True,
                )
                children.append(vite)
            while True:
                for child in children:
                    code = child.poll()
                    if code is not None:
                        if code != 0:
                            raise subprocess.CalledProcessError(code, child.args)
                        return
                time.sleep(0.2)
    except (KeyboardInterrupt, evidence.Interrupted):
        return
    finally:
        for child in reversed(children):
            evidence.stop_process(child)


def run_sync_sample(args):
    host = args.host or os.environ.get("VALLY_PREVIEW_HOST", "")
    if not host:
        raise ValueError("--host 또는 VALLY_PREVIEW_HOST 환경 변수를 지정하세요")
    data_dir = Path(args.data_dir).expanduser().resolve() if args.data_dir else (Path.home() / "vally-data" / "dev-local").resolve()
    commands = sync_sample_plan(host, data_dir, days=args.days, remote_data_dir=args.remote_data_dir)
    if args.dry_run:
        for command in commands:
            print(shlex.join(command), flush=True)
        return
    for command in commands:
        Path(command[-1]).parent.mkdir(parents=True, exist_ok=True)
        say(shlex.join(command))
        subprocess.run(command, check=True)


def main():
    parser = argparse.ArgumentParser(description="worktree 간 DuckDB·개발 서버 빌드 재사용")
    parser.add_argument("--bundled", action="store_true", help="DuckDB 소스 빌드 사용 (ccache 연결)")
    subparsers = parser.add_subparsers(dest="action", required=True)
    build = subparsers.add_parser("build", help="개발 서버를 준비하고 동일 입력의 실행 파일 재사용")
    status = subparsers.add_parser("status", help="다운로드·컴파일 없이 캐시 상태 출력")
    for command in (build, status):
        command.add_argument("--bin", choices=BINARIES, default="vally-server", help="준비할 실행 파일 (기본 vally-server)")
    cargo = subparsers.add_parser("cargo", help="개발용 DuckDB와 공통 잠금으로 Cargo 검사·시험")
    cargo.add_argument("arguments", nargs=argparse.REMAINDER)
    serve = subparsers.add_parser("serve", help="모의 투자구분 개발 서버와 Vite HMR 실행")
    serve.add_argument("--port", type=int, default=DEFAULT_DEV_PORT, help=f"백엔드 루프백 포트 (기본 {DEFAULT_DEV_PORT})")
    serve.add_argument("--vite-port", type=int, default=DEFAULT_VITE_PORT, help=f"Vite HMR 포트 (기본 {DEFAULT_VITE_PORT})")
    serve.add_argument("--data-dir", type=Path, default=None, help="로컬 개발 데이터 폴더 (기본 ~/vally-data/dev-local)")
    serve.add_argument("--hoga-dir", type=Path, default=None, help="수집 호가 폴더")
    serve.add_argument("--shared-dir", type=Path, default=None, help="공용 자료 폴더")
    serve.add_argument("--financial-db", type=Path, default=None, help="재무자료 SQLite 파일 경로")
    serve.add_argument("--tailnet-host", type=str, default=None, help="VALLY_TAILNET_HOSTS 값")
    serve.add_argument("--backend-only", action="store_true", help="Vite HMR 없이 정적 web/dist만 서빙")
    serve.add_argument("--no-build", action="store_true", help="dev.py build를 건너뛰고 기존 실행 파일 사용")
    sync_sample = subparsers.add_parser("sync-sample", help="서버 PC에서 screener.duckdb와 최근 N일 호가·공용 자료 표본 내려받기")
    sync_sample.add_argument("--host", type=str, default=None, help="서버 PC SSH 주소 (생략 시 VALLY_PREVIEW_HOST)")
    sync_sample.add_argument("--days", type=int, default=1, help="최근 관측일 수 (1~5, 기본 1)")
    sync_sample.add_argument("--data-dir", type=Path, default=None, help="저장할 로컬 데이터 폴더 (기본 ~/vally-data/dev-local)")
    sync_sample.add_argument("--remote-data-dir", type=str, default="vally-data", help="서버 PC 홈 기준 데이터 폴더 (기본 vally-data)")
    sync_sample.add_argument("--dry-run", action="store_true", help="실행하지 않고 계획된 rsync 명령만 출력")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    if args.action == "status":
        execute(root, args)
    elif args.action == "serve":
        run_serve(root, args)
    elif args.action == "sync-sample":
        run_sync_sample(args)
    else:
        with evidence.Run(root, f"dev-{args.action}", sys.argv, os.environ.get("VALLY_EVIDENCE_DIR")):
            execute(root, args)


def execute(root, args):
    require_default_target(root, os.environ)
    tools = toolchain(root)
    pin = load_pin(root)
    cache = cache_root(root)
    binaries = (getattr(args, "bin", "vally-server"),)
    current_key = lambda: fingerprint(root, tools, args.bundled, os.environ, binaries)
    key = current_key()
    if args.action == "status":
        artifact = pin["artifacts"].get(tools["host"])
        print(json.dumps({"key": key, "cache": str(cache), "binaries": valid_binaries(cache / "binaries" / key, key, binaries), "duckdb": bool(artifact and valid_library(library_entry(cache, artifact), artifact))}, indent=2))
        return
    build_args = ["build", "-p", "server", "--bin", args.bin] if args.action == "build" else args.arguments
    command = cargo_command(build_args, args.bundled)
    library = prepare_duckdb(cache, pin, tools["host"]) if not args.bundled and needs_duckdb(command) else None
    environment = build_environment(root, cache, library)
    if args.action == "cargo":
        run_cargo(root, command, environment)
    else:
        cached_build(root, cache, key, current_key, lambda: run_cargo(root, command, environment), binaries)
        if library is not None:
            install(library / "libduckdb.so", root / "target/dev/bin/libduckdb.so")
            evidence.artifact("duckdb", root / "target/dev/bin/libduckdb.so", "reused")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TimeoutError, tarfile.TarError, subprocess.CalledProcessError) as error:
        print(f"dev-build: 실패: {evidence.clean(str(error))}", file=sys.stderr)
        sys.exit(1)
