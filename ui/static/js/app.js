// Wires the editors, the library calls and the result views together

import {el, clear, debounce, storage, isValidSeed, randomSeed, addToSeed, download, copyText, plural, percent,
    formatTime, formatMs, toBase64Url, fromBase64Url, parseInteger} from "./util.js";
import {STATUS, compile, analyze, verify, makeGroup, makeMove, emptyState, parseMoveLines, parseGroupLines,
    parseMainInput, toMainInput, toGroupLines, toMoveLines, toProjectJson, fromProjectJson, resultsCsv, EXAMPLES,
    generateClass, groupLookup, parseDestinations} from "./model.js";
import {api} from "./api.js";
import {GraphView} from "./graph.js";
import {FlowView} from "./flow.js";
import {renderDetails, renderMatrix, PeopleView, renderGroups, AnalysisView} from "./views.js";

const STATE_KEY = "group-mover-ui.state";
const PREFS_KEY = "group-mover-ui.prefs";
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------------------------------------------
// Errors in this page are shown, not swallowed

window.addEventListener("error", (e) => showFatal(e.message));
window.addEventListener("unhandledrejection", (e) => showFatal(e.reason?.message || String(e.reason)));
function showFatal(message) {
    const banner = $("error-banner");
    banner.hidden = false;
    banner.textContent = `Something went wrong in the page: ${message}`;
    window.__uiErrors = (window.__uiErrors || []).concat(message);
}

// ---------------------------------------------------------------------------------------------------------------
// State

let state = emptyState();
let prefs = {autoRun: true, theme: "auto", inputTab: "moves", outputTab: "graph", leftWidth: null};
let compiled = compile(state);
let lastRun = null;          // {signature, compiled, result, analysis, byKey, predicted}
let running = false;
let rerun = false;
let libraryInfo = null;

const signatureOf = (c, seed) => JSON.stringify([c.request, String(seed).trim()]);
const isStale = () => !lastRun || !compiled.ok || lastRun.signature !== signatureOf(compiled, state.seed);

function groupLabel(id) {
    const name = compiled.groupNames?.get(id) || lastRun?.compiled.groupNames.get(id);
    return name ? `${id} · ${name}` : String(id);
}

