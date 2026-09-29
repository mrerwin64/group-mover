"""Tests for the ctypes binding and the HTTP server.

    python -m unittest discover -s ui/tests -v

The binding is checked against the real library (built on demand), including a brute-force comparison,
so a mismatch between the Python structs and group-mover.h shows up as wrong answers here.
"""

import html
import itertools
import json
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import group_mover as gm  # noqa: E402
import server  # noqa: E402

LIBRARY = gm.load(log=lambda line: None)


def find_browser():
    if os.environ.get("GROUP_MOVER_BROWSER"):
        return os.environ["GROUP_MOVER_BROWSER"]
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome", "msedge"):
        path = shutil.which(name)
        if path:
            return path
    candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ]
    return next((c for c in candidates if os.path.exists(c)), None)


def group(gid, lo, cur, hi):
    return {"id": gid, "min_size": lo, "current_size": cur, "max_size": hi}


def move(src, *dst):
    return {"src": src, "dst": list(dst)}


def brute_force(groups, moves):
    """Best (moved, total size change) over every choice of stay/destination per person."""
    best = None
    by_id = {g["id"]: g for g in groups}
    for choice in itertools.product(*[[m["src"]] + m["dst"] for m in moves]):
        size = {g["id"]: g["current_size"] for g in groups}
        for m, final in zip(moves, choice):
            size[m["src"]] -= 1
            size[final] += 1
        if any(not by_id[i]["min_size"] <= s <= by_id[i]["max_size"] for i, s in size.items()):
            continue
        moved = sum(final != m["src"] for m, final in zip(moves, choice))
        change = sum(abs(size[i] - by_id[i]["current_size"]) for i in size)
        key = (moved, -change)
        if best is None or key > best:
            best = key
    return best[0], -best[1]


def score(groups, moves, assignments):
    size = {g["id"]: g["current_size"] for g in groups}
    for m, final in zip(moves, assignments):
        size[m["src"]] -= 1
        size[final] += 1
    moved = sum(final != m["src"] for m, final in zip(moves, assignments))
    change = sum(abs(size[g["id"]] - g["current_size"]) for g in groups)
    return moved, change


