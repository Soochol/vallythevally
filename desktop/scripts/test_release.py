import base64
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

import release

ROOT = Path(__file__).resolve().parents[2]
PUBLIC_KEY_TEXT = "untrusted comment: minisign public key: D4AA327485FA4E99\nRWSZTvqFdDKq1DgdNEG9AzKC4UJ88FiPIGCrS8Gy7lHDxaALTltiWN+4\n"
PUBLIC_KEY = base64.b64encode(PUBLIC_KEY_TEXT.encode()).decode()


def signature_text(version):
    comment = "trusted comment: timestamp:1\tfile:vally.exe" + (f"\tversion:{version}" if version else "")
    return base64.b64encode(f"untrusted comment: signature from tauri secret key\nAAAA\n{comment}\nBBBB\n".encode()).decode()


class Fixture(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)
        self.pubkey_file = self.directory / "update.key.pub"
        self.pubkey_file.write_text(PUBLIC_KEY)

    def environment(self, **extra):
        return {release.PUBKEY_FILE_ENV: str(self.pubkey_file), **extra}

    def artifact(self, version):
        path = self.directory / "vally_setup.exe"
        path.write_bytes(b"installer")
        path.with_name("vally_setup.exe.sig").write_text(signature_text(version) + "\n")
        return path


class ReleaseConfig(Fixture):
    def test_the_overlay_turns_updates_on_with_the_pubkey_and_the_github_list(self):
        overlay = release.release_config(self.environment())
        self.assertEqual(overlay["plugins"]["updater"], {"pubkey": PUBLIC_KEY, "endpoints": [release.DEFAULT_ENDPOINT], "requireSignedVersion": True})
        self.assertEqual(overlay["bundle"], {"createUpdaterArtifacts": True})

    def test_the_default_list_is_the_github_releases_latest_json(self):
        self.assertEqual(release.DEFAULT_ENDPOINT, "https://github.com/Soochol/vallythevally/releases/latest/download/latest.json")

    def test_the_code_signing_command_is_off_unless_the_environment_names_it(self):
        self.assertNotIn("windows", release.release_config(self.environment())["bundle"])
        command = "signtool sign /sha1 THUMBPRINT %1"
        overlay = release.release_config(self.environment(**{release.WINDOWS_SIGN_COMMAND_ENV: command}))
        self.assertEqual(overlay["bundle"]["windows"], {"signCommand": command})

    def test_a_sign_command_without_the_file_placeholder_is_refused(self):
        with self.assertRaises(release.ReleaseError):
            release.release_config(self.environment(**{release.WINDOWS_SIGN_COMMAND_ENV: "signtool sign"}))

    def test_a_missing_pubkey_is_refused(self):
        with self.assertRaises(release.ReleaseError):
            release.release_config({})

    def test_a_file_that_is_not_a_public_key_is_refused(self):
        self.pubkey_file.write_text(base64.b64encode(b"untrusted comment: signature from tauri secret key\nAAAA\n").decode())
        with self.assertRaises(release.ReleaseError):
            release.release_config(self.environment())

    def test_a_plain_http_list_is_refused(self):
        with self.assertRaises(release.ReleaseError):
            release.release_config(self.environment(**{release.ENDPOINT_ENV: "http://example.invalid/latest.json"}))


class UpdateManifest(Fixture):
    def test_the_manifest_carries_the_version_the_signature_and_the_release_asset_url(self):
        artifact = self.artifact("0.2.0")
        manifest = release.update_manifest("0.2.0", "메모", "2026-11-23T00:00:00Z", "v0.2.0", {"windows-x86_64": str(artifact)})
        self.assertEqual(manifest["version"], "0.2.0")
        entry = manifest["platforms"]["windows-x86_64"]
        self.assertEqual(entry["url"], "https://github.com/Soochol/vallythevally/releases/download/v0.2.0/vally_setup.exe")
        self.assertEqual(entry["signature"], signature_text("0.2.0"))

    def test_a_signature_bound_to_another_version_is_refused(self):
        artifact = self.artifact("0.1.9")
        with self.assertRaises(release.ReleaseError):
            release.update_manifest("0.2.0", "", "2026-11-23T00:00:00Z", "v0.2.0", {"windows-x86_64": str(artifact)})

    def test_a_signature_that_names_no_version_is_refused(self):
        artifact = self.artifact(None)
        with self.assertRaises(release.ReleaseError):
            release.update_manifest("0.2.0", "", "2026-11-23T00:00:00Z", "v0.2.0", {"windows-x86_64": str(artifact)})

    def test_an_artifact_without_its_signature_file_is_refused(self):
        artifact = self.artifact("0.2.0")
        artifact.with_name("vally_setup.exe.sig").unlink()
        with self.assertRaises(release.ReleaseError):
            release.update_manifest("0.2.0", "", "2026-11-23T00:00:00Z", "v0.2.0", {"windows-x86_64": str(artifact)})

    def test_a_version_that_is_not_semver_and_an_unknown_platform_are_refused(self):
        artifact = self.artifact("0.2")
        with self.assertRaises(release.ReleaseError):
            release.update_manifest("0.2", "", "2026-11-23T00:00:00Z", "v0.2", {"windows-x86_64": str(artifact)})
        with self.assertRaises(release.ReleaseError):
            release.update_manifest("0.2.0", "", "2026-11-23T00:00:00Z", "v0.2.0", {"windows": str(self.artifact("0.2.0"))})


class CommandLine(Fixture):
    def test_the_output_option_writes_utf8_json_without_a_byte_order_mark(self):
        target = self.directory / "release.conf.json"
        release.main(["config", "--output", str(target)], self.environment())
        raw = target.read_bytes()
        self.assertFalse(raw.startswith(b"\xef\xbb\xbf"))
        self.assertEqual(json.loads(raw)["plugins"]["updater"]["pubkey"], PUBLIC_KEY)

    def test_a_manifest_is_written_to_the_output_file(self):
        artifact = self.artifact("0.2.0")
        target = self.directory / "latest.json"
        release.main(["manifest", "--version", "0.2.0", "--notes", "메모", "--pub-date", "2026-11-23T00:00:00Z", "--artifact", f"windows-x86_64={artifact}", "--output", str(target)], {})
        written = json.loads(target.read_text(encoding="utf-8"))
        self.assertEqual((written["version"], written["notes"], written["pub_date"]), ("0.2.0", "메모", "2026-11-23T00:00:00Z"))
        self.assertIn("/releases/download/v0.2.0/vally_setup.exe", written["platforms"]["windows-x86_64"]["url"])

    def test_a_refusal_exits_with_a_message_and_writes_nothing(self):
        target = self.directory / "release.conf.json"
        with self.assertRaises(SystemExit) as refused:
            release.main(["config", "--output", str(target)], {})
        self.assertIn(release.PUBKEY_FILE_ENV, str(refused.exception))
        self.assertFalse(target.exists())


class NoSecretsInTheRepository(unittest.TestCase):
    def test_no_tracked_file_holds_a_private_key(self):
        patterns = ["BEGIN" + " .*PRIV" + "ATE", "untrusted comment: " + "minisign secret"]
        found = subprocess.run(["git", "grep", "-nI", "-e", patterns[0], "-e", patterns[1]], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(found.stdout, "", "추적하는 파일에 비밀키가 있습니다")


if __name__ == "__main__":
    unittest.main()
