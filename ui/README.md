# Group Mover UI

A local web UI for the group-mover library. You enter groups and moves, it calls the real C API
(`../group-mover.h`) and draws what the library decided.

This is a side project. It lives entirely in `ui/` and nothing in the main project depends on it
or builds it.

## Running it

```
python ui/server.py
```

The only requirements are Python 3.9+ (standard library only) and CMake.

The first start builds the library into `ui/build/lib/`, starts a server on
http://127.0.0.1:8765 and opens the browser. It rebuilds automatically when `group-mover.cpp`,
`group-mover.h` or `ui/CMakeLists.txt` are newer than the built library.

- **Compiler:** the default CMake generator is tried first. If that fails on Windows and CLion is
  installed, CLion's bundled MinGW and Ninja are used instead.

| Option | Effect |
|---|---|
| `--port N` | Use another port (`0` picks a free one) |
| `--no-browser` | Don't open a browser |
| `--rebuild` | Rebuild the library before starting |
| `--build-only` | Build the library and exit |
| `--no-build` | Never build; use whatever is in `ui/build/lib/` |
| `--lib PATH` | Use another shared library, e.g. a CLion build; must be self-contained or have its DLLs next to it |

The server only listens on 127.0.0.1.

## What it does

**Input (left)**
- **Groups:** id, optional name, min, current and max.
  - "Bounds current ± k" sets every group's range in one go.
  - Names can be used instead of ids anywhere a group is typed.
- **Moves:** one row per person, with a source and any number of acceptable destinations (`3 5`, `3 / 5`, or names).
  - Enter jumps to the next row, creating one at the end.
  - A trailing `+` marks a favourite. It is only displayed; the library doesn't have preferences yet.
  - After a run, the Result column shows where each person ended up.
- **Import / export:**
  - Paste moves in almost any shape: `4 -> 3 / 5+`, `Anna: 4 3`, `Anna Smith 4 3 5`, or tab-separated from a spreadsheet. Missing groups can be created automatically.
  - Paste groups as `id min current max [name]`, or `main.cpp`'s exact stdin format.
  - Exports: `main.cpp` input (to paste into `group_mover`), a project `.json`, and a share link with the whole input in the URL.
  - A generator makes random classes similar to the real one.
- **Problems:** the input is checked with the same rules, in the same order, as `group_mover_select_moves`.
  - So the page can tell you which status the library *will* return and which row causes it.
  - Bad cells are outlined; clicking a problem jumps to its cell.
  - If the library ever returns something else than predicted, the page says so.

**Results (right)**
- **Summary:**
  - moved / requested, stayed, total size change;
  - an independent check that everyone got one of their choices and every group stayed within bounds.
  - **Apply moves** makes the result permanent: current sizes are updated and the people who moved are removed, for another round.
- **Graph:** groups are nodes, and arrows are people who moved (thicker means more people).
  - Dashed arrows are requests that weren't granted.
  - Ring colour shows whether a group grew or shrank.
  - Drag groups, pan, zoom with the wheel, double-click to fit.
  - Hover for details; click a group or arrow to list the people involved.
  - Layouts: **Swim** (the default), circle and grid. Export as SVG or PNG.
  - **Swim** is a live force simulation (`static/js/physics.js`):
    - groups float into place; groups with moves between them pull together while every pair pushes apart;
    - groups slide off arrows that aren't theirs and keep room for their labels;
    - the camera follows until you pan or zoom.
    - Drag a group and the others make room; release it and everything settles again.
    - Click Swim again to start over from the circle.
    - It stops once settled, pauses while the tab is hidden, and jumps straight to the end result if the system asks for reduced motion.
- **Before / after:** a flow diagram of every group's members, showing where they stayed or went.
- **Matrix:** source × destination, moved / asked in each cell.
- **People:** sortable, filterable, CSV export. "Not first choice" lists people who got a later option.
- **Groups:** min / before / after / max, with a range bar per group.
- **Analysis:**
  - **Fairness across seeds:** runs hundreds of consecutive seeds and shows how often each person moves. It also checks whether people with identical requests move equally often.
  - **Slack sweep:** runs the same seed with ±0, ±1, ±2, … and shows who moves at each level.

The seed box has previous / next / random buttons. **Auto** reruns on every change; Ctrl+Enter runs by hand.
The input is saved in the browser (localStorage). The theme follows the system, and the ◐ button switches it.

## Big example

**Examples → Big class** loads 15 lab groups (Mon–Wed, 08:00–16:00, 241 students) and 100 people who want
to move. Midday slots are popular and early and late ones aren't, and most people want another slot on the
same day, so Swim shows the three days as clusters.

With the seed at 12345, the number who can move grows with every step of slack:

| Slack | ±0 | ±1 | ±2 | ±3 | ±4 | ±5 | ±6 | ±7 | ±8 | ±9 | ±10 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Moved | 43 | 53 | 60 | 66 | 72 | 78 | 84 | 90 | 96 | 98 | 100 |

Try "Bounds current ± k" on the Groups tab, or Analysis → Slack sweep.

The same input, with bounds ±2, is in `examples/big-class.json` (**Open project…**) and
`examples/big-class.txt`, which you can pipe straight into `group_mover`.
`examples/generate_big_class.py` regenerates all of them, including the menu's copy in
`static/js/big-class.js`, and prints the table above using the real library.

## Layout

| Path | What it is |
|---|---|
| `CMakeLists.txt` | Standalone build of `../group-mover.cpp` as `group_mover_lib.{dll,so,dylib}` |
| `group_mover.py` | ctypes binding: structs and signatures mirroring the header, plus building and loading |
| `server.py` | HTTP server: `GET /api/info`, `POST /api/solve` (many seeds per call), `POST /api/rebuild`, static files |
| `static/` | The page: plain HTML/CSS and JS modules, no dependencies and no build step |
| `static/js/model.js` | Parsing, the validation that mirrors the C API, result analysis, import/export, examples |
| `static/js/graph.js`, `flow.js`, `views.js` | The result views |
| `static/js/physics.js` | The force simulation behind the Swim layout |
| `static/js/selftest.js` | Drives the page end to end when it is opened with `?selftest` |
| `tests/test_ui.py` | Binding and server tests (including a brute-force comparison), plus the browser self-test |

The built library is loaded from a copy in `ui/build/loaded/`. On Windows a loaded DLL can't be
overwritten, so the copy lets **Rebuild library** in the page footer rebuild and reload it while the
server keeps running. The footer warns when the C++ sources are newer than the loaded library.

## Tests

```
python -m unittest discover -s ui/tests -v
```

- **Binding and server:** the binding is checked against the real library, including 300 random
  small cases compared with a brute-force optimum. A mismatch between `group_mover.py` and the
  header shows up as wrong answers, not just crashes.
- **Browser self-test:** if Chrome, Chromium or Edge is installed, it is run headless. It covers
  parsing, every example, all views, the analysis tools, importing and editing. Set
  `GROUP_MOVER_BROWSER` to a browser path if it isn't found.
- **Manually:** open http://127.0.0.1:8765/?selftest. This mode doesn't save anything, so your input
  is left alone.

## When the C API changes

`group_mover.py` mirrors `group-mover.h` by hand: the `Group` and `Move` structs, the argument
types in `Library.__init__` and `STATUS_NAMES`. The validation in `static/js/model.js` (`compile`)
mirrors the checks in `group_mover_select_moves`. Update both together with the header; the
brute-force test and the "UI expected …" message will point out a mismatch.