function loadInitialState() {
    try {
        const saved = JSON.parse(storage.get(PREFS_KEY) || "null");
        if (saved) prefs = {...prefs, ...saved};
    } catch { /* ignored */ }
    const hash = location.hash.match(/^#data=(.+)$/);
    if (hash) {
        try {
            state = fromProjectJson(fromBase64Url(hash[1]));
            history.replaceState(null, "", location.pathname + location.search);
            toast("Loaded the input from the link");
            return;
        } catch (e) {
            toast(`The link's data couldn't be read: ${e.message}`, "error");
        }
    }
    const saved = storage.get(STATE_KEY);
    if (saved) {
        try {
            state = fromProjectJson(saved);
            return;
        } catch { /* fall through to the example */ }
    }
    loadExample("options", false);
}

// The self-test replaces the input many times; it must not overwrite what the user saved
const selftestMode = new URLSearchParams(location.search).has("selftest");
const saveState = debounce(() => { if (!selftestMode) storage.set(STATE_KEY, toProjectJson(state)); }, 300);
const savePrefs = () => { if (!selftestMode) storage.set(PREFS_KEY, JSON.stringify(prefs)); };

// ---------------------------------------------------------------------------------------------------------------
// Toasts and modals

function toast(message, kind = "info") {
    const item = el("div.toast", {class: `toast toast-${kind}`, role: kind === "error" ? "alert" : "status"}, message);
    $("toasts").append(item);
    setTimeout(() => item.classList.add("leaving"), 3600);
    setTimeout(() => item.remove(), 4000);
}

function modal({title, body, actions}) {
    return new Promise((resolve) => {
        const root = $("modal-root");
        const previous = document.activeElement;
        const close = (value) => {
            overlay.remove();
            document.removeEventListener("keydown", onKey);
            previous?.focus?.();
            resolve(value);
        };
        const onKey = (e) => { if (e.key === "Escape") close(null); };
        const buttons = actions.map(a => el("button", {type: "button", class: a.primary ? "primary" : a.danger ? "danger" : "ghost",
            on: {click: () => close(a.value ?? a.label)}}, a.label));
        const dialog = el("div.modal", {role: "dialog", "aria-modal": "true", "aria-label": title},
            el("h2", title), el("div.modal-body", body), el("div.modal-actions", buttons));
        const overlay = el("div.modal-overlay", {on: {click: (e) => { if (e.target === overlay) close(null); }}}, dialog);
        root.append(overlay);
        document.addEventListener("keydown", onKey);
        (dialog.querySelector("input, select, textarea") || buttons[buttons.length - 1])?.focus();
    });
}

async function confirmAction(title, text, label = "Continue", danger = false) {
    const answer = await modal({title, body: el("p", text), actions: [
        {label: "Cancel", value: false}, {label, value: true, primary: !danger, danger}]});
    return answer === true;
}

// ---------------------------------------------------------------------------------------------------------------
// Tabs

function setupTabs(name, onChange) {
    const nav = document.querySelector(`[data-tabs="${name}"]`);
    const panels = nav.nextElementSibling;
    const buttons = [...nav.querySelectorAll("[data-tab]")];
    const select = (tab, focus = false) => {
        for (const b of buttons) {
            const active = b.dataset.tab === tab;
            b.setAttribute("aria-selected", String(active));
            b.tabIndex = active ? 0 : -1;
            if (active && focus) b.focus();
        }
        for (const p of panels.querySelectorAll(":scope > [data-panel]")) p.hidden = p.dataset.panel !== tab;
        onChange(tab);
    };
    buttons.forEach((b, i) => {
        b.addEventListener("click", () => select(b.dataset.tab));
        b.addEventListener("keydown", (e) => {
            const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
            if (d) select(buttons[(i + d + buttons.length) % buttons.length].dataset.tab, true);
        });
    });
    return select;
}

// ---------------------------------------------------------------------------------------------------------------
// Editors

const groupFields = ["id", "name", "min", "current", "max"];
const moveFields = ["name", "src", "dst"];

function renderGroupEditor() {
    const body = $("groups-table").tBodies[0];
    clear(body);
    state.groups.forEach((g, row) => {
        const cells = groupFields.map(field => el("td", el("input.cell", {
            value: g[field], dataset: {row: String(row), field}, "aria-label": `Group ${row + 1} ${field}`,
            inputMode: field === "name" ? "text" : "numeric", class: `cell cell-${field}`, spellcheck: "false",
            placeholder: field === "name" ? "optional" : "",
        })));
        body.append(el("tr", {dataset: {row: String(row)}}, cells,
            el("td.actions", el("button.icon.small", {type: "button", title: "Remove this group", "aria-label": `Remove group ${row + 1}`,
                on: {click: () => removeRow("groups", row)}}, "×"))));
    });
    if (state.groups.length === 0) {
        body.append(el("tr.empty-row", el("td", {colspan: "6"}, "No groups. Add one, load an example, or import some.")));
    }
    $("groups-count").textContent = String(state.groups.length);
    markIssues();
}

function renderMoveEditor() {
    const body = $("moves-table").tBodies[0];
    clear(body);
    state.moves.forEach((m, row) => {
        const cells = moveFields.map(field => el("td", el("input.cell", {
            value: m[field], dataset: {row: String(row), field}, "aria-label": `Move ${row + 1} ${field}`,
            class: `cell cell-${field}`, spellcheck: "false", placeholder: field === "name" ? `#${row + 1}` : "",
        })));
        body.append(el("tr", {dataset: {row: String(row), key: String(m.key)}},
            el("td.num.muted", String(row + 1)), cells, el("td.result", {dataset: {key: String(m.key)}}),
            el("td.actions", el("button.icon.small", {type: "button", title: "Remove this move", "aria-label": `Remove move ${row + 1}`,
                on: {click: () => removeRow("moves", row)}}, "×"))));
    });
    if (state.moves.length === 0) {
        body.append(el("tr.empty-row", el("td", {colspan: "6"}, "No moves. Add one or paste a list on the Import tab.")));
    }
    $("moves-count").textContent = String(state.moves.length);
    applyMoveFilter();
    renderMoveResults();
    markIssues();
}

function renderMoveResults() {
    const stale = isStale();
    for (const cell of document.querySelectorAll("#moves-table td.result")) {
        const final = lastRun?.byKey.get(Number(cell.dataset.key));
        clear(cell);
        cell.classList.toggle("stale", stale);
        if (final === undefined) continue;
        cell.append(final.moved ? el("span.badge.badge-moved", `→ ${final.label}`) : el("span.badge.badge-stayed", "stays"));
    }
}

function applyMoveFilter() {
    const q = $("move-filter").value.trim().toLowerCase();
    for (const tr of $("moves-table").tBodies[0].rows) {
        if (!tr.dataset.row) continue;
        const m = state.moves[Number(tr.dataset.row)];
        tr.hidden = q !== "" && ![m.name, m.src, m.dst].join(" ").toLowerCase().includes(q);
    }
}

function removeRow(kind, row) {
    state[kind].splice(row, 1);
    kind === "groups" ? renderGroupEditor() : renderMoveEditor();
    changed();
}

function addGroup(focus = true) {
    const ids = state.groups.map(g => parseInteger(g.id)).filter(x => x !== null);
    const last = state.groups[state.groups.length - 1];
    const id = ids.length ? Math.max(...ids) + 1 : 1;
    state.groups.push(last ? makeGroup(id, last.min, last.current, last.max) : makeGroup(id, 14, 15, 16));
    renderGroupEditor();
    changed();
    if (focus) focusCell("groups", state.groups.length - 1, "name");
}

function addMove(focus = true) {
    state.moves.push(makeMove("", "", ""));
    renderMoveEditor();
    changed();
    if (focus) focusCell("moves", state.moves.length - 1, "name");
}

function focusCell(kind, row, field) {
    selectInputTab(kind);
    const input = document.querySelector(`#${kind}-table input[data-row="${row}"][data-field="${field}"]`);
    if (input) {
        input.closest("tr").hidden = false;
        input.focus();
        input.select?.();
        input.scrollIntoView({block: "nearest"});
    }
}

function setupEditors() {
    for (const [kind, table] of [["groups", $("groups-table")], ["moves", $("moves-table")]]) {
        table.addEventListener("input", (e) => {
            const input = e.target;
            if (!input.dataset.field) return;
            state[kind][Number(input.dataset.row)][input.dataset.field] = input.value;
            changed({soft: true});
        });
        table.addEventListener("keydown", (e) => {
            const input = e.target;
            if (!input.dataset?.field || e.key !== "Enter" || e.ctrlKey || e.metaKey) return;
            e.preventDefault();
            const row = Number(input.dataset.row) + (e.shiftKey ? -1 : 1);
            if (row < 0) return;
            if (row >= state[kind].length) kind === "groups" ? addGroup(false) : addMove(false);
            focusCell(kind, row, input.dataset.field);
        });
        // Typing only re-checks the input; the views catch up when a cell is left (or when auto-run runs)
        table.addEventListener("change", () => { if (!prefs.autoRun || !compiled.ok) refreshViews(); });
    }
    $("group-add").addEventListener("click", () => addGroup());
    $("move-add").addEventListener("click", () => addMove());
    $("move-filter").addEventListener("input", applyMoveFilter);
    $("slack-apply").addEventListener("click", () => {
        const k = parseInteger($("slack-k").value);
        if (k === null || k < 0) { toast("Slack must be a whole number ≥ 0", "error"); return; }
        applySlack(k);
    });
    $("group-sort").addEventListener("click", () => {
        state.groups.sort((a, b) => (parseInteger(a.id) ?? Infinity) - (parseInteger(b.id) ?? Infinity));
        renderGroupEditor();
        changed();
    });
    $("group-clear").addEventListener("click", async () => {
        if (state.groups.length && !await confirmAction("Remove all groups?", `This removes ${plural(state.groups.length, "group")}.`, "Remove", true)) return;
        state.groups = [];
        renderGroupEditor();
        changed();
    });
    $("move-clear").addEventListener("click", async () => {
        if (state.moves.length && !await confirmAction("Remove all moves?", `This removes ${plural(state.moves.length, "move")}.`, "Remove", true)) return;
        state.moves = [];
        renderMoveEditor();
        changed();
    });
}

function applySlack(k) {
    let count = 0;
    for (const g of state.groups) {
        const current = parseInteger(g.current);
        if (current === null) continue;
        g.min = String(Math.max(0, current - k));
        g.max = String(current + k);
        count += 1;
    }
    renderGroupEditor();
    changed();
    toast(`Bounds set to current ± ${k} for ${plural(count, "group")}`);
}

// Red outlines and tooltips on the cells that have problems
function markIssues() {
    for (const input of document.querySelectorAll("table.editor input.cell")) {
        input.classList.remove("invalid", "warn");
        input.removeAttribute("title");
        input.removeAttribute("aria-invalid");
    }
    for (const issue of compiled.issues) {
        if (issue.kind !== "group" && issue.kind !== "move") continue;
        if (issue.severity === "info") continue;
        const table = issue.kind === "group" ? "groups-table" : "moves-table";
        const input = document.querySelector(`#${table} input[data-row="${issue.index}"][data-field="${issue.field}"]`);
        if (!input) continue;
        input.classList.add(issue.blocking ? "invalid" : "warn");
        input.setAttribute("aria-invalid", "true");
        input.title = input.title ? `${input.title}\n${issue.message}` : issue.message;
    }
    $("seed").classList.toggle("invalid", !isValidSeed(state.seed));
}

function renderProblems() {
    const list = $("problems");
    clear(list);
    const issues = compiled.issues;
    const errors = issues.filter(i => i.severity === "error");
    const infos = issues.filter(i => i.severity === "info");
    const predicted = compiled.predicted;
    let summary = errors.length ? plural(errors.length, "problem") : "No problems";
    if (infos.length) summary += ` · ${plural(infos.length, "note")}`;
    if (predicted !== null && predicted !== STATUS.OK) {
        const name = libraryInfo?.statuses.find(s => s.code === predicted);
        summary += ` · the library will return “${name ? name.string : predicted}”`;
    }
    if (!compiled.ok) summary += " · can't run until fixed";
    $("problem-summary").textContent = summary;
    for (const issue of [...errors, ...infos].slice(0, 200)) {
        const where = issue.kind === "group" ? `Group row ${issue.index + 1}` : issue.kind === "move" ? `Move ${issue.index + 1}` : "";
        const item = el("li", {class: `problem problem-${issue.severity}`},
            el("span.problem-icon", {"aria-hidden": "true"}, issue.severity === "error" ? "✖" : "ℹ"),
            el("span.sr-only", issue.severity === "error" ? "Error: " : "Note: "),
            where ? el("button.link", {type: "button", on: {click: () => {
                if (issue.kind === "group") focusCell("groups", issue.index, issue.field || "id");
                else focusCell("moves", issue.index, issue.field || "src");
            }}}, where) : null,
            where ? ": " : "", issue.message);
        list.append(item);
    }
    $("problems").closest(".problems").classList.toggle("has-errors", errors.length > 0);
}

// ---------------------------------------------------------------------------------------------------------------
// Running the library

const scheduleAutoRun = debounce(() => { if (prefs.autoRun) run(); }, 350);

function changed({soft = false} = {}) {
    compiled = compile(state);
    saveState();
    if (soft) {
        markIssues();
        renderProblems();
        updateStatus();
        renderMoveResults();
    } else {
        refreshViews();
    }
    if (prefs.autoRun && compiled.ok) scheduleAutoRun();
    else refreshSummary();
}

async function run() {
    scheduleAutoRun.cancel();
    compiled = compile(state);
    if (!compiled.ok) {
        refreshViews();
        setStatus("Fix the input", "error");
        return;
    }
    if (running) { rerun = true; return; }
    running = true;
    setStatus("Running…", "busy");
    const snapshot = compiled;
    const seed = String(state.seed).trim();
    try {
        const response = await api.solve(snapshot.request, [seed]);
        const result = response.results[0];
        const analysis = analyze(snapshot, result.status === STATUS.OK ? result.assignments : null);
        const byKey = new Map();
        if (analysis.hasResult) {
            for (const p of analysis.people) {
                byKey.set(state.moves[p.row]?.key, {moved: p.moved, label: groupLabel(p.final)});
            }
        }
        lastRun = {signature: signatureOf(snapshot, seed), compiled: snapshot, result, analysis, byKey,
            elapsed: response.elapsed_ms, seed, problems: analysis.hasResult ? verify(analysis) : []};
    } catch (e) {
        lastRun = null;
        setStatus(e.message, "error");
        toast(e.message, "error");
    } finally {
        running = false;
    }
    refreshViews();
    if (rerun) { rerun = false; run(); }
}

function setStatus(text, kind) {
    const pill = $("status");
    pill.textContent = text;
    pill.className = `status-pill status-${kind}`;
}

function updateStatus() {
    if (running) return;
    if (!compiled.ok) return setStatus("Fix the input", "error");
    if (!lastRun) return setStatus("Not run yet", "idle");
    if (isStale()) return setStatus("Input changed", "stale");
    const r = lastRun.result;
    if (r.status !== STATUS.OK) return setStatus(r.status_string, "error");
    setStatus(`${lastRun.analysis.totals.moved} of ${lastRun.analysis.totals.people} moved`, "ok");
}

// What the views show: the last run, or (before any run / after an error) the requests on their own
function currentAnalysis() {
    if (lastRun && lastRun.analysis.hasResult) return lastRun.analysis;
    return compiled.request.groups.length || compiled.request.moves.length ? analyze(compiled, null) : null;
}

let views = null;
let activeOutput = "graph";

function refreshViews() {
    compiled = compile(state);
    markIssues();
    renderProblems();
    updateStatus();
    renderMoveResults();
    refreshSummary();
    const analysis = currentAnalysis();
    views.analysis = analysis;
    drawActiveOutput();
}

function drawActiveOutput() {
    const analysis = views.analysis;
    if (activeOutput === "graph") views.graph.update(analysis || analyze(compile(emptyState()), null));
    else if (activeOutput === "flow") views.flow.update(analysis);
    else if (activeOutput === "matrix") renderMatrix($("matrix"), analysis, groupLabel);
    else if (activeOutput === "people") views.people.update(analysis, exportResultsCsv);
    else if (activeOutput === "groups-out") renderGroups($("groups-out"), analysis, groupLabel);
}

function refreshSummary() {
    const box = $("summary");
    clear(box);
    const stale = isStale();
    if (!lastRun) {
        box.append(el("div.summary-empty", compiled.ok
            ? el("span", "Press ", el("kbd", "Run"), " (or Ctrl+Enter) to let the library choose the moves.")
            : el("span", "Fix the problems on the left, then run the library.")));
        return;
    }
    const r = lastRun.result;
    if (r.status !== STATUS.OK) {
        box.append(el("div.summary-error", el("strong", `The library returned ${r.status_name} (${r.status})`),
            el("span", `“${r.status_string}”`),
            lastRun.compiled.predicted !== r.status ? el("span.muted.small",
                ` — the UI expected ${lastRun.compiled.predicted}; the header and the library may disagree`) : null));
        return;
    }
    const t = lastRun.analysis.totals;
    const tile = (label, value, note, cls = "") => el("div.tile", {class: `tile ${cls}`}, el("div.tile-label", label),
        el("div.tile-value", value), note ? el("div.tile-note", note) : null);
    box.append(el("div.tiles",
        tile("Moved", `${t.moved} / ${t.people}`, t.people ? percent(t.moved / t.people) + " of requests" : ""),
        tile("Stayed", String(t.stayed)),
        tile("Size change", String(t.absDelta), `${plural(t.changed, "group")} changed`),
        tile("Checked", lastRun.problems.length ? "✖ " + plural(lastRun.problems.length, "problem") : "✓ valid",
            lastRun.problems.length ? lastRun.problems[0] : "choices and bounds respected",
            lastRun.problems.length ? "tile-bad" : "tile-good")),
    el("div.summary-meta",
        el("span.muted.small", `Seed ${lastRun.seed} · ${formatMs(lastRun.elapsed)}`),
        stale ? el("span.badge.badge-warn", {title: "The input or seed changed after this run"}, "⚠ out of date") : null,
        el("span.spacer"),
        stale ? el("button.small", {type: "button", on: {click: run}}, "Run again") : null,
        el("button.ghost.small", {type: "button", title: "Run with the next seed", on: {click: () => stepSeed(1, true)}}, "Next seed"),
        el("button.ghost.small", {type: "button", disabled: stale || t.moved === 0,
            title: "Make the moves permanent: update current sizes and remove the people who moved",
            on: {click: applyResult}}, "Apply moves…")));
}

async function applyResult() {
    if (!lastRun || isStale()) return;
    const a = lastRun.analysis;
    const ok = await confirmAction("Apply these moves?",
        `Current sizes become the sizes after the moves, and the ${plural(a.totals.moved, "person", "people")} who moved ` +
        `${a.totals.moved === 1 ? "is" : "are"} removed from the move list. The ${a.totals.stayed} who stayed keep their requests.`,
        "Apply");
    if (!ok) return;
    const rowsMoved = new Set(a.people.filter(p => p.moved).map(p => p.row));
    lastRun.compiled.groupRows.forEach((row, k) => {
        const g = a.groups.get(lastRun.compiled.request.groups[k].id);
        if (g && state.groups[row]) state.groups[row].current = String(g.after);
    });
    state.moves = state.moves.filter((_, row) => !rowsMoved.has(row));
    lastRun = null;
    renderGroupEditor();
    renderMoveEditor();
    changed();
    toast(`Applied ${plural(a.totals.moved, "move")}`);
}

function exportResultsCsv() {
    if (!lastRun?.analysis.hasResult) { toast("Run the library first", "error"); return; }
    download("group-mover-results.csv", resultsCsv(lastRun.analysis, groupLabel), "text/csv");
}

// ---------------------------------------------------------------------------------------------------------------
// Seed

function setSeed(value, runNow = false) {
    state.seed = value;
    $("seed").value = value;
    changed();
    if (runNow && !prefs.autoRun) run();
}

function stepSeed(delta, runNow = false) {
    if (!isValidSeed(state.seed)) { toast("The seed is not a valid number", "error"); return; }
    setSeed(addToSeed(state.seed.trim(), delta), runNow);
}

function setupSeed() {
    const input = $("seed");
    input.value = state.seed;
    input.addEventListener("input", () => { state.seed = input.value; changed({soft: true}); refreshSummary(); });
    $("seed-prev").addEventListener("click", () => stepSeed(-1, true));
    $("seed-next").addEventListener("click", () => stepSeed(1, true));
    $("seed-random").addEventListener("click", () => setSeed(randomSeed(), true));
}

// ---------------------------------------------------------------------------------------------------------------
// Import / export

function missingGroupsFor(moves) {
    if (!$("create-missing").checked) return [];
    const size = parseInteger($("missing-size").value) ?? 15;
    const slack = parseInteger($("missing-slack").value) ?? 0;
    const known = new Set(state.groups.map(g => parseInteger(g.id)).filter(x => x !== null));
    const byName = groupLookup(state.groups);
    const needed = new Set();
    for (const m of moves) {
        const src = parseInteger(m.src);
        if (src !== null && !known.has(src)) needed.add(src);
        for (const d of parseDestinations(m.dst, byName).ids) if (!known.has(d)) needed.add(d);
    }
    return [...needed].sort((a, b) => a - b).map(id => makeGroup(id, Math.max(0, size - slack), size, size + slack));
}

function showImportErrors(errors) {
    const list = $("io-errors");
    clear(list);
    for (const e of errors.slice(0, 50)) list.append(el("li", e));
    if (errors.length > 50) list.append(el("li", `…and ${errors.length - 50} more`));
}

function setupImportExport() {
    const text = () => $("io-text").value;
    const importMoves = (append) => {
        const names = new Set(state.groups.map(g => g.name.trim().toLowerCase()).filter(Boolean));
        const {moves, errors} = parseMoveLines(text(), names);
        showImportErrors(errors);
        if (!moves.length) { toast("No moves found in the text", "error"); return; }
        const extra = missingGroupsFor(moves);
        state.groups.push(...extra);
        state.moves = append ? state.moves.concat(moves) : moves;
        renderGroupEditor();
        renderMoveEditor();
        changed();
        toast(`Imported ${plural(moves.length, "move")}` + (extra.length ? ` and created ${plural(extra.length, "group")}` : "") +
            (errors.length ? ` (${plural(errors.length, "line")} skipped)` : ""), errors.length ? "warn" : "info");
    };
    $("import-moves-replace").addEventListener("click", () => importMoves(false));
    $("import-moves-append").addEventListener("click", () => importMoves(true));
    $("import-groups").addEventListener("click", () => {
        const {groups, errors} = parseGroupLines(text());
        showImportErrors(errors);
        if (!groups.length) { toast("No groups found in the text", "error"); return; }
        state.groups = groups;
        renderGroupEditor();
        changed();
        toast(`Imported ${plural(groups.length, "group")}`);
    });
    $("import-main").addEventListener("click", () => {
        const parsed = parseMainInput(text());
        showImportErrors(parsed.errors);
        if (!parsed.groups.length && !parsed.moves.length) { toast("Nothing found in the text", "error"); return; }
        state.groups = parsed.groups;
        state.moves = parsed.moves;
        if (/^\d+$/.test(parsed.seed)) state.seed = parsed.seed;
        $("seed").value = state.seed;
        renderGroupEditor();
        renderMoveEditor();
        changed();
        toast(`Loaded ${plural(parsed.groups.length, "group")} and ${plural(parsed.moves.length, "move")}`);
    });
    const mainText = () => {
        if (!compiled.ok) { toast("Fix the problems first; main.cpp can't read them either", "error"); return null; }
        return toMainInput(state, compiled);
    };
    $("export-main-copy").addEventListener("click", async () => {
        const t = mainText();
        if (t !== null) toast(await copyText(t) ? "Copied; paste it into group_mover" : "Copying failed", "info");
    });
    $("export-main-file").addEventListener("click", () => {
        const t = mainText();
        if (t !== null) download("group-mover-input.txt", t);
    });
    $("export-moves-text").addEventListener("click", () => { $("io-text").value = toMoveLines(state); });
    $("export-groups-text").addEventListener("click", () => { $("io-text").value = toGroupLines(state); });
    $("export-json").addEventListener("click", () => download("group-mover-project.json", toProjectJson(state), "application/json"));
    $("import-json").addEventListener("change", async (e) => {
        const file = e.target.files[0];
        e.target.value = "";
        if (!file) return;
        try {
            loadState(fromProjectJson(await file.text()));
            toast(`Opened ${file.name}`);
        } catch (err) {
            toast(`Couldn't open ${file.name}: ${err.message}`, "error");
        }
    });
    $("export-link").addEventListener("click", async () => {
        const url = `${location.origin}${location.pathname}#data=${toBase64Url(toProjectJson(state))}`;
        toast(await copyText(url) ? "Link copied (it only works while this server runs)" : "Copying failed");
    });
    $("generate").addEventListener("click", openGenerator);
}

function loadState(next) {
    state = {...emptyState(), ...next};
    $("seed").value = state.seed;
    lastRun = null;
    renderGroupEditor();
    renderMoveEditor();
    changed();
}

async function openGenerator() {
    const field = (label, name, value, min, max) => el("label.field", el("span", label),
        el("input", {type: "number", name, value: String(value), min: String(min), max: String(max)}));
    const body = el("div.form-grid",
        field("Groups", "groups", 14, 2, 200), field("Group size", "size", 15, 0, 10000),
        field("Slack (±)", "slack", 1, 0, 1000), field("People who want to move", "people", 22, 1, 20000),
        field("Most options per person", "maxOptions", 3, 1, 20), field("Generator seed", "seed", Math.floor(Math.random() * 1e6), 0, 2 ** 31));
    const answer = await modal({title: "Generate a random class", body: [el("p.muted", "Replaces the current groups and moves."), body],
        actions: [{label: "Cancel", value: null}, {label: "Generate", value: "go", primary: true}]});
    if (answer !== "go") return;
    const values = {};
    for (const input of body.querySelectorAll("input")) values[input.name] = Number(input.value);
    loadState(generateClass(values));
    toast(`Generated ${plural(values.groups, "group")} and ${plural(values.people, "move")}`);
}

function loadExample(id, announce = true) {
    const example = EXAMPLES.find(e => e.id === id);
    if (!example) return;
    const built = example.build();
    state = {...emptyState(), seed: state.seed || "12345", ...built};
    lastRun = null;
    if (announce) toast(example.description);
}

// ---------------------------------------------------------------------------------------------------------------
// Library info and rebuilding

async function refreshLibraryInfo() {
    try {
        libraryInfo = await api.info();
    } catch (e) {
        $("library-info").textContent = e.message;
        $("library-info").classList.add("error-text");
        return;
    }
    $("library-info").classList.remove("error-text");
    const lib = libraryInfo.library;
    const parts = [el("span", `Library ${lib.path.split(/[\\/]/).slice(-3).join("/")}`, el("span.muted", ` · built ${formatTime(lib.built_at)}`))];
    if (lib.sources_changed) parts.push(el("span.badge.badge-warn", {title: "group-mover.cpp or .h is newer than the loaded library"},
        "⚠ sources changed; rebuild to use them"));
    clear($("library-info")).append(...parts);
    $("rebuild").hidden = !lib.can_rebuild;
    $("rebuild").classList.toggle("attention", lib.sources_changed);
    renderProblems();
}

async function rebuild() {
    const button = $("rebuild");
    button.disabled = true;
    button.textContent = "Rebuilding…";
    try {
        const result = await api.rebuild();
        if (result.ok) {
            toast("Library rebuilt and loaded");
            await refreshLibraryInfo();
            lastRun = null;
            run();
        } else {
            await modal({title: result.error, body: el("pre.log", result.log || "(no output)"), actions: [{label: "Close", primary: true}]});
        }
    } catch (e) {
        toast(e.message, "error");
    } finally {
        button.disabled = false;
        button.textContent = "Rebuild library";
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Theme and layout

function applyTheme() {
    const root = document.documentElement;
    if (prefs.theme === "auto") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", prefs.theme);
    const names = {auto: "follow system", light: "light", dark: "dark"};
    $("theme").title = `Theme: ${names[prefs.theme]} (click to change)`;
    // Colours are read by the graph export; redraw so they match
    if (views) drawActiveOutput();
}

function setupSplitter() {
    const layout = $("layout");
    const splitter = $("splitter");
    if (prefs.leftWidth) layout.style.setProperty("--left-width", `${prefs.leftWidth}px`);
    let dragging = false;
    splitter.addEventListener("pointerdown", (e) => { dragging = true; splitter.setPointerCapture(e.pointerId); });
    splitter.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const box = layout.getBoundingClientRect();
        const width = Math.min(box.width - 360, Math.max(320, e.clientX - box.left));
        prefs.leftWidth = Math.round(width);
        layout.style.setProperty("--left-width", `${prefs.leftWidth}px`);
    });
    splitter.addEventListener("pointerup", () => { dragging = false; savePrefs(); });
    splitter.addEventListener("keydown", (e) => {
        const d = e.key === "ArrowLeft" ? -24 : e.key === "ArrowRight" ? 24 : 0;
        if (!d) return;
        const current = prefs.leftWidth || $("layout").querySelector(".pane-input").getBoundingClientRect().width;
        prefs.leftWidth = Math.max(320, current + d);
        layout.style.setProperty("--left-width", `${prefs.leftWidth}px`);
        savePrefs();
    });
}

let selectInputTab = () => {};

// ---------------------------------------------------------------------------------------------------------------
// Start

function init() {
    loadInitialState();
    compiled = compile(state);
    // ?theme=light|dark and ?view=<output tab> open the page in a given state (handy for links and screenshots)
    const params = new URLSearchParams(location.search);
    if (["auto", "light", "dark"].includes(params.get("theme"))) prefs.theme = params.get("theme");
    if (params.get("view") && document.querySelector(`[data-tabs="output"] [data-tab="${CSS.escape(params.get("view"))}"]`)) {
        prefs.outputTab = params.get("view");
    }

    for (const example of EXAMPLES) $("examples").append(el("option", {value: example.id}, example.title));
    $("examples").addEventListener("change", async (e) => {
        const id = e.target.value;
        e.target.value = "";
        if (!id) return;
        if ((state.groups.length || state.moves.length) &&
            !await confirmAction("Load the example?", "It replaces the current groups and moves.", "Load")) return;
        loadExample(id);
        loadState(state);
    });

    views = {
        graph: new GraphView($("graph"), {groupLabel, onSelect: (sel) => renderDetails($("details"), views?.analysis, sel, groupLabel)}),
        flow: new FlowView($("flow"), {groupLabel}),
        people: new PeopleView($("people"), {groupLabel, onPick: (row) => focusCell("moves", row, "dst")}),
        analysisView: new AnalysisView($("analysis"), {
            groupLabel,
            runSeeds: (request, seeds) => api.solve(request, seeds),
            getCompiled: () => compile(state),
            getSeed: () => (isValidSeed(state.seed) ? state.seed.trim() : "0"),
            applySlack: (k) => { applySlack(k); },
        }),
        analysis: null,
    };

    selectInputTab = setupTabs("input", (tab) => { prefs.inputTab = tab; savePrefs(); });
    const selectOutputTab = setupTabs("output", (tab) => {
        activeOutput = tab;
        prefs.outputTab = tab;
        savePrefs();
        if (views.analysis !== undefined) drawActiveOutput();
    });

    setupEditors();
    setupSeed();
    setupImportExport();
    setupSplitter();

    $("auto-run").checked = prefs.autoRun;
    $("auto-run").addEventListener("change", (e) => {
        prefs.autoRun = e.target.checked;
        savePrefs();
        if (prefs.autoRun && isStale()) run();
    });
    $("run").addEventListener("click", run);
    $("theme").addEventListener("click", () => {
        prefs.theme = {auto: "light", light: "dark", dark: "auto"}[prefs.theme] || "auto";
        savePrefs();
        applyTheme();
    });
    $("rebuild").addEventListener("click", rebuild);
    document.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); }
    });

    applyTheme();
    renderGroupEditor();
    renderMoveEditor();
    selectInputTab(prefs.inputTab);
    selectOutputTab(prefs.outputTab);
    refreshViews();

    refreshLibraryInfo().then(() => {
        if (prefs.autoRun && compiled.ok) run();
    });
    setInterval(() => { if (!document.hidden) refreshLibraryInfo(); }, 5000);

    if (selftestMode) import("./selftest.js").then(m => m.selftest(testHooks));
}

// Used by selftest.js to drive the page the way a person would
const testHooks = {
    get state() { return state; },
    get lastRun() { return lastRun; },
    get views() { return views; },
    loadExample: (id) => { loadExample(id, false); loadState(state); },
    loadState,
    run,
    setSeed,
    applySlack,
    selectOutput: (tab) => document.querySelector(`[data-tabs="output"] [data-tab="${tab}"]`).click(),
    selectInput: (tab) => document.querySelector(`[data-tabs="input"] [data-tab="${tab}"]`).click(),
    compile: () => compile(state),
    setAutoRun: (on) => { prefs.autoRun = on; $("auto-run").checked = on; },
};

init();
