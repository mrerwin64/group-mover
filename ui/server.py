"""Local web UI for group-mover.

    python ui/server.py            # builds the library if needed, serves http://127.0.0.1:8765 and opens a browser

The browser page talks to this server, which calls the C API through ctypes (group_mover.py).
Only the Python standard library is used.
"""

import argparse
import json
import mimetypes
import sys
import threading
import time
import traceback
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import group_mover as gm

STATIC_DIR = Path(__file__).resolve().parent / "static"
MAX_BODY = 32 * 1024 * 1024
MAX_SEEDS = 20000
MAX_RUNS_TIMES_MOVES = 20_000_000  # Limits the work one request can ask for
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
}


class ApiError(Exception):
    def __init__(self, message, status=HTTPStatus.BAD_REQUEST):
        super().__init__(message)
        self.status = status


class App:
    """Holds the currently loaded library; the handlers below are plain functions of it, so tests can call them."""

    def __init__(self, library, custom_path=False):
        self.library = library
        self.custom_path = custom_path
        self.lock = threading.Lock()
        self.last_build_log = ""

    def info(self):
        lib = self.library
        return {
            "library": {
                "path": str(lib.path),
                "loaded_from": str(lib.load_path),
                "built_at": lib.built_at,
                "loaded_at": lib.loaded_at,
                "sources_changed": (not self.custom_path) and gm.needs_build(lib.path),
                "can_rebuild": not self.custom_path,
            },
            "statuses": [
                {"code": code, "name": name, "string": lib.status_string(code)}
                for code, name in gm.STATUS_NAMES.items()
            ],
            "limits": {
                "int32_min": gm.INT32_MIN, "int32_max": gm.INT32_MAX,
                "size_max": str(gm.SIZE_MAX), "uint64_max": str(gm.UINT64_MAX),
                "max_seeds": MAX_SEEDS,
            },
            "platform": sys.platform,
            "python": sys.version.split()[0],
        }

    def solve(self, body):
        if not isinstance(body, dict):
            raise ApiError("request body must be a JSON object")
        groups = body.get("groups", [])
        moves = body.get("moves", [])
        if not isinstance(groups, list) or not isinstance(moves, list):
            raise ApiError("groups and moves must be lists")
        seeds = body.get("seeds")
        if seeds is None:
            seeds = [body.get("seed", 0)]
        if not isinstance(seeds, list) or not seeds:
            raise ApiError("seeds must be a non-empty list")
        if len(seeds) > MAX_SEEDS:
            raise ApiError(f"at most {MAX_SEEDS} seeds per request")
        if len(seeds) * max(1, len(moves)) > MAX_RUNS_TIMES_MOVES:
            raise ApiError("too much work for one request; use fewer seeds")
        parsed_seeds = [parse_seed(s) for s in seeds]
        try:
            groups = [{k: g[k] for k in ("id", "min_size", "current_size", "max_size")} for g in groups]
            moves = [{"src": m["src"], "dst": m["dst"]} for m in moves]
            for i, m in enumerate(moves):
                if not isinstance(m["dst"], list):
                    raise ApiError(f"moves[{i}].dst must be a list")
        except (KeyError, TypeError) as e:
            raise ApiError(f"malformed group or move: {e!r}")

        library = self.library
        try:
            prepared = library.prepare(groups, moves)
        except ValueError as e:
            raise ApiError(str(e))

        results = []
        start = time.perf_counter()
        for seed in parsed_seeds:
            status, assignments = prepared.run(seed)
            results.append({
                "seed": str(seed),
                "status": status,
                "status_name": gm.STATUS_NAMES.get(status, "UNKNOWN"),
                "status_string": library.status_string(status),
                "assignments": assignments,
            })
        elapsed = (time.perf_counter() - start) * 1000
        return {"results": results, "elapsed_ms": elapsed}

    def rebuild(self):
        if self.custom_path:
            raise ApiError("the server was started with --lib, so it cannot rebuild the library")
        with self.lock:
            try:
                path, log = gm.build_library(log=lambda line: print(line, flush=True))
            except gm.BuildError as e:
                self.last_build_log = e.log
                return {"ok": False, "error": str(e), "log": e.log}
            self.library = gm.Library(path)
            self.last_build_log = log
            return {"ok": True, "log": log, "info": self.info()}


