// Table-style result views (matrix, people, groups), the graph's details panel, and the analysis tools

import {el, svg, clear, plural, signed, percent, formatMs, addToSeed, download} from "./util.js";

// ---------------------------------------------------------------------------------------------------------------
// Details for the graph's selected group or arrow

export function renderDetails(container, analysis, selection, groupLabel) {
    clear(container);
    if (!analysis || !selection) {
        container.append(el("p.muted", "Click a group or an arrow to see the people involved. Drag groups to rearrange them."));
        return;
    }
    const a = analysis;
    const person = (i, extra) => {
        const p = a.people[i];
        return el("li", el("span.person", p.name), extra ? el("span.muted", ` ${extra}`) : null);
    };
    const section = (title, items) => items.length ? [el("h4", `${title} (${items.length})`), el("ul.people-list", items)] : [];

    if (selection.type === "node") {
        const g = a.groups.get(selection.id);
        if (!g) return;
        container.append(el("h3", `Group ${groupLabel(g.id)}`));
        container.append(el("dl.stats",
            el("dt", "Allowed"), el("dd", `${g.min}–${g.max}`),
            el("dt", "Before"), el("dd", String(g.current)),
            a.hasResult ? [el("dt", "After"), el("dd", `${g.after} (${signed(g.delta)})`)] : null));
        const leaving = a.people.filter(p => p.src === g.id);
        const joining = a.people.filter(p => p.moved && p.final === g.id);
        if (!a.hasResult) {
            container.append(...section("Want to leave", leaving.map(p => person(p.index, `→ ${p.dst.map(groupLabel).join(" / ")}`))));
            container.append(...section("Would join", a.people.filter(p => p.dst.includes(g.id))
                .map(p => person(p.index, `from ${groupLabel(p.src)}`))));
            return;
        }
        container.append(...section("Left", leaving.filter(p => p.moved).map(p => person(p.index, `→ ${groupLabel(p.final)}`))));
        container.append(...section("Joined", joining.map(p => person(p.index, `from ${groupLabel(p.src)}`))));
        container.append(...section("Asked to leave but stayed", leaving.filter(p => !p.moved)
            .map(p => person(p.index, `wanted ${p.dst.map(groupLabel).join(" / ")}`))));
        container.append(...section("Asked to join but didn't", a.people.filter(p => p.dst.includes(g.id) && p.final !== g.id)
            .map(p => person(p.index, p.moved ? `went to ${groupLabel(p.final)}` : `stayed in ${groupLabel(p.src)}`))));
        return;
    }
    const e = a.edges.get(selection.key);
    if (!e) return;
    container.append(el("h3", `${groupLabel(e.a)} → ${groupLabel(e.b)}`));
    if (!a.hasResult) {
        container.append(...section("Asked", e.stayed.map(i => person(i))));
        return;
    }
    container.append(...section("Moved", e.moved.map(i => person(i))));
    container.append(...section("Asked but stayed", e.stayed.map(i => person(i))));
    container.append(...section("Got another of their choices", e.elsewhere.map(i => person(i, `→ ${groupLabel(a.people[i].final)}`))));
}

// ---------------------------------------------------------------------------------------------------------------
// Matrix: rows are where people come from, columns where they asked to go

