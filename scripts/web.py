#!/usr/bin/env python3
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib

import dev
import evidence


WASM_FILES = {"indicators.js", "indicators.d.ts", "indicators_bg.wasm", "indicators_bg.wasm.d.ts"}


def run(command, cwd, environment):
    print(f"dev-web: {evidence.clean(subprocess.list2cmdline(command))}", flush=True)
    evidence.command(command, cwd, environment)


def environment_for(root, temporary):
    temporary.mkdir(parents=True, exist_ok=True)
    environment = os.environ.copy()
    browser_temporary = root / "target/t"
    browser_temporary.mkdir(parents=True, exist_ok=True)
    environment["TMPDIR"] = str(browser_temporary.resolve())
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
        evidence.artifact("wasm", root / "web/src/wasm/indicators", "reused", key)
        return
    common = Path(dev.output(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], root))
    print("dev-web: WASM 준비 / 공통 컴파일 잠금 대기", flush=True)
    with dev.locked(common / "compile.lock"):
        key = wasm_key(root, environment, tools)
        if valid_wasm(root, key):
            print("dev-web: 다른 요청이 준비한 WASM 재사용", flush=True)
            evidence.artifact("wasm", root / "web/src/wasm/indicators", "reused", key)
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
        evidence.artifact("wasm", output, "direct", key)


def prepare_web(root, environment):
    record = evidence.ACTIVE
    with record.step("dependencies") if record else contextlib.nullcontext():
        run(["pnpm", "install", "--frozen-lockfile"], root / "web", environment)
    with record.step("wasm") if record else contextlib.nullcontext():
        ensure_wasm(root, environment)
    with record.step("types") if record else contextlib.nullcontext():
        run([str(root / "web/node_modules/.bin/tsc"), "-b"], root / "web", environment)


def check_web(root, arguments):
    with evidence.Run(root, "check", ["web.py", "check", *arguments]) as record:
        record.plan("dependencies", "wasm", "types", "vitest")
        environment = environment_for(root, record.directory / "tmp")
        prepare_web(root, environment)
        with record.step("vitest"):
            run([str(root / "web/node_modules/.bin/vitest"), "run", *arguments], root / "web", environment)


def prepare_server(root, environment, record):
    with record.step("server"):
        run([sys.executable, str(root / "scripts/dev.py"), "build", "--with-fake"], root, {**environment, "VALLY_EVIDENCE_DIR": str(record.directory / "server-build")})
        state = json.loads((record.directory / "server-build/manifest.json").read_text())
        if state["status"] != "passed" or state["source"] != record.data["source"] or state["source_after"] != record.data["source"]:
            raise ValueError("서버 준비 입력이 이번 실행의 시작 source와 다릅니다")
        for name, artifact in state["artifacts"].items():
            origin = Path(artifact["path"])
            destination = record.directory / "bin"
            for filename, expected in artifact["sha256"].items():
                target = destination / filename
                dev.install(origin / filename if origin.is_dir() else origin, target)
                if dev.digest(target) != expected:
                    raise ValueError("서버 실행별 사본이 검증한 산출물과 다릅니다")
            record.artifact(name, destination if origin.is_dir() else destination / origin.name, artifact["execution"], artifact["key"])
            record.data["artifacts"][name]["origin"] = str(origin)
        for filename in dev.BINARIES:
            if not (record.directory / "bin" / filename).is_file():
                raise ValueError("검증한 서버 실행 파일이 빠졌습니다")
        environment["VALLY_E2E_BIN_DIR"] = str(record.directory / "bin")


def prepare_e2e(root, environment, record):
    prepare_server(root, environment, record)
    prepare_web(root, environment)
    with record.step("ui"):
        run([str(root / "web/node_modules/.bin/vite"), "build", "--outDir", str(record.directory / "dist"), "--emptyOutDir"], root / "web", environment)
        if not (record.directory / "dist/index.html").is_file():
            raise ValueError("현재 UI 빌드가 index.html을 만들지 않았습니다")
        record.artifact("ui", record.directory / "dist", "direct", record.data["source"]["sha256"])


