#!/usr/bin/env python3
"""H2O dev server with CORS + no-cache headers.

Drop-in replacement for `python3 -m http.server 5500` for the chrome-live
dev workflow. The vanilla SimpleHTTPRequestHandler does NOT send
`Access-Control-Allow-Origin` or no-cache headers, which produces two bugs:

  1. The chatgpt.com loader cannot fetch the proxy pack via the page-context
     fallback path. CORS blocks the read; the loader silently degrades to
     a catalog-only fallback that the user never sees as an error.
  2. Once the loader serves a script via its catalog-only URLs (no `?v=`
     token before this fix), the browser HTTP cache holds it forever.
     Edits to script files don't propagate until the user manually clears
     cache, even after a full red-task rebuild.

CORS + no-cache headers together close both holes.

Usage:
    cd h2o-dev-server
    python3 serve.py 5500
"""
import http.server
import json
import os
import shutil
import socketserver
import subprocess
import sys
from pathlib import Path

# --- Developer Controls bounded dev-order command endpoint --------------------
# L-DEVELOPER-CONTROLS owns this localhost transport. It owns NO dev-order
# semantics: it validates the envelope shape, then hands the semantic intent to
# the Runtime-owned command in tools/loader/sync-dev-order.mjs and relays that
# command's bounded result. It is deliberately NOT a general file-write surface:
# there is no PUT, no path parameter and no file content in the request.
DEV_ORDER_COMMAND_PATH = "/__h2o/dev-order/command"
DEV_ORDER_COMMAND_MAX_BYTES = 8192
DEV_ORDER_COMMAND_TIMEOUT_S = 60
DEV_ORDER_ALLOWED_OPERATIONS = ("set-enabled", "set-section-title")
DEV_ORDER_RESULT_MARKER = "[H2O][dev-order-command]"
# serve.py lives at <repo>/apps/dev-server/serve.py
REPO_ROOT = Path(__file__).resolve().parents[2]
DEV_ORDER_COMMAND_SCRIPT = REPO_ROOT / "tools" / "loader" / "sync-dev-order.mjs"
DEV_ORDER_MASTER = REPO_ROOT / "config" / "dev-order.tsv"


def _dev_order_command_available():
    return DEV_ORDER_COMMAND_SCRIPT.is_file() and DEV_ORDER_MASTER.is_file()


def _dev_order_node_binary():
    found = shutil.which("node")
    if found:
        return found
    for candidate in ("/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node"):
        if os.path.isfile(candidate):
            return candidate
    return None


def _dev_order_origin_allowed(origin):
    # No Origin (a direct localhost tool) or an extension origin may command.
    # An ordinary http(s) page must never be able to mutate canonical source
    # just because it can reach loopback.
    if not origin or origin == "null":
        return True
    return origin.startswith("chrome-extension://") or origin.startswith("moz-extension://")


