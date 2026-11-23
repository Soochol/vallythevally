#!/usr/bin/env python3
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CRATE = ROOT / "desktop" / "src-tauri"
COMPILE_LANE_ENV = "VALLY_COMPILE_LANE"
COMPILE_LOCKS = {"": "compile.lock", "gate": "compile-gate.lock"}
BUILD_JOBS = "4"


def compile_lock():
    lane = os.environ.get(COMPILE_LANE_ENV, "")
    if lane not in COMPILE_LOCKS:
        sys.exit(f"{COMPILE_LANE_ENV}는 비우거나 gate여야 합니다: {lane}")
    common = subprocess.run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=ROOT, check=True, capture_output=True, text=True).stdout.strip()
    return Path(common) / COMPILE_LOCKS[lane]


def under_compile_lock(arguments):
    command = ["flock", str(compile_lock()), "env", f"CARGO_BUILD_JOBS={BUILD_JOBS}", "cargo", *arguments]
    print(f"desktop: 컴파일 잠금 아래에서 {' '.join(command[3:])}", flush=True)
    subprocess.run(command, cwd=CRATE, check=True)


def build():
    under_compile_lock(["build", "--locked"])


def clippy():
    under_compile_lock(["clippy", "--locked", "--all-targets", "--", "-D", "warnings"])
    under_compile_lock(["clippy", "--locked", "--all-targets", "--features", "bench", "--", "-D", "warnings"])


def bench_build():
    under_compile_lock(["build", "--locked", "--release", "--features", "bench"])


def test():
    under_compile_lock(["test", "--locked", "--no-run"])
    print("desktop: cargo test --locked", flush=True)
    subprocess.run(["cargo", "test", "--locked"], cwd=CRATE, check=True)
    under_compile_lock(["test", "--locked", "--features", "bench", "--no-run"])
    print("desktop: cargo test --locked --features bench", flush=True)
    subprocess.run(["cargo", "test", "--locked", "--features", "bench"], cwd=CRATE, check=True)
    print("desktop: 성능 문서와 측정 JSON 대조", flush=True)
    subprocess.run([sys.executable, "-m", "unittest", "test_doc"], cwd=ROOT / "desktop" / "bench", check=True)
    print("desktop: 릴리스 설정·갱신 목록 도구 시험", flush=True)
    subprocess.run([sys.executable, "-m", "unittest", "test_release"], cwd=ROOT / "desktop" / "scripts", check=True)


def check():
    clippy()
    test()


COMMANDS = {"build": build, "clippy": clippy, "test": test, "check": check, "bench-build": bench_build}

if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        sys.exit(f"사용법: cargo.py {{{'|'.join(COMMANDS)}}}")
    try:
        COMMANDS[sys.argv[1]]()
    except subprocess.CalledProcessError as failure:
        sys.exit(failure.returncode)
