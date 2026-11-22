import copy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
import json
from pathlib import Path
import threading
import time
import unittest
from urllib import parse


spec = importlib.util.spec_from_file_location("themes_cli", Path(__file__).with_name("themes.py"))
themes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(themes)


LISTED = [
    {"code": "005930", "name": "삼성전자", "kind": "common"},
    {"code": "005935", "name": "삼성전자우", "kind": "preferred"},
    {"code": "009150", "name": "삼성전기", "kind": "common"},
    {"code": "042700", "name": "한미반도체", "kind": "common"},
    {"code": "403870", "name": "HPSP", "kind": "common"},
    {"code": "0158S0", "name": "영숫자 종목", "kind": "common"},
    {"code": "IDX:001", "name": "코스피", "kind": "index"},
]


class FakeServer:
    def __init__(self):
        self.document = {"themes": [], "revision": 0}
        self.puts = []
        self.before_put = []
        self.lock = threading.Lock()
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                pass

            def reply(self, status, body):
                raw = json.dumps(body, ensure_ascii=False).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                url = parse.urlsplit(self.path)
                if url.path == themes.THEMES_PATH:
                    with fake.lock:
                        return self.reply(200, copy.deepcopy(fake.document))
                if url.path == "/api/symbols":
                    query = parse.parse_qs(url.query).get("q", [""])[0]
                    return self.reply(200, [info for info in LISTED if query in info["name"] or query in info["code"]])
                if url.path.startswith("/api/symbols/"):
                    code = parse.unquote(url.path.removeprefix("/api/symbols/"))
                    found = [info for info in LISTED if info["code"] == code]
                    return self.reply(200, found[0]) if found else self.reply(404, {"error": {"code": "unknown_symbol", "message": f"없는 종목: {code}"}})
                self.reply(404, {"error": {"code": "not_found", "message": self.path}})

            def do_PUT(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                with fake.lock:
                    fake.puts.append(copy.deepcopy(body))
                    if fake.before_put:
                        fake.before_put.pop(0)(fake.document)
                    if body["revision"] <= fake.document["revision"]:
                        return self.reply(409, {"error": {"code": "stale_revision", "message": f"더 새 편집(revision {fake.document['revision']})이 이미 저장돼 있습니다"}})
                    names = [theme["name"] for theme in body["themes"]]
                    if any(not name.strip() or name != name.strip() for name in names):
                        return self.reply(400, {"error": {"code": "bad_request", "message": "테마 이름은 앞뒤 공백 없이 1~40자여야 합니다"}})
                    fake.document = copy.deepcopy(body)
                    return self.reply(200, body)

        self.http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.http.server_address[1]}"
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()

    def stop(self):
        self.http.shutdown()
        self.http.server_close()

    def seed(self, *named):
        self.document = {"themes": [{"id": f"id-{name}", "name": name, "symbols": list(symbols)} for name, symbols in named], "revision": 5}