class H2ODevHandler(http.server.SimpleHTTPRequestHandler):
    # Set per-response by the command endpoint so the read-only wildcard CORS
    # header is never attached to a mutating response.
    _h2o_suppress_wildcard_cors = False

    def end_headers(self):
        if not self._h2o_suppress_wildcard_cors:
            self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def _h2o_is_loopback(self):
        host = ""
        try:
            host = str(self.client_address[0] or "")
        except Exception:
            return False
        return host in ("127.0.0.1", "::1", "::ffff:127.0.0.1")

    def _h2o_send_json(self, status, payload, origin=None):
        body = json.dumps(payload).encode("utf-8")
        self._h2o_suppress_wildcard_cors = True
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.end_headers()
        self._h2o_suppress_wildcard_cors = False
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_OPTIONS(self):
        path = self.path.split("?", 1)[0]
        if path == DEV_ORDER_COMMAND_PATH:
            origin = self.headers.get("Origin", "")
            if not self._h2o_is_loopback() or not _dev_order_origin_allowed(origin):
                self._h2o_suppress_wildcard_cors = True
                self.send_response(403)
                self.send_header("Content-Length", "0")
                self.end_headers()
                self._h2o_suppress_wildcard_cors = False
                return
            self._h2o_suppress_wildcard_cors = True
            self.send_response(204)
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "content-type")
            if origin:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
            self.send_header("Content-Length", "0")
            self.end_headers()
            self._h2o_suppress_wildcard_cors = False
            return
        self.send_response(204)
        self.send_header("Access-Control-Methods-Note", "read-only")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path != DEV_ORDER_COMMAND_PATH:
            self._h2o_send_json(404, {"ok": False, "code": "transport/unknown-endpoint",
                                      "error": "no such command endpoint"})
            return
        origin = self.headers.get("Origin", "")
        if not self._h2o_is_loopback():
            self._h2o_send_json(403, {"ok": False, "code": "transport/not-loopback",
                                      "error": "dev-order commands are loopback-only"})
            return
        if not _dev_order_origin_allowed(origin):
            self._h2o_send_json(403, {"ok": False, "code": "transport/origin-refused",
                                      "error": "origin may not issue dev-order commands"}, origin=None)
            return
        ctype = (self.headers.get("Content-Type", "") or "").split(";", 1)[0].strip().lower()
        if ctype != "application/json":
            self._h2o_send_json(415, {"ok": False, "code": "transport/unsupported-media-type",
                                      "error": "content-type must be application/json"}, origin=origin)
            return
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            length = -1
        if length < 0:
            self._h2o_send_json(400, {"ok": False, "code": "transport/bad-length",
                                      "error": "invalid content length"}, origin=origin)
            return
        if length > DEV_ORDER_COMMAND_MAX_BYTES:
            self._h2o_send_json(413, {"ok": False, "code": "transport/body-too-large",
                                      "error": "command body exceeds %d bytes" % DEV_ORDER_COMMAND_MAX_BYTES},
                                origin=origin)
            return
        raw = self.rfile.read(length) if length else b""
        try:
            envelope = json.loads(raw.decode("utf-8"))
        except Exception:
            self._h2o_send_json(400, {"ok": False, "code": "transport/malformed-json",
                                      "error": "request body is not valid JSON"}, origin=origin)
            return
        if not isinstance(envelope, dict):
            self._h2o_send_json(400, {"ok": False, "code": "transport/malformed-json",
                                      "error": "request body must be a JSON object"}, origin=origin)
            return
        operation = envelope.get("operation")
        if operation not in DEV_ORDER_ALLOWED_OPERATIONS:
            self._h2o_send_json(400, {"ok": False, "code": "transport/unsupported-operation",
                                      "error": "unsupported dev-order operation"}, origin=origin)
            return
        if not _dev_order_command_available():
            self._h2o_send_json(503, {"ok": False, "code": "transport/command-unavailable",
                                      "error": "dev-order command is not available from this server location"},
                                origin=origin)
            return
        node = _dev_order_node_binary()
        if not node:
            self._h2o_send_json(503, {"ok": False, "code": "transport/node-unavailable",
                                      "error": "node runtime not found"}, origin=origin)
            return
        try:
            completed = subprocess.run(
                [node, str(DEV_ORDER_COMMAND_SCRIPT), "--command-stdin"],
                input=json.dumps(envelope).encode("utf-8"),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=DEV_ORDER_COMMAND_TIMEOUT_S,
                cwd=str(REPO_ROOT),
                shell=False,
            )
        except subprocess.TimeoutExpired:
            self._h2o_send_json(504, {"ok": False, "code": "transport/command-timeout",
                                      "error": "dev-order command timed out"}, origin=origin)
            return
        except Exception:
            self._h2o_send_json(500, {"ok": False, "code": "transport/command-failed",
                                      "error": "dev-order command could not be executed"}, origin=origin)
            return
        result = None
        for line in completed.stdout.decode("utf-8", "replace").splitlines():
            if line.startswith(DEV_ORDER_RESULT_MARKER):
                try:
                    result = json.loads(line[len(DEV_ORDER_RESULT_MARKER):].strip())
                except Exception:
                    result = None
        if not isinstance(result, dict):
            self._h2o_send_json(502, {"ok": False, "code": "transport/no-command-result",
                                      "error": "dev-order command returned no structured result"}, origin=origin)
            return
        self._h2o_send_json(200 if result.get("ok") else 409, result, origin=origin)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5500
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", port), H2ODevHandler) as httpd:
        print(f"H2O dev server (CORS + no-cache) on http://127.0.0.1:{port}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")


if __name__ == "__main__":
    main()