def parse_seed(value):
    if isinstance(value, bool):
        raise ApiError("seed must be an integer")
    if isinstance(value, str):
        text = value.strip()
        if not text.isdigit():
            raise ApiError(f"seed must be a non-negative integer, got {value!r}")
        value = int(text)
    if not isinstance(value, int) or not 0 <= value <= gm.UINT64_MAX:
        raise ApiError(f"seed must be within [0, 2^64 - 1], got {value!r}")
    return value


def make_handler(app, quiet=False):
    class Handler(BaseHTTPRequestHandler):
        server_version = "group-mover-ui"

        def log_message(self, fmt, *args):
            if not quiet:
                sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

        def send_json(self, data, status=HTTPStatus.OK):
            payload = json.dumps(data).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self):
            path = urlparse(self.path).path
            if path == "/api/info":
                return self.send_json(app.info())
            if path == "/":
                path = "/index.html"
            self.send_static(path)

        def send_static(self, path):
            target = (STATIC_DIR / path.lstrip("/")).resolve()
            if STATIC_DIR not in target.parents or not target.is_file():
                return self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
            data = target.read_bytes()
            # Explicit types: on Windows mimetypes reads the registry, which can map .js to text/plain,
            # and browsers refuse to run modules served like that
            content_type = CONTENT_TYPES.get(target.suffix.lower()) or mimetypes.guess_type(target.name)[0] \
                or "application/octet-stream"
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            path = urlparse(self.path).path
            try:
                length = int(self.headers.get("Content-Length") or 0)
                if length > MAX_BODY:
                    raise ApiError("request too large", HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
                raw = self.rfile.read(length) if length else b"{}"
                try:
                    body = json.loads(raw.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as e:
                    raise ApiError(f"invalid JSON: {e}")
                if path == "/api/solve":
                    return self.send_json(app.solve(body))
                if path == "/api/rebuild":
                    return self.send_json(app.rebuild())
                raise ApiError("not found", HTTPStatus.NOT_FOUND)
            except ApiError as e:
                self.send_json({"error": str(e)}, e.status)
            except Exception as e:  # Report instead of dropping the connection
                traceback.print_exc()
                self.send_json({"error": f"server error: {e!r}"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    return Handler


def main(argv=None):
    parser = argparse.ArgumentParser(description="Web UI for the group-mover library")
    parser.add_argument("--port", type=int, default=8765, help="port to listen on (default 8765, 0 = any free port)")
    parser.add_argument("--host", default="127.0.0.1", help="address to bind (default 127.0.0.1, local only)")
    parser.add_argument("--lib", help="use this shared library instead of building ui/build/lib/")
    parser.add_argument("--no-build", action="store_true", help="don't build the library, even if it is out of date")
    parser.add_argument("--rebuild", action="store_true", help="rebuild the library before starting")
    parser.add_argument("--build-only", action="store_true", help="build the library and exit")
    parser.add_argument("--no-browser", action="store_true", help="don't open a browser")
    parser.add_argument("--quiet", action="store_true", help="don't log requests")
    args = parser.parse_args(argv)

    try:
        if args.lib:
            library = gm.Library(args.lib)
        else:
            if args.rebuild or args.build_only or (not args.no_build and gm.needs_build()):
                gm.build_library()
            if args.build_only:
                print(f"Built {gm.default_library_path()}")
                return 0
            library = gm.load(build=False)
    except gm.BuildError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    except OSError as e:
        print(f"error: could not load the library: {e}", file=sys.stderr)
        return 1

    app = App(library, custom_path=bool(args.lib))
    server = ThreadingHTTPServer((args.host, args.port), make_handler(app, args.quiet))
    url = f"http://{args.host}:{server.server_address[1]}/"
    print(f"group-mover UI: {url}  (library: {library.path})", flush=True)
    print("Press Ctrl+C to stop.", flush=True)
    if not args.no_browser:
        threading.Timer(0.3, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
