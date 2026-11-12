#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib

import dev


WASM_FILES = {"indicators.js", "indicators.d.ts", "indicators_bg.wasm", "indicators_bg.wasm.d.ts"}


def run(command, cwd, environment):
    print(f"dev-web: {subprocess.list2cmdline(command)}", flush=True)
    subprocess.run(command, cwd=cwd, env=environment, check=True)


def environment_for(root, temporary):
    temporary.mkdir(parents=True, exist_ok=True)
    environment = os.environ.copy()
    environment["TMPDIR"] = str(temporary.resolve())
    environment["CARGO_TARGET_DIR"] = str(root / "target")
    environment["CARGO_BUILD_JOBS"] = "4"
    return environment


def wasm_packages(root):
    workspace = tomllib.loads((root / "Cargo.toml").read_text()).get("workspace", {}).get("dependencies", {})
    pending = [root / "crates/indicators-wasm"]
    packages = set()
    while pending:
        package = pending.pop().resolve()
        if package in packages:
            continue
        packages.add(package)
        manifest = tomllib.loads((package / "Cargo.toml").read_text())
        owners = [manifest, *manifest.get("target", {}).values()]
        for owner in owners:
            for kind in ("dependencies", "build-dependencies"):
                for name, dependency in owner.get(kind, {}).items():
                    base = package
                    if isinstance(dependency, dict) and dependency.get("workspace"):
                        dependency = workspace[name]
                        base = root
                    if isinstance(dependency, dict) and "path" in dependency:
                        pending.append(base / dependency["path"])
    return packages


def wasm_environment(environment):
    return {**environment, "CARGO_BUILD_TARGET": "wasm32-unknown-unknown", "CARGO_PROFILE_RELEASE_LTO": "true", "CARGO_PROFILE_RELEASE_CODEGEN_UNITS": "1", "CARGO_PROFILE_RELEASE_OPT_LEVEL": "s"}


def wasm_tools(root):
    return {"rustc": dev.output(["rustc", "-vV"], root), "wasm-pack": dev.output(["wasm-pack", "--version"], root)}


def wasm_key(root, environment, tools):
    files = {root / "Cargo.toml", root / "Cargo.lock", root / "scripts/web.py", root / "scripts/dev.py", root / "web/scripts/build-wasm.sh"}
    files.update(dev.cargo_configs(root, environment))
    files.update(path for name in ("rust-toolchain", "rust-toolchain.toml") if (path := root / name).is_file())
    for package in wasm_packages(root):
        for base, directories, names in os.walk(package):
            if Path(base) == package:
                directories[:] = [name for name in directories if name != "target"]
            files.update(Path(base) / name for name in names if (Path(base) / name).is_file())
    key = hashlib.sha256()
    for path in sorted(files):
        name = path.relative_to(root).as_posix() if path.is_relative_to(root) else str(path)
        key.update(name.encode() + b"\0" + bytes.fromhex(dev.digest(path)))
    build_env = {name: value for name, value in environment.items() if name.startswith(dev.BUILD_ENV_PREFIXES) and name not in dev.LOCAL_BUILD_ENV}
    key.update(json.dumps({"format": 1, "tools": tools, "environment": build_env}, sort_keys=True).encode())
    return key.hexdigest()


def package_hashes(package):
    files = {path.relative_to(package).as_posix(): dev.digest(path) for path in package.rglob("*") if path.is_file()}
    if not WASM_FILES.issubset(files):
        raise ValueError("WASM 패키지의 필수 파일이 빠졌습니다")
    with (package / "indicators_bg.wasm").open("rb") as stream:
        if stream.read(4) != b"\0asm":
            raise ValueError("WASM 산출물이 올바르지 않습니다")
    return files


def valid_wasm(root, key):
    try:
        state = json.loads((root / "target/web/wasm.json").read_text())
        return state["key"] == key and state["outputs"] == package_hashes(root / "web/src/wasm/indicators")
    except (OSError, ValueError, KeyError, TypeError):
        return False


def run_wasm_pack(root, destination, environment):
    run(["wasm-pack", "build", str(root / "crates/indicators-wasm"), "--release", "--target", "web", "--out-name", "indicators", "--out-dir", str(destination), "--no-pack", "--no-gitignore", "--", "--locked"], root, environment)