export function renderMatrix(container, analysis, groupLabel) {
    clear(container);
    const a = analysis;
    if (!a || a.people.length === 0) {
        container.append(el("div.empty-state", "No moves to show."));
        return;
    }
    const involved = new Set();
    for (const e of a.edges.values()) { involved.add(e.a); involved.add(e.b); }
    const ids = [...a.groups.keys()].filter(id => a.groups.size <= 30 || involved.has(id));
    const cell = new Map();
    let maxMoved = 0, maxAsked = 0;
    for (const e of a.edges.values()) {
        const asked = e.moved.length + e.stayed.length + e.elsewhere.length;
        cell.set(e.key, {moved: e.moved.length, asked});
        maxMoved = Math.max(maxMoved, e.moved.length);
        maxAsked = Math.max(maxAsked, asked);
    }
    const intensity = (c) => {
        const value = a.hasResult ? c.moved : c.asked;
        const max = a.hasResult ? maxMoved : maxAsked;
        return value === 0 || max === 0 ? 0 : 0.15 + 0.85 * (value / max);
    };
    const head = el("tr", el("th.corner", {scope: "col"}, el("span", "from ↓ to →")),
        ids.map(id => el("th", {scope: "col"}, groupLabel(id))), el("th.total", {scope: "col"}, a.hasResult ? "Left / asked" : "Asked"));
    const rows = ids.map(src => {
        const g = a.groups.get(src);
        return el("tr", el("th", {scope: "row"}, groupLabel(src)),
            ids.map(dst => {
                const c = cell.get(`${src}>${dst}`);
                if (src === dst) return el("td.diag", "");
                if (!c) return el("td", "");
                const text = a.hasResult ? `${c.moved}/${c.asked}` : String(c.asked);
                const td = el("td.filled", {title: a.hasResult
                    ? `${groupLabel(src)} → ${groupLabel(dst)}: ${c.moved} moved of ${c.asked} who listed it`
                    : `${groupLabel(src)} → ${groupLabel(dst)}: ${c.asked} asked`}, text);
                td.style.setProperty("--fill", String(intensity(c)));
                if (intensity(c) > 0.6) td.classList.add("dark");
                return td;
            }),
            el("td.total", a.hasResult ? `${g.out}/${g.wantOut}` : String(g.wantOut)));
    });
    const foot = el("tr", el("th.total", {scope: "row"}, a.hasResult ? "Joined / asked" : "Asked"),
        ids.map(id => {
            const g = a.groups.get(id);
            return el("td.total", a.hasResult ? `${g.in}/${g.wantIn}` : String(g.wantIn));
        }),
        el("td.total", a.hasResult ? `${a.totals.moved}/${a.people.length}` : String(a.people.length)));
    container.append(
        el("p.muted.small", a.hasResult
            ? "Each cell is moved / asked: of the people in the row's group who listed the column's group, how many ended up there."
            : "Each cell counts the people in the row's group who listed the column's group. Run the library to see what happened."),
        el("div.table-scroll", el("table.matrix", el("thead", head), el("tbody", rows), el("tfoot", foot))));
}

// ---------------------------------------------------------------------------------------------------------------
// People

export class PeopleView {
    constructor(container, {groupLabel, onPick}) {
        this.groupLabel = groupLabel;
        this.onPick = onPick;
        this.filter = "all";
        this.query = "";
        this.sort = {key: "index", dir: 1};
        this.filterButtons = {};
        const seg = (key, label) => {
            const b = el("button.seg", {type: "button", on: {click: () => { this.filter = key; this.draw(); }}}, label);
            this.filterButtons[key] = b;
            return b;
        };
        this.count = el("span.muted.small");
        this.search = el("input.search", {type: "search", placeholder: "Search people or groups",
            "aria-label": "Search people", on: {input: (e) => { this.query = e.target.value; this.draw(); }}});
        this.body = el("div.table-scroll");
        this.root = el("div.people-view",
            el("div.toolbar", el("div.segmented", {role: "group", "aria-label": "Filter"},
                seg("all", "All"), seg("moved", "Moved"), seg("stayed", "Stayed"), seg("second", "Not first choice")),
            this.search, el("span.spacer"), this.count,
            el("button.ghost", {type: "button", on: {click: () => this.exportCsv?.()}}, "CSV")),
            this.body);
        container.append(this.root);
    }

    update(analysis, exportCsv) {
        this.analysis = analysis;
        this.exportCsv = exportCsv;
        this.draw();
    }

