#!/usr/bin/env python3
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

FIXTURES = Path(__file__).resolve().parents[4] / "crates/server/tests/fixtures/kiwoom"
ERROR_BODY = {"return_code": 3, "return_msg": "verification loopback: unscripted api-id"}


def fixture_name(api_id, body):
    code = str(body.get("stk_cd", ""))
    return {
        "au10001": lambda: "au10001_ok",
        "ka10099": lambda: "ka10099_10" if body.get("mrkt_tp") == "10" else "ka10099_0",
        "ka10100": lambda: "ka10100_005930",
        "ka10081": lambda: "ka10081_005930_NX" if code.endswith("_NX") else "ka10081_005930_AL" if code.endswith("_AL") else "ka10081_005930",
        "ka10080": lambda: "ka10080_005935_NX_1" if code == "005935_NX" else "ka10080_005930_NX_1" if code.endswith("_NX") else "ka10080_005930_3",
        "ka10001": lambda: "ka10001_086520_AL" if code.startswith("086520") else "ka10001_069500_AL" if code.startswith("069500") else "ka10001_005930_AL",
        "ka10082": lambda: "ka10082_005930_AL",
        "ka10083": lambda: "ka10083_005930_AL",
        "ka10094": lambda: "ka10094_synthetic",
        "ka10095": lambda: "ka10095_synthetic",
        "ka20005": lambda: "ka20005_001_1",
        "ka20006": lambda: "ka20006_001",
        "ka20007": lambda: "ka20007_001",
        "ka20008": lambda: "ka20008_001",
        "ka20019": lambda: "ka20019_synthetic",
    }.get(api_id, lambda: None)()


class Handler(BaseHTTPRequestHandler):
    log_path = None

    def do_POST(self):
        api_id = self.headers.get("api-id", "")
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        continued = self.headers.get("cont-yn") == "Y"
        name = fixture_name(api_id, body)
        status, headers, payload = 404, {}, ERROR_BODY
        if name and (FIXTURES / f"{name}.json").is_file():
            payload = json.loads((FIXTURES / f"{name}.json").read_text())
            status = payload.pop("_status", 200)
            headers = payload.pop("_headers", {}) if not continued else {}
            payload.pop("_headers", None)
            payload = {k: v for k, v in payload.items() if not k.startswith("_")}
            if continued:
                payload = {k: [] if isinstance(v, list) else v for k, v in payload.items()}
        with open(self.log_path, "a") as log:
            log.write(json.dumps({"api_id": api_id, "fixture": name, "status": status, "continued": continued}) + "\n")
        data = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json;charset=UTF-8")
        self.send_header("content-length", str(len(data)))
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.send_response(404)
        self.send_header("content-length", "0")
        self.end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    Handler.log_path = sys.argv[2]
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    Path(sys.argv[1]).write_text(str(server.server_address[1]))
    server.serve_forever()