def ensure_wasm(root, environment):
    environment = wasm_environment(environment)
    tools = wasm_tools(root)
    key = wasm_key(root, environment, tools)
    if valid_wasm(root, key):
        print("dev-web: WASM 재사용 (컴파일 잠금 생략)", flush=True)
        return
    common = Path(dev.output(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], root))
    print("dev-web: WASM 준비 / 공통 컴파일 잠금 대기", flush=True)
    with dev.locked(common / "compile.lock"):
        key = wasm_key(root, environment, tools)
        if valid_wasm(root, key):
            print("dev-web: 다른 요청이 준비한 WASM 재사용", flush=True)
            return
        output = root / "web/src/wasm/indicators"
        output.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".indicators-", dir=output.parent) as temporary:
            staged = Path(temporary)
            package = staged / "package"
            run_wasm_pack(root, package, environment)
            hashes = package_hashes(package)
            if wasm_key(root, environment, tools) != key:
                raise ValueError("WASM 빌드 중 입력이 바뀌어 산출물을 게시하지 않았습니다. 다시 실행하세요")
            backup = staged / "previous"
            if output.exists():
                output.rename(backup)
            try:
                package.rename(output)
            except OSError:
                if backup.exists():
                    backup.rename(output)
                raise
            state = staged / "wasm.json"
            state.write_text(json.dumps({"key": key, "outputs": hashes}, sort_keys=True))
            dev.install(state, root / "target/web/wasm.json")
        print("dev-web: WASM 준비 완료", flush=True)


def prepare_web(root, environment):
    run(["pnpm", "install", "--frozen-lockfile"], root / "web", environment)
    ensure_wasm(root, environment)
    run([str(root / "web/node_modules/.bin/tsc"), "-b"], root / "web", environment)


def check_web(root, arguments):
    environment = environment_for(root, root / "target/web-tmp")
    prepare_web(root, environment)
    run([str(root / "web/node_modules/.bin/vitest"), "run", *arguments], root / "web", environment)


def run_e2e(root, arguments):
    parent = root / "target/web-runs"
    parent.mkdir(parents=True, exist_ok=True)
    directory = Path(tempfile.mkdtemp(prefix="e2e-", dir=parent)).resolve()
    environment = environment_for(root, directory / "tmp")
    environment.update({"VALLY_E2E_BIN_DIR": str(root / "target/dev/bin"), "VALLY_E2E_STATIC_DIR": str(directory / "dist"), "PLAYWRIGHT_HTML_OUTPUT_DIR": str(directory / "report"), "PLAYWRIGHT_HTML_OPEN": "never"})
    try:
        run([sys.executable, str(root / "scripts/dev.py"), "build", "--with-fake"], root, environment)
        prepare_web(root, environment)
        run([str(root / "web/node_modules/.bin/vite"), "build", "--outDir", str(directory / "dist"), "--emptyOutDir"], root / "web", environment)
        if not (directory / "dist/index.html").is_file():
            raise ValueError("현재 UI 빌드가 index.html을 만들지 않았습니다")
        options = list(arguments)
        if not any(arg == "--output" or arg.startswith("--output=") for arg in options):
            options.append(f"--output={directory / 'results'}")
        if not any(arg == "--workers" or arg.startswith(("--workers=", "-j")) for arg in options):
            options.append("--workers=2")
        run([str(root / "web/node_modules/.bin/playwright"), "test", *options], root / "web", environment)
    finally:
        print(f"dev-web: E2E 산출물·결과: {directory}", flush=True)


def main():
    parser = argparse.ArgumentParser(description="로컬 웹 검사와 가짜 키움 E2E 준비 자동화")
    actions = parser.add_subparsers(dest="action", required=True)
    actions.add_parser("wasm", help="WASM 준비 또는 일치하는 로컬 산출물 재사용")
    check = actions.add_parser("check", help="의존성·WASM·타입 검사·Vitest 실행")
    check.add_argument("arguments", nargs=argparse.REMAINDER)
    e2e = actions.add_parser("e2e", help="서버·현재 웹 빌드 후 Playwright 실행 (인수 전달, 기본 worker 2)")
    e2e.add_argument("arguments", nargs=argparse.REMAINDER)
    args, leading_options = parser.parse_known_args()
    if args.action == "wasm" and leading_options:
        parser.error(f"알 수 없는 WASM 인수: {' '.join(leading_options)}")
    arguments = [*leading_options, *getattr(args, "arguments", [])]
    root = Path(__file__).resolve().parent.parent
    if args.action == "wasm":
        ensure_wasm(root, environment_for(root, root / "target/web-tmp"))
    elif args.action == "check":
        check_web(root, arguments)
    else:
        run_e2e(root, arguments)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(f"dev-web: 실패: {error}", file=sys.stderr)
        sys.exit(1)