    draw() {
        for (const [key, b] of Object.entries(this.filterButtons)) b.classList.toggle("active", key === this.filter);
        clear(this.body);
        const a = this.analysis;
        if (!a || a.people.length === 0) {
            this.count.textContent = "";
            this.body.append(el("div.empty-state", "No moves yet."));
            return;
        }
        const label = this.groupLabel;
        const q = this.query.trim().toLowerCase();
        let people = a.people.filter(p => {
            if (this.filter === "moved" && !p.moved) return false;
            if (this.filter === "stayed" && (p.moved || !a.hasResult)) return false;
            if (this.filter === "second" && !(p.moved && p.final !== p.dst[0])) return false;
            if (!q) return true;
            const text = [p.name, label(p.src), ...p.dst.map(label), p.final === null ? "" : label(p.final)].join(" ").toLowerCase();
            return text.includes(q);
        });
        const keyOf = {
            index: p => p.index,
            name: p => p.name.toLowerCase(),
            src: p => p.src,
            wants: p => p.dst.length,
            result: p => (p.moved ? 0 : 1) * 1e10 + (p.final ?? 0),
        }[this.sort.key];
        people = [...people].sort((x, y) => {
            const kx = keyOf(x), ky = keyOf(y);
            return (kx < ky ? -1 : kx > ky ? 1 : x.index - y.index) * this.sort.dir;
        });
        this.count.textContent = `${people.length} of ${a.people.length}`;
        const th = (key, text) => {
            const active = this.sort.key === key;
            return el("th", {scope: "col", "aria-sort": active ? (this.sort.dir > 0 ? "ascending" : "descending") : "none"},
                el("button.sort", {type: "button", on: {click: () => {
                    this.sort = {key, dir: active ? -this.sort.dir : 1};
                    this.draw();
                }}}, text, active ? (this.sort.dir > 0 ? " ▴" : " ▾") : ""));
        };
        const rows = people.map(p => el("tr", {class: p.moved ? "row-moved" : a.hasResult ? "row-stayed" : "",
            on: {click: () => this.onPick?.(p.row)}, title: "Click to edit this move"},
        el("td.num", String(p.row + 1)),
        el("td", p.name),
        el("td", label(p.src)),
        el("td", p.dst.map((d, k) => el("span.chip", {class: p.final === d ? "chip chip-hit" : "chip"},
            label(d), p.preferred[k] ? el("span.pref", {title: "Marked as preferred (+)"}, "★") : null))),
        el("td", !a.hasResult ? el("span.muted", "–") : p.moved
            ? el("span.badge.badge-moved", `→ ${label(p.final)}`)
            : el("span.badge.badge-stayed", "stays"))));
        this.body.append(el("table.data", el("thead", el("tr", th("index", "#"), th("name", "Person"), th("src", "From"),
            th("wants", "Wants"), th("result", "Result"))), el("tbody", rows)));
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Groups: sizes before and after within their allowed range

export function renderGroups(container, analysis, groupLabel) {
    clear(container);
    const a = analysis;
    if (!a || a.groups.size === 0) {
        container.append(el("div.empty-state", "No groups yet."));
        return;
    }
    const groups = [...a.groups.values()];
    const lo = Math.max(0, Math.min(...groups.map(g => Math.min(g.min, g.after))) - 1);
    const hi = Math.max(...groups.map(g => Math.max(g.max, g.after))) + 1;
    const W = 180, H = 22, pad = 6;
    const x = (v) => pad + ((v - lo) / Math.max(1, hi - lo)) * (W - 2 * pad);
    const rangeBar = (g) => {
        const out = a.hasResult && (g.after < g.min || g.after > g.max);
        const s = svg("svg", {width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: "range-bar", role: "img",
            "aria-label": `allowed ${g.min} to ${g.max}, before ${g.current}` + (a.hasResult ? `, after ${g.after}` : "")},
        svg("line", {x1: pad, x2: W - pad, y1: H / 2, y2: H / 2, class: "range-axis"}),
        svg("rect", {x: x(g.min) - 3, y: H / 2 - 4, width: Math.max(6, x(g.max) - x(g.min) + 6), height: 8, rx: 4,
            class: out ? "range-allowed out" : "range-allowed"}));
        if (a.hasResult && g.after !== g.current) {
            s.append(svg("line", {x1: x(g.current), x2: x(g.after), y1: H / 2, y2: H / 2, class: "range-change"}));
        }
        s.append(svg("circle", {cx: x(g.current), cy: H / 2, r: 4.5, class: "range-before"}));
        if (a.hasResult) s.append(svg("circle", {cx: x(g.after), cy: H / 2, r: 4.5, class: g.delta > 0 ? "range-after grew" :
            g.delta < 0 ? "range-after shrank" : "range-after"}));
        return s;
    };
    const rows = groups.map(g => el("tr", {class: a.hasResult && g.delta ? (g.delta > 0 ? "row-grew" : "row-shrank") : ""},
        el("td", groupLabel(g.id)),
        el("td.num", String(g.min)), el("td.num", String(g.current)),
        el("td.num.strong", a.hasResult ? String(g.after) : "–"),
        el("td.num", String(g.max)),
        el("td.num", a.hasResult ? el("span", {class: g.delta > 0 ? "delta up" : g.delta < 0 ? "delta down" : "delta"},
            signed(g.delta)) : "–"),
        el("td.num", a.hasResult ? `${g.out} / ${g.wantOut}` : String(g.wantOut)),
        el("td.num", a.hasResult ? `${g.in} / ${g.wantIn}` : String(g.wantIn)),
        el("td", rangeBar(g))));
    const legend = el("div.legend.inline",
        el("span.legend-item", el("span.key-range"), "Allowed range"),
        el("span.legend-item", el("span.key-dot.hollow"), "Before"),
        a.hasResult ? el("span.legend-item", el("span.key-dot.filled"), "After") : null,
        el("span.muted.small", `Scale ${lo}–${hi}`));
    container.append(legend, el("div.table-scroll", el("table.data",
        el("thead", el("tr", ["Group", "Min", "Before", "After", "Max", "Change",
            a.hasResult ? "Left / asked" : "Want to leave", a.hasResult ? "Joined / asked" : "Would join", "Range"]
            .map(t => el("th", {scope: "col"}, t)))),
        el("tbody", rows))));
}

// ---------------------------------------------------------------------------------------------------------------
// Analysis: many seeds on the same input (fairness), and the same seed with more and more slack

export class AnalysisView {
    constructor(container, {groupLabel, runSeeds, getCompiled, getSeed, applySlack}) {
        this.groupLabel = groupLabel;
        this.runSeeds = runSeeds;
        this.getCompiled = getCompiled;
        this.getSeed = getSeed;
        this.applySlack = applySlack;

        this.seedCount = el("input", {type: "number", min: "10", max: "20000", step: "10", value: "300",
            "aria-label": "Number of seeds"});
        this.seedButton = el("button.primary", {type: "button", on: {click: () => this.runSeedStudy()}}, "Run seeds");
        this.seedOut = el("div.analysis-out");
        this.slackMax = el("input", {type: "number", min: "0", max: "50", value: "3", "aria-label": "Largest slack"});
        this.slackButton = el("button.primary", {type: "button", on: {click: () => this.runSlackSweep()}}, "Run sweep");
        this.slackOut = el("div.analysis-out");

        this.root = el("div.analysis-view",
            el("section.card",
                el("h3", "Fairness across seeds"),
                el("p.muted", "Runs the current input with many consecutive seeds, starting at the current seed. " +
                    "The number of moves never depends on the seed; who gets to move does. People with identical " +
                    "requests should move equally often."),
                el("div.row", el("label", "Seeds ", this.seedCount), this.seedButton),
                this.seedOut),
            el("section.card",
                el("h3", "Slack sweep"),
                el("p.muted", "Runs the current seed with every group allowed to shrink or grow by 0, 1, 2, … people " +
                    "around its current size, ignoring the min and max in the editor."),
                el("div.row", el("label", "Up to ± ", this.slackMax), this.slackButton),
                this.slackOut));
        container.append(this.root);
    }

    ready() {
        const compiled = this.getCompiled();
        if (!compiled.ok) return {error: "Fix the problems in the input first."};
        if (compiled.request.moves.length === 0) return {error: "Add some moves first."};
        return {compiled};
    }

    async runSeedStudy() {
        const {compiled, error} = this.ready();
        clear(this.seedOut);
        if (error) { this.seedOut.append(el("p.notice", error)); return; }
        const n = Math.max(1, Math.min(20000, Math.round(Number(this.seedCount.value) || 300)));
        const base = this.getSeed();
        const seeds = Array.from({length: n}, (_, i) => addToSeed(base, i));
        const progress = el("progress", {max: String(n), value: "0"});
        this.seedOut.append(el("div.row", progress, el("span.muted.small", "Running…")));
        this.seedButton.disabled = true;
        const started = performance.now();
        let results = [];
        let libraryMs = 0;
        try {
            const chunk = Math.max(50, Math.floor(200000 / Math.max(1, compiled.request.moves.length)));
            for (let i = 0; i < n; i += chunk) {
                const response = await this.runSeeds(compiled.request, seeds.slice(i, i + chunk));
                results = results.concat(response.results);
                libraryMs += response.elapsed_ms;
                progress.value = results.length;
            }
        } catch (e) {
            clear(this.seedOut).append(el("p.notice.error", e.message));
            return;
        } finally {
            this.seedButton.disabled = false;
        }
        const wall = performance.now() - started;
        clear(this.seedOut);
        const failed = results.filter(r => r.status !== 0);
        if (failed.length) {
            this.seedOut.append(el("p.notice.error", `The library returned "${failed[0].status_string}" ` +
                `for ${plural(failed.length, "seed")}.`));
            return;
        }
        this.renderSeedStudy(compiled, results, libraryMs, wall);
    }

    renderSeedStudy(compiled, results, libraryMs, wall) {
        const label = this.groupLabel;
        const moves = compiled.request.moves;
        const n = results.length;
        const movedCounts = results.map(r => r.assignments.filter((f, i) => f !== moves[i].src).length);
        const sizeChange = results.map(r => {
            const delta = new Map();
            r.assignments.forEach((f, i) => {
                if (f === moves[i].src) return;
                delta.set(moves[i].src, (delta.get(moves[i].src) || 0) - 1);
                delta.set(f, (delta.get(f) || 0) + 1);
            });
            let s = 0;
            for (const v of delta.values()) s += Math.abs(v);
            return s;
        });
        const distinct = new Set(results.map(r => r.assignments.join(","))).size;
        const range = (xs) => {
            const lo = Math.min(...xs), hi = Math.max(...xs);
            return lo === hi ? String(lo) : `${lo}–${hi}`;
        };
        const tile = (labelText, value, note) => el("div.tile", el("div.tile-label", labelText), el("div.tile-value", value),
            note ? el("div.tile-note", note) : null);
        this.seedOut.append(el("div.tiles",
            tile("People moved", range(movedCounts), Math.min(...movedCounts) === Math.max(...movedCounts)
                ? "same for every seed" : "varies with the seed"),
            tile("Total size change", range(sizeChange), Math.min(...sizeChange) === Math.max(...sizeChange)
                ? "same for every seed" : "varies with the seed"),
            tile("Different outcomes", String(distinct), `across ${plural(n, "seed")}`),
            tile("Library time", formatMs(libraryMs / n), `per run · ${formatMs(wall)} total`)));

        // Per-person rates
        const people = moves.map((m, i) => {
            const dest = new Map();
            let moved = 0;
            for (const r of results) {
                const f = r.assignments[i];
                if (f !== m.src) {
                    moved += 1;
                    dest.set(f, (dest.get(f) || 0) + 1);
                }
            }
            return {i, name: compiled.people[i].name, src: m.src, dst: m.dst, rate: moved / n, dest,
                klass: `${m.src}>${[...new Set(m.dst)].sort((x, y) => x - y).join(",")}`};
        });

        // Identical requests should have similar rates; flag spreads well beyond sampling noise
        const classes = new Map();
        for (const p of people) {
            if (!classes.has(p.klass)) classes.set(p.klass, []);
            classes.get(p.klass).push(p);
        }
        const shared = [...classes.values()].filter(list => list.length > 1);
        if (shared.length) {
            const rows = shared.map(list => {
                const rates = list.map(p => p.rate);
                const mean = rates.reduce((s, r) => s + r, 0) / rates.length;
                const spread = Math.max(...rates) - Math.min(...rates);
                const noise = Math.sqrt(Math.max(mean * (1 - mean), 1 / n) / n);
                const suspicious = spread > 5 * noise + 0.02;
                return el("tr",
                    el("td", `${label(list[0].src)} → ${[...new Set(list[0].dst)].map(label).join(" / ")}`),
                    el("td.num", String(list.length)),
                    el("td.num", percent(mean)),
                    el("td.num", `${percent(Math.min(...rates))}–${percent(Math.max(...rates))}`),
                    el("td", suspicious ? el("span.badge.badge-warn", "⚠ uneven") : el("span.badge.badge-ok", "✓ even")));
            });
            this.seedOut.append(el("h4", "Identical requests"),
                el("p.muted.small", "People asking for exactly the same thing. “Uneven” means the spread is well beyond " +
                    "what chance explains for this many seeds."),
                el("div.table-scroll", el("table.data", el("thead", el("tr", ["Request", "People", "Mean", "Range", ""]
                    .map(t => el("th", {scope: "col"}, t)))), el("tbody", rows))));
        }

        const sorted = [...people].sort((x, y) => x.rate - y.rate || x.i - y.i);
        const rows = sorted.map(p => {
            const destText = [...p.dest.entries()].sort((x, y) => y[1] - x[1])
                .map(([d, c]) => `${label(d)} ${percent(c / n)}`).join(" · ");
            return el("tr",
                el("td", p.name),
                el("td", `${label(p.src)} → ${p.dst.map(label).join(" / ")}`),
                el("td.bar-cell", el("div.meter", {role: "img", "aria-label": `moves in ${percent(p.rate)} of seeds`},
                    el("div.meter-fill", {style: {width: `${(p.rate * 100).toFixed(1)}%`}})),
                el("span.num", percent(p.rate))),
                el("td.muted.small", destText || "–"));
        });
        this.seedOut.append(el("h4", "How often each person moves"),
            el("div.table-scroll.tall", el("table.data", el("thead", el("tr", ["Person", "Request", "Moves in", "Ends up in"]
                .map(t => el("th", {scope: "col"}, t)))), el("tbody", rows))),
            el("div.row", el("button.ghost", {type: "button", on: {click: () => {
                const csv = ["person,from,wants,move_rate", ...people.map(p =>
                    `"${p.name.replace(/"/g, '""')}",${label(p.src)},"${p.dst.map(label).join(" / ")}",${p.rate}`)].join("\n");
                download("group-mover-seed-study.csv", csv + "\n", "text/csv");
            }}}, "Download CSV")));
    }

    async runSlackSweep() {
        const {compiled, error} = this.ready();
        clear(this.slackOut);
        if (error) { this.slackOut.append(el("p.notice", error)); return; }
        const kMax = Math.max(0, Math.min(50, Math.round(Number(this.slackMax.value) || 0)));
        const seed = this.getSeed();
        this.slackButton.disabled = true;
        const results = [];
        try {
            for (let k = 0; k <= kMax; k++) {
                const request = {
                    groups: compiled.request.groups.map(g => ({...g, min_size: Math.max(0, g.current_size - k),
                        max_size: g.current_size + k})),
                    moves: compiled.request.moves,
                };
                const response = await this.runSeeds(request, [seed]);
                results.push({k, result: response.results[0]});
            }
        } catch (e) {
            this.slackOut.append(el("p.notice.error", e.message));
            return;
        } finally {
            this.slackButton.disabled = false;
        }
        const label = this.groupLabel;
        const moves = compiled.request.moves;
        const summary = results.map(({k, result}) => {
            if (result.status !== 0) return {k, error: result.status_string};
            const delta = new Map();
            let moved = 0;
            result.assignments.forEach((f, i) => {
                if (f === moves[i].src) return;
                moved += 1;
                delta.set(moves[i].src, (delta.get(moves[i].src) || 0) - 1);
                delta.set(f, (delta.get(f) || 0) + 1);
            });
            const changed = [...delta.entries()].filter(([, v]) => v !== 0);
            return {k, moved, assignments: result.assignments,
                change: changed.reduce((s, [, v]) => s + Math.abs(v), 0),
                changedText: changed.sort((x, y) => x[0] - y[0]).map(([g, v]) => `${label(g)} ${signed(v)}`).join(", ")};
        });
        const total = moves.length;
        const best = Math.max(...summary.map(s => s.moved ?? 0));
        this.slackOut.append(el("div.table-scroll", el("table.data",
            el("thead", el("tr", ["Slack", "Moved", "", "Size change", "Groups that change", ""].map(t => el("th", {scope: "col"}, t)))),
            el("tbody", summary.map(s => s.error ? el("tr", el("td", `±${s.k}`), el("td", {colspan: "5"}, s.error)) :
                el("tr",
                    el("td", `±${s.k}`),
                    el("td.num", `${s.moved} / ${total}`),
                    el("td.bar-cell", el("div.meter", el("div.meter-fill", {style: {width: `${total ? (s.moved / total) * 100 : 0}%`}}))),
                    el("td.num", String(s.change)),
                    el("td.small", s.changedText || el("span.muted", "none")),
                    el("td", el("button.ghost.small", {type: "button", title: `Set every group's bounds to current ± ${s.k}`,
                        on: {click: () => this.applySlack(s.k)}}, "Use"))))))));
        if (summary.some(s => s.error)) return;
        // Who moves at each slack, like a small timetable
        const rows = moves.map((m, i) => el("tr",
            el("td", compiled.people[i].name),
            el("td", `${label(m.src)} → ${m.dst.map(label).join(" / ")}`),
            summary.map(s => {
                const f = s.assignments[i];
                return f === m.src ? el("td.muted", "stays") : el("td.strong", `→ ${label(f)}`);
            })));
        this.slackOut.append(el("h4", "Result per person"),
            best === total ? el("p.muted.small", `Everyone can move from ±${summary.find(s => s.moved === total).k}.`) : null,
            el("div.table-scroll.tall", el("table.data", el("thead", el("tr", el("th", "Person"), el("th", "Request"),
                summary.map(s => el("th", `±${s.k}`)))), el("tbody", rows))));
    }
}
