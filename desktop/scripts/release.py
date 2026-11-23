#!/usr/bin/env python3
import argparse
import base64
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

REPOSITORY_URL = "https://github.com/Soochol/vallythevally"
DEFAULT_ENDPOINT = f"{REPOSITORY_URL}/releases/latest/download/latest.json"
PUBKEY_FILE_ENV = "VALLY_UPDATER_PUBKEY_FILE"
ENDPOINT_ENV = "VALLY_UPDATER_ENDPOINT"
WINDOWS_SIGN_COMMAND_ENV = "VALLY_WINDOWS_SIGN_COMMAND"
SIGN_PLACEHOLDER = "%1"
PUBLIC_KEY_HEADER = "untrusted comment: minisign public key"
SEMVER = re.compile(r"^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$")
PLATFORM = re.compile(r"^(windows|darwin|linux)-(x86_64|aarch64|i686|armv7)$")


class ReleaseError(Exception):
    pass


def decoded_text(base64_text, what):
    try:
        return base64.b64decode(base64_text, validate=True).decode("utf-8")
    except ValueError as error:
        raise ReleaseError(f"{what}이 base64 문자열이 아닙니다: {error}")


def read_public_key(path):
    text = Path(path).read_text().strip()
    if not decoded_text(text, "공개키").startswith(PUBLIC_KEY_HEADER):
        raise ReleaseError(f"{path}는 tauri signer generate가 만든 공개키 파일(.key.pub)이 아닙니다")
    return text


def release_config(environ):
    pubkey_file = environ.get(PUBKEY_FILE_ENV)
    if not pubkey_file:
        raise ReleaseError(f"{PUBKEY_FILE_ENV}에 업데이트 공개키 파일(.key.pub) 경로를 줘야 합니다")
    endpoint = environ.get(ENDPOINT_ENV) or DEFAULT_ENDPOINT
    if not endpoint.startswith("https://"):
        raise ReleaseError(f"{ENDPOINT_ENV}는 https 주소여야 합니다: {endpoint}")
    bundle = {"createUpdaterArtifacts": True}
    sign_command = environ.get(WINDOWS_SIGN_COMMAND_ENV)
    if sign_command:
        if SIGN_PLACEHOLDER not in sign_command:
            raise ReleaseError(f"{WINDOWS_SIGN_COMMAND_ENV}에는 서명할 파일 자리 {SIGN_PLACEHOLDER}가 있어야 합니다")
        bundle["windows"] = {"signCommand": sign_command}
    updater = {"pubkey": read_public_key(pubkey_file), "endpoints": [endpoint], "requireSignedVersion": True}
    return {"bundle": bundle, "plugins": {"updater": updater}}


def signed_version(signature_base64):
    text = decoded_text(signature_base64, "서명")
    for line in text.splitlines():
        if line.startswith("trusted comment: "):
            for field in line.removeprefix("trusted comment: ").split("\t"):
                if field.startswith("version:"):
                    return field.removeprefix("version:")
    return None


def platform_entry(version, tag, platform, artifact_path):
    if not PLATFORM.match(platform):
        raise ReleaseError(f"플랫폼 이름이 낯섭니다: {platform} (예: windows-x86_64)")
    artifact = Path(artifact_path)
    signature_file = artifact.with_name(artifact.name + ".sig")
    if not artifact.is_file() or not signature_file.is_file():
        raise ReleaseError(f"갱신본과 서명 파일이 모두 있어야 합니다: {artifact}, {signature_file}")
    signature = signature_file.read_text().strip()
    bound = signed_version(signature)
    if bound != version:
        raise ReleaseError(f"{signature_file}의 서명이 묶인 판은 {bound!r}이고 올릴 판은 {version!r}입니다. 서명을 --app-version {version}으로 다시 만들어야 합니다")
    return {"signature": signature, "url": f"{REPOSITORY_URL}/releases/download/{tag}/{artifact.name}"}


def update_manifest(version, notes, pub_date, tag, artifacts):
    if not SEMVER.match(version):
        raise ReleaseError(f"판 번호가 semver가 아닙니다: {version}")
    if not artifacts:
        raise ReleaseError("갱신본이 하나도 없습니다")
    platforms = {platform: platform_entry(version, tag, platform, path) for platform, path in artifacts.items()}
    return {"version": version, "notes": notes, "pub_date": pub_date, "platforms": platforms}


def parse_artifacts(pairs):
    artifacts = {}
    for pair in pairs:
        platform, separator, path = pair.partition("=")
        if not separator:
            raise ReleaseError(f"--artifact는 플랫폼=파일 모양이어야 합니다: {pair}")
        artifacts[platform] = path
    return artifacts


def main(argv, environ):
    parser = argparse.ArgumentParser(description="릴리스 빌드용 설정 덧씌우기와 갱신 목록(latest.json)을 만든다")
    commands = parser.add_subparsers(dest="command", required=True)
    config = commands.add_parser("config", help="tauri build --config에 줄 JSON을 낸다")
    manifest = commands.add_parser("manifest", help="latest.json을 낸다")
    for command in (config, manifest):
        command.add_argument("--output", type=Path, help="이 파일에 UTF-8(BOM 없음)로 쓴다. 없으면 표준 출력")
    manifest.add_argument("--version", required=True)
    manifest.add_argument("--notes", default="")
    manifest.add_argument("--tag", help="GitHub Release 태그(기본 v<판>)")
    manifest.add_argument("--pub-date", help="RFC 3339(기본 지금)")
    manifest.add_argument("--artifact", action="append", default=[], metavar="플랫폼=파일", help="예: windows-x86_64=vally_0.2.0_x64-setup.exe (옆에 .sig가 있어야 한다)")
    arguments = parser.parse_args(argv)
    try:
        if arguments.command == "config":
            document = release_config(environ)
        else:
            pub_date = arguments.pub_date or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            document = update_manifest(arguments.version, arguments.notes, pub_date, arguments.tag or f"v{arguments.version}", parse_artifacts(arguments.artifact))
    except ReleaseError as error:
        sys.exit(f"release: {error}")
    text = json.dumps(document, ensure_ascii=False, indent=2) + "\n"
    if arguments.output:
        arguments.output.write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text)


if __name__ == "__main__":
    main(sys.argv[1:], os.environ)
