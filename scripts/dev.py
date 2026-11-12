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
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import urllib.request

import evidence


BINARIES = ("vally-server", "fake-kiwoom")
BUILD_ENV_PREFIXES = ("CARGO_", "RUST", "CC", "CXX", "AR", "CFLAGS", "CPPFLAGS", "LDFLAGS", "SDKROOT", "MACOSX_")
LOCAL_BUILD_ENV = {"CARGO_TARGET_DIR", "CARGO_BUILD_JOBS", "CCACHE_DIR", "CCACHE_BASEDIR"}


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


def build_environment(root, cache, library):
    environment = os.environ.copy()
    environment["CARGO_TARGET_DIR"] = str(root / "target")
    environment["CARGO_BUILD_JOBS"] = "4"
    temporary = root / "target" / "tmp"
    temporary.mkdir(parents=True, exist_ok=True)
    environment["TMPDIR"] = str(temporary.resolve())
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
    return "--workspace" in head or not packages or any(name not in ("fake-kiwoom", "domain", "indicators", "indicators-wasm") for name in packages)


def compile_command(root, command, environment):
    common = output(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], root)
    say("공통 컴파일 잠금 대기 / Cargo 실행")
    evidence.command(["flock", str(Path(common) / "compile.lock"), *command], root, environment)


def run_cargo(root, command, environment):
    if command[1] == "test" and "--no-run" not in command:
        at = command.index("--") if "--" in command else len(command)
        compile_command(root, [*command[:at], "--no-run", *command[at:]], environment)
        evidence.command(command, root, environment)
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
            evidence.artifact("server", destination, "reused", key)
            return
        say(f"새 빌드 입력: {key[:16]}")
        build()
        if current_key() != key:
            raise ValueError("컴파일 중 빌드 입력이 바뀌어 공유 캐시에 게시하지 않았습니다. 다시 실행하세요")
        publish_binaries(root / "target/debug", entry, key, binaries)
        restore_binaries(entry, destination, binaries)
        say(f"실행 파일 캐시 저장: {key[:16]}")
        evidence.artifact("server", destination, "direct", key)


def main():
    parser = argparse.ArgumentParser(description="worktree 간 DuckDB·개발 서버 빌드 재사용")
    parser.add_argument("--bundled", action="store_true", help="DuckDB 소스 빌드 사용 (ccache 연결)")
    subparsers = parser.add_subparsers(dest="action", required=True)
    build = subparsers.add_parser("build", help="개발 서버를 준비하고 동일 입력의 실행 파일 재사용")
    status = subparsers.add_parser("status", help="다운로드·컴파일 없이 캐시 상태 출력")
    for command in (build, status):
        command.add_argument("--with-fake", action="store_true", help="E2E용 가짜 키움도 함께 준비")
    cargo = subparsers.add_parser("cargo", help="개발용 DuckDB와 공통 잠금으로 Cargo 검사·시험")
    cargo.add_argument("arguments", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    if args.action == "status":
        execute(root, args)
    else:
        with evidence.Run(root, f"dev-{args.action}", sys.argv, os.environ.get("VALLY_EVIDENCE_DIR")):
            execute(root, args)


def execute(root, args):
    require_default_target(root, os.environ)
    tools = toolchain(root)
    pin = load_pin(root)
    cache = cache_root(root)
    binaries = BINARIES if getattr(args, "with_fake", False) else BINARIES[:1]
    current_key = lambda: fingerprint(root, tools, args.bundled, os.environ, binaries)
    key = current_key()
    if args.action == "status":
        artifact = pin["artifacts"].get(tools["host"])
        print(json.dumps({"key": key, "cache": str(cache), "binaries": valid_binaries(cache / "binaries" / key, key, binaries), "duckdb": bool(artifact and valid_library(library_entry(cache, artifact), artifact))}, indent=2))
        return
    build_args = ["build", "-p", "server", *(["-p", "fake-kiwoom"] if args.with_fake else [])] if args.action == "build" else args.arguments
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
    except (OSError, ValueError, KeyError, tarfile.TarError, subprocess.CalledProcessError) as error:
        print(f"dev-build: 실패: {evidence.clean(str(error))}", file=sys.stderr)
        sys.exit(1)
