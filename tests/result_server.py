"""浏览器自测用的本地服务器：静态托管仓库根目录，并接收页面回传的自测结果。

用法：python tests/result_server.py [端口]
页面通过 POST /__result 把结果写进 tests/browser-result.json
"""
from __future__ import annotations

import json
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RESULT = Path(__file__).resolve().parent / "browser-result.json"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/__result":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode("utf-8", "replace")
        RESULT.write_text(body, encoding="utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(b"ok")
        print(f"已收到自测结果：{len(body)} 字节 -> {RESULT}", flush=True)

    def log_message(self, fmt: str, *args) -> None:  # 静音访问日志
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    RESULT.unlink(missing_ok=True)
    print(f"服务目录：{ROOT}\n监听：http://127.0.0.1:{port}/", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