class ThemesCliTests(unittest.TestCase):
    def setUp(self):
        self.server = FakeServer()
        self.addCleanup(self.server.stop)

    def run_cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        code = themes.main(["--url", self.server.url, *argv], out=out, err=err)
        return code, out.getvalue(), err.getvalue()

    def names(self):
        return [theme["name"] for theme in self.server.document["themes"]]

    def symbols(self, name):
        return next(theme["symbols"] for theme in self.server.document["themes"] if theme["name"] == name)

    def test_create_then_add_by_name_and_code_saves_once_per_command_with_a_millisecond_revision(self):
        started = int(time.time() * 1000)
        self.assertEqual(self.run_cli("create", "반도체 소부장")[0], 0)
        code, out, _ = self.run_cli("add", "반도체 소부장", "한미반도체", "403870", "0158S0")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.symbols("반도체 소부장"), ["042700", "403870", "0158S0"])
        self.assertIn("반도체 소부장: + 한미반도체(042700)", out)
        self.assertEqual(len(self.server.puts), 2)
        self.assertGreaterEqual(self.server.document["revision"], started)
        self.assertTrue(self.server.document["themes"][0]["id"].startswith("t-"))

    def test_a_name_that_matches_one_stock_exactly_wins_over_partial_matches(self):
        self.server.seed(("AI 반도체", []))
        self.assertEqual(self.run_cli("add", "AI 반도체", "삼성전자")[0], 0)
        self.assertEqual(self.symbols("AI 반도체"), ["005930"])

    def test_an_ambiguous_name_shows_candidates_and_sends_nothing(self):
        self.server.seed(("AI 반도체", []))
        code, _, err = self.run_cli("add", "AI 반도체", "한미반도체", "삼성")
        self.assertEqual(code, 1)
        self.assertIn("삼성전자(005930)", err)
        self.assertIn("삼성전기(009150)", err)
        self.assertEqual(self.server.puts, [], "한 종목이라도 정해지지 않으면 아무것도 보내지 않는다")

    def test_an_index_or_an_unknown_code_is_refused(self):
        self.server.seed(("AI 반도체", []))
        for given, reason in [("코스피", "지수는"), ("IDX:001", "지수는"), ("999999", "없는 코드")]:
            code, _, err = self.run_cli("add", "AI 반도체", given)
            self.assertEqual(code, 1, given)
            self.assertIn(reason, err, given)
        self.assertEqual(self.server.puts, [])

    def test_adding_what_is_there_or_removing_what_is_not_changes_nothing(self):
        self.server.seed(("AI 반도체", ["005930"]))
        code, out, _ = self.run_cli("add", "AI 반도체", "005930")
        self.assertEqual(code, 0)
        self.assertIn("이미 AI 반도체에 있습니다", out)
        code, out, _ = self.run_cli("remove", "AI 반도체", "042700")
        self.assertEqual(code, 0)
        self.assertIn("AI 반도체에 없습니다", out)
        self.assertEqual(self.server.puts, [])

    def test_remove_takes_a_name_or_a_code_that_is_no_longer_listed(self):
        self.server.seed(("AI 반도체", ["005930", "123450", "042700"]))
        self.assertEqual(self.run_cli("remove", "AI 반도체", "한미반도체", "123450")[0], 0)
        self.assertEqual(self.symbols("AI 반도체"), ["005930"])

    def test_a_conflicting_save_is_retried_on_the_fresh_document_and_keeps_the_other_edit(self):
        self.server.seed(("AI 반도체", []), ("금융", []))

        def other_pc(document):
            document["themes"][1]["symbols"].append("009150")
            document["revision"] = int(time.time() * 1000) + 60_000

        self.server.before_put.append(other_pc)
        code, out, _ = self.run_cli("add", "AI 반도체", "삼성전자")
        self.assertEqual(code, 0, out)
        self.assertEqual(len(self.server.puts), 2)
        self.assertEqual(self.symbols("AI 반도체"), ["005930"])
        self.assertEqual(self.symbols("금융"), ["009150"], "다시 읽은 문서에 명령만 다시 적용한다")

    def test_three_conflicts_in_a_row_give_up(self):
        self.server.seed(("AI 반도체", []))

        def bump(document):
            document["revision"] = int(time.time() * 1000) + 60_000 * (len(self.server.puts) + 1)

        self.server.before_put.extend([bump] * themes.MAX_ATTEMPTS)
        code, _, err = self.run_cli("add", "AI 반도체", "삼성전자")
        self.assertEqual(code, 1)
        self.assertIn("겹쳐", err)
        self.assertEqual(len(self.server.puts), themes.MAX_ATTEMPTS)

    def test_dry_run_prints_the_change_and_sends_nothing(self):
        self.server.seed(("AI 반도체", ["005930"]))
        code, out, _ = self.run_cli("add", "AI 반도체", "한미반도체", "--dry-run")
        self.assertEqual(code, 0)
        self.assertIn("AI 반도체: + 한미반도체(042700)", out)
        self.assertIn("--dry-run", out)
        self.assertEqual(self.server.puts, [])

    def test_create_move_rename_and_delete_keep_the_order_they_say(self):
        self.server.seed(("A", []), ("B", []), ("C", []))
        self.assertEqual(self.run_cli("create", "D", "--after", "A")[0], 0)
        self.assertEqual(self.names(), ["A", "D", "B", "C"])
        self.assertEqual(self.run_cli("move", "C", "--first")[0], 0)
        self.assertEqual(self.names(), ["C", "A", "D", "B"])
        code, out, _ = self.run_cli("move", "C", "--last")
        self.assertEqual((code, self.names()), (0, ["A", "D", "B", "C"]))
        self.assertIn("~ 테마 순서", out)
        self.assertEqual(self.run_cli("rename", "D", "디")[0], 0)
        code, out, _ = self.run_cli("delete", "디")
        self.assertEqual((code, self.names()), (0, ["A", "B", "C"]))
        self.assertIn("- 테마 디", out)

    def test_a_missing_theme_or_a_taken_name_is_refused_before_sending(self):
        self.server.seed(("A", []), ("B", []))
        for argv in [("add", "없음", "삼성전자"), ("rename", "A", "B"), ("move", "A", "--before", "A"), ("delete", "없음")]:
            code, _, err = self.run_cli(*argv)
            self.assertEqual(code, 1, argv)
            self.assertTrue(err, argv)
        self.assertEqual(self.server.puts, [])
        code, out, _ = self.run_cli("create", "A")
        self.assertEqual(code, 0)
        self.assertIn("이미 있는 테마", out)

    def test_the_server_reason_for_a_refusal_is_shown(self):
        self.server.seed(("A", []))
        code, _, err = self.run_cli("rename", "A", " 공백")
        self.assertEqual(code, 1)
        self.assertIn("앞뒤 공백", err)

    def test_list_and_show_read_without_writing_and_json_is_machine_readable(self):
        self.server.seed(("AI 반도체", ["005930", "123450"]), ("빈 테마", []))
        code, out, _ = self.run_cli("list")
        self.assertEqual((code, out.splitlines()), (0, ["1. AI 반도체 (2종목)", "2. 빈 테마 (0종목)"]))
        code, out, _ = self.run_cli("show", "AI 반도체")
        self.assertEqual(out.splitlines(), ["AI 반도체 (2종목)", "1. 삼성전자(005930)", "2. 123450"])
        code, out, _ = self.run_cli("--json", "add", "AI 반도체", "한미반도체")
        answer = json.loads(out)
        self.assertEqual(answer["result"], "saved")
        self.assertEqual(answer["revision"], self.server.document["revision"])
        self.assertEqual(json.loads(self.run_cli("--json", "list")[1]), self.server.document)
        self.assertEqual(len(self.server.puts), 1)

    def test_an_unreachable_server_exits_with_two(self):
        self.server.stop()
        code, _, err = self.run_cli("list")
        self.assertEqual(code, 2)
        self.assertIn("닿지 못했습니다", err)


if __name__ == "__main__":
    unittest.main()