class BindingTests(unittest.TestCase):
    def test_status_strings(self):
        self.assertEqual(LIBRARY.status_string(0), "ok")
        self.assertEqual(LIBRARY.status_string(8), "no groups")
        self.assertEqual(LIBRARY.status_string(12345), "unknown error")

    def test_swap(self):
        groups = [group(1, 1, 1, 1), group(2, 1, 1, 1)]
        status, assignments = LIBRARY.select_moves(groups, [move(1, 2), move(2, 1)], 7)
        self.assertEqual(status, gm.OK)
        self.assertEqual(assignments, [2, 1])

    def test_lone_move_needs_slack(self):
        self.assertEqual(LIBRARY.select_moves([group(1, 5, 5, 5), group(2, 5, 5, 5)], [move(1, 2)], 1), (0, [1]))
        self.assertEqual(LIBRARY.select_moves([group(1, 4, 5, 5), group(2, 5, 5, 6)], [move(1, 2)], 1), (0, [2]))

    def test_large_ids_and_seed(self):
        groups = [group(gm.INT32_MIN, 0, 1, 1), group(gm.INT32_MAX, 0, 1, 1)]
        status, assignments = LIBRARY.select_moves(groups, [move(gm.INT32_MIN, gm.INT32_MAX),
                                                            move(gm.INT32_MAX, gm.INT32_MIN)], gm.UINT64_MAX)
        self.assertEqual((status, assignments), (gm.OK, [gm.INT32_MAX, gm.INT32_MIN]))

    def test_errors(self):
        g = [group(1, 1, 1, 1), group(2, 1, 1, 1)]
        cases = {
            "no groups": ([], [move(1, 2)], 8),
            "invalid group": ([group(1, 2, 1, 3)], [move(1, 1)], 2),
            "duplicate group": ([group(1, 1, 1, 1), group(1, 1, 1, 1)], [move(1, 2)], 2),
            "max too large": ([group(1, 0, 0, gm.INT32_MAX + 1), group(2, 0, 0, 0)], [move(1, 2)], 2),
            "no destination": (g, [move(1)], 5),
            "self move": (g, [move(1, 2, 1)], 6),
            "unknown source": (g, [move(3, 1)], 7),
            "unknown destination": (g, [move(1, 3)], 7),
        }
        for name, (groups, moves, expected) in cases.items():
            with self.subTest(name):
                self.assertEqual(LIBRARY.select_moves(groups, moves, 0), (expected, None))

    def test_no_moves_is_ok(self):
        self.assertEqual(LIBRARY.select_moves([], [], 0), (gm.OK, []))

    def test_out_of_range_values_are_rejected_before_the_call(self):
        with self.assertRaises(ValueError):
            LIBRARY.select_moves([group(2 ** 31, 0, 0, 0)], [], 0)
        with self.assertRaises(ValueError):
            LIBRARY.select_moves([group(1, -1, 0, 0)], [], 0)
        with self.assertRaises(ValueError):
            LIBRARY.select_moves([group(1, 0, 0, 0)], [], -1)
        with self.assertRaises(ValueError):
            LIBRARY.select_moves([group(1, 0, 0, 0)], [move(1, 1.5)], 0)

    def test_same_seed_same_result(self):
        rng = random.Random(3)
        groups = [group(g, 14, 15, 16) for g in range(1, 15)]
        moves = [move(rng.randint(1, 14), *rng.sample(range(1, 15), 2)) for _ in range(40)]
        moves = [m for m in moves if m["src"] not in m["dst"]]
        prepared = LIBRARY.prepare(groups, moves)
        self.assertEqual(prepared.run(99), prepared.run(99))

    def test_matches_brute_force(self):
        rng = random.Random(1)
        for case in range(300):
            n = rng.randint(1, 4)
            groups = []
            for gid in range(n):
                cur = rng.randint(0, 3)
                groups.append(group(gid * 7 - 5, max(0, cur - rng.randint(0, 1)), cur, cur + rng.randint(0, 1)))
            ids = [g["id"] for g in groups]
            moves = []
            for _ in range(rng.randint(1, 6)):
                src = rng.choice(ids)
                options = [i for i in ids if i != src]
                if options:
                    moves.append(move(src, *rng.sample(options, rng.randint(1, len(options)))))
            if not moves:
                continue
            with self.subTest(case=case):
                status, assignments = LIBRARY.select_moves(groups, moves, case)
                self.assertEqual(status, gm.OK)
                for m, final in zip(moves, assignments):
                    self.assertIn(final, [m["src"]] + m["dst"])
                self.assertEqual(score(groups, moves, assignments), brute_force(groups, moves))


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = server.App(LIBRARY)
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler(cls.app, quiet=True))
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def request(self, path, body=None, raw=None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(self.base + path, data=data, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as e:
            with e:
                return e.code, e.headers, e.read()

    def test_info(self):
        status, _, body = self.request("/api/info")
        info = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual([s["code"] for s in info["statuses"]], list(range(9)))
        self.assertEqual(info["statuses"][2]["string"], "invalid group")

    def test_solve_many_seeds(self):
        body = {"groups": [group(1, 1, 1, 1), group(2, 1, 1, 1)], "moves": [move(1, 2), move(2, 1)],
                "seeds": ["1", 2, str(gm.UINT64_MAX)]}
        status, _, raw = self.request("/api/solve", body)
        results = json.loads(raw)["results"]
        self.assertEqual(status, 200)
        self.assertEqual([r["seed"] for r in results], ["1", "2", str(gm.UINT64_MAX)])
        self.assertTrue(all(r["assignments"] == [2, 1] for r in results))

    def test_solve_reports_library_errors(self):
        status, _, raw = self.request("/api/solve", {"groups": [], "moves": [move(1, 2)], "seeds": ["0"]})
        result = json.loads(raw)["results"][0]
        self.assertEqual(status, 200)
        self.assertEqual((result["status"], result["status_name"], result["assignments"]),
                         (8, "GROUP_MOVER_NO_GROUPS", None))

    def test_bad_requests(self):
        cases = {
            "negative size": {"groups": [group(1, -1, 0, 0)], "moves": [], "seeds": ["0"]},
            "seed too large": {"groups": [], "moves": [], "seeds": [str(2 ** 64)]},
            "seed not a number": {"groups": [], "moves": [], "seeds": ["abc"]},
            "missing field": {"groups": [{"id": 1}], "moves": [], "seeds": ["0"]},
            "dst not a list": {"groups": [group(1, 0, 0, 0)], "moves": [{"src": 1, "dst": 2}], "seeds": ["0"]},
            "no seeds": {"groups": [], "moves": [], "seeds": []},
        }
        for name, body in cases.items():
            with self.subTest(name):
                status, _, raw = self.request("/api/solve", body)
                self.assertEqual(status, 400, raw)
                self.assertIn("error", json.loads(raw))
        status, _, _ = self.request("/api/solve", raw=b"{not json")
        self.assertEqual(status, 400)

    def test_static_files(self):
        status, headers, body = self.request("/")
        self.assertEqual(status, 200)
        self.assertIn(b"Group Mover", body)
        status, headers, _ = self.request("/js/app.js")
        self.assertEqual(status, 200)
        self.assertTrue(headers["Content-Type"].startswith("text/javascript"))

    def test_browser_selftest(self):
        """Runs static/js/selftest.js in a headless Chrome or Edge, if one is installed."""
        browser = find_browser()
        if browser is None:
            self.skipTest("no Chrome, Chromium or Edge found (set GROUP_MOVER_BROWSER to its path)")
        with tempfile.TemporaryDirectory() as profile:
            proc = subprocess.run([browser, "--headless=new", "--disable-gpu", "--no-first-run",
                                   f"--user-data-dir={profile}", "--virtual-time-budget=30000",
                                   "--window-size=1400,900", "--dump-dom", self.base + "/?selftest"],
                                  capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180)
        match = re.search(r'<pre id="selftest-result">(.*?)</pre>', proc.stdout, re.S)
        self.assertIsNotNone(match, "the self-test did not finish:\n" + proc.stdout[-2000:] + proc.stderr[-2000:])
        report = html.unescape(match.group(1))
        self.assertTrue(report.startswith("SELFTEST PASS"), report)

    def test_no_path_traversal(self):
        for path in ["/../server.py", "/%2e%2e/server.py", "/js/../../group_mover.py"]:
            with self.subTest(path):
                status, _, _ = self.request(path)
                self.assertEqual(status, 404)


if __name__ == "__main__":
    unittest.main()