def run_e2e(root, arguments):
    with evidence.Run(root, "e2e", ["web.py", "e2e", *arguments]) as record:
        directory = record.directory
        record.plan("server", "dependencies", "wasm", "types", "ui", "playwright")
        environment = environment_for(root, directory / "tmp")
        environment.update({"VALLY_E2E_BIN_DIR": str(root / "target/dev/bin"), "VALLY_E2E_STATIC_DIR": str(directory / "dist"), "PLAYWRIGHT_HTML_OUTPUT_DIR": str(directory / "report"), "PLAYWRIGHT_HTML_OPEN": "never"})
        prepare_e2e(root, environment, record)
        options = list(arguments)
        if not any(arg == "--output" or arg.startswith("--output=") for arg in options):
            options.append(f"--output={directory / 'results'}")
        if not any(arg == "--workers" or arg.startswith(("--workers=", "-j")) for arg in options):
            options.append("--workers=2")
        record.data["results"].update(playwright_output=options, report=str(directory / "report"))
        with record.step("playwright"):
            verify_ui(root, record)
            run([str(root / "web/node_modules/.bin/playwright"), "test", *options], root / "web", environment)
            verify_ui(root, record)
        print(f"dev-web: E2E 산출물·결과: {directory}", flush=True)


def verify_ui(root, record):
    record.verify()
    ui = record.data["artifacts"]["ui"]
    if ui["key"] != evidence.source(root)["sha256"] or ui["sha256"] != evidence.hashes(Path(ui["path"])):
        raise ValueError("현재 source와 UI 산출물이 다릅니다. 다시 준비하세요")


def main():
    parser = argparse.ArgumentParser(description="로컬 웹 검사와 가짜 키움 E2E 준비 자동화")
    actions = parser.add_subparsers(dest="action", required=True)
    actions.add_parser("wasm", help="WASM 준비 또는 일치하는 로컬 산출물 재사용")
    check = actions.add_parser("check", help="의존성·WASM·타입 검사·Vitest 실행")
    check.add_argument("arguments", nargs=argparse.REMAINDER)
    e2e = actions.add_parser("e2e", help="서버·현재 웹 빌드 후 Playwright 실행 (인수 전달, 기본 worker 2)")
    e2e.add_argument("arguments", nargs=argparse.REMAINDER)
    doctor = actions.add_parser("doctor", help="설치·빌드·인증 없이 로컬 Chromium 진단")
    doctor.add_argument("--headed", action="store_true")
    doctor.add_argument("--json", action="store_true", dest="machine")
    live = actions.add_parser("live", help="명시 실행: 독립 fake-kiwoom + 실제 DART (005930만)")
    live.add_argument("--mode", choices=("connect", "full"), default="connect")
    live.add_argument("--timeout", type=int, choices=range(10, 601), default=300, metavar="10..600", help="준비 이후 원천 최대 시간 (초), UI 최대 120초 별도")
    live.add_argument("--headed", action="store_true")
    live.add_argument("--key-file", type=Path, help="OPENDART_API_KEY만 메모리로 읽을 파일 (복사하지 않음)")
    args, leading_options = parser.parse_known_args()
    if args.action in ("wasm", "doctor", "live") and leading_options:
        parser.error(f"알 수 없는 인수: {' '.join(leading_options)}")
    arguments = [*leading_options, *getattr(args, "arguments", [])]
    root = Path(__file__).resolve().parent.parent
    if args.action == "wasm":
        with evidence.Run(root, "wasm", sys.argv):
            ensure_wasm(root, environment_for(root, root / "target/web-tmp"))
    elif args.action == "check":
        check_web(root, arguments)
    elif args.action == "doctor":
        import doctor
        doctor.run_doctor(root, args.headed, args.machine)
    elif args.action == "live":
        import live
        live.run_live(root, args, sys.modules[__name__])
    else:
        run_e2e(root, arguments)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print(f"dev-web: 실패: {evidence.clean(str(error))}", file=sys.stderr)
        sys.exit(1)
