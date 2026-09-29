// Editor state, validation that mirrors the C API, result analysis, import/export and examples.
//
// Editor values are kept as the text the user typed, so half-typed input never disappears;
// compile() turns them into the numbers sent to the library and reports every problem it finds.

import {parseInteger, INT32_MIN, INT32_MAX, isValidSeed, makeRng} from "./util.js";
import {BIG_CLASS} from "./big-class.js";

export const STATUS = {
    OK: 0, NULL_ARGUMENT: 1, INVALID_GROUP: 2, OUT_OF_MEMORY: 3, INTERNAL_ERROR: 4,
    NO_DESTINATION: 5, SELF_MOVE: 6, INVALID_MOVE: 7, NO_GROUPS: 8,
};

let nextKey = 1;
export const newKey = () => nextKey++;

export function makeGroup(id = "", min = "", current = "", max = "", name = "") {
    return {key: newKey(), id: String(id), name, min: String(min), current: String(current), max: String(max)};
}

export function makeMove(src = "", dst = "", name = "") {
    return {key: newKey(), name, src: String(src), dst: Array.isArray(dst) ? dst.join(" ") : String(dst)};
}

export function emptyState() {
    return {groups: [], moves: [], seed: "12345"};
}

// ---------------------------------------------------------------------------------------------------------------
// Parsing

// Group names can be used instead of ids anywhere a group is referenced
export function groupLookup(groups) {
    const byName = new Map();
    for (const g of groups) {
        const id = parseInteger(g.id);
        const name = g.name.trim().toLowerCase();
        if (id !== null && name) {
            if (byName.has(name) && byName.get(name) !== id) byName.set(name, null); // Ambiguous
            else byName.set(name, id);
        }
    }
    return byName;
}

export function resolveGroupToken(token, byName) {
    const n = parseInteger(token);
    if (n !== null) return n;
    const id = byName.get(token.trim().toLowerCase());
    return id === undefined ? null : id;
}

// "3 / 5+, 7" -> tokens; a trailing "+" marks a preferred destination (shown, but not used by the library yet)
export function splitDestinations(text) {
    return String(text).split(/[\s,/;|]+/).filter(t => t.length > 0 && t !== "->" && t !== "+");
}

export function parseDestinations(text, byName) {
    const ids = [];
    const preferred = [];
    const bad = [];
    for (const raw of splitDestinations(text)) {
        const isPreferred = raw.endsWith("+");
        const token = isPreferred ? raw.slice(0, -1) : raw;
        const id = resolveGroupToken(token, byName);
        if (id === null) bad.push(raw);
        else {
            ids.push(id);
            preferred.push(isPreferred);
        }
    }
    return {ids, preferred, bad};
}

export function personLabel(move, index) {
    return move.name && move.name.trim() ? move.name.trim() : `#${index + 1}`;
}

// ---------------------------------------------------------------------------------------------------------------
// compile(): editor state -> API input + problems.
// Problems with severity "error" and blocking: true stop the run (the input can't be represented);
// API problems are listed in the order the library checks them, so predicted.code is what it should return.

export function compile(state) {
    const issues = [];
    const add = (issue) => issues.push({severity: "error", blocking: false, ...issue});
    const byName = groupLookup(state.groups);

    const groups = [];
    state.groups.forEach((g, i) => {
        const fields = {id: parseInteger(g.id), min: parseInteger(g.min), current: parseInteger(g.current),
            max: parseInteger(g.max)};
        let ok = true;
        for (const [field, value] of Object.entries(fields)) {
            if (value === null) {
                add({kind: "group", index: i, field, blocking: true,
                    message: `${field === "id" ? "Id" : field[0].toUpperCase() + field.slice(1)}` +
                        (String(state.groups[i][field]).trim() ? " is not an integer (or is too large)" : " is empty")});
                ok = false;
            }
        }
        if (!ok) return;
        if (fields.id < INT32_MIN || fields.id > INT32_MAX) {
            add({kind: "group", index: i, field: "id", blocking: true, message: "Id does not fit in int32_t"});
            ok = false;
        }
        for (const field of ["min", "current", "max"]) {
            if (fields[field] < 0) {
                add({kind: "group", index: i, field, blocking: true, message: "Sizes can't be negative (size_t)"});
                ok = false;
            }
        }
        if (ok) groups.push({index: i, id: fields.id, min_size: fields.min, current_size: fields.current,
            max_size: fields.max});
    });

    const moves = [];
    const preferred = [];
    state.moves.forEach((m, i) => {
        const src = resolveGroupToken(m.src, byName);
        let ok = true;
        if (src === null) {
            add({kind: "move", index: i, field: "src", blocking: true,
                message: m.src.trim() ? `"${m.src.trim()}" is neither a group id nor a group name` : "Source is empty"});
            ok = false;
        } else if (src < INT32_MIN || src > INT32_MAX) {
            add({kind: "move", index: i, field: "src", blocking: true, message: "Source does not fit in int32_t"});
            ok = false;
        }
        const dst = parseDestinations(m.dst, byName);
        if (dst.bad.length) {
            add({kind: "move", index: i, field: "dst", blocking: true,
                message: `Unknown destination${dst.bad.length > 1 ? "s" : ""}: ${dst.bad.join(", ")}`});
            ok = false;
        }
        if (dst.ids.some(d => d < INT32_MIN || d > INT32_MAX)) {
            add({kind: "move", index: i, field: "dst", blocking: true, message: "A destination does not fit in int32_t"});
            ok = false;
        }
        if (ok) {
            moves.push({index: i, src, dst: dst.ids});
            preferred.push(dst.preferred);
        }
    });

    const blocked = issues.some(x => x.blocking);

    // The library's own checks, in its order
    const apiIssues = [];
    const api = (code, issue) => apiIssues.push({code, ...issue});
    if (!blocked) {
        if (moves.length > 0 && groups.length === 0) {
            api(STATUS.NO_GROUPS, {kind: "general", message: "There are moves but no groups"});
        }
        const seen = new Map();
        for (const g of groups) {
            if (g.current_size < g.min_size || g.current_size > g.max_size) {
                api(STATUS.INVALID_GROUP, {kind: "group", index: g.index, field: "current",
                    message: `Current size ${g.current_size} is outside [${g.min_size}, ${g.max_size}]`});
            }
            if (g.max_size > INT32_MAX) {
                api(STATUS.INVALID_GROUP, {kind: "group", index: g.index, field: "max",
                    message: "Max size exceeds INT32_MAX"});
            }
            if (seen.has(g.id)) {
                api(STATUS.INVALID_GROUP, {kind: "group", index: g.index, field: "id",
                    message: `Group ${g.id} is listed twice (also row ${seen.get(g.id) + 1})`});
            } else {
                seen.set(g.id, g.index);
            }
        }
        for (const m of moves) {
            if (!seen.has(m.src)) {
                api(STATUS.INVALID_MOVE, {kind: "move", index: m.index, field: "src",
                    message: `Source group ${m.src} is not in the group list`});
            }
            if (m.dst.length === 0) {
                api(STATUS.NO_DESTINATION, {kind: "move", index: m.index, field: "dst", message: "No destinations"});
            }
            for (const d of m.dst) {
                if (d === m.src) {
                    api(STATUS.SELF_MOVE, {kind: "move", index: m.index, field: "dst",
                        message: `Destination ${d} is the person's own group`});
                } else if (!seen.has(d)) {
                    api(STATUS.INVALID_MOVE, {kind: "move", index: m.index, field: "dst",
                        message: `Destination group ${d} is not in the group list`});
                }
            }
        }
        // With no moves the library returns OK without looking at anything
        if (moves.length === 0) apiIssues.length = 0;
    }
    // The library stops at the first problem; for moves, the first problem of the first bad move
    const predicted = blocked ? null : (apiIssues.length ? apiIssues[0].code : STATUS.OK);
    for (const issue of apiIssues) add({...issue, severity: "error"});

    // Harmless things worth knowing about
    if (!blocked) {
        const used = new Set();
        for (const m of moves) {
            used.add(m.src);
            m.dst.forEach(d => used.add(d));
            if (new Set(m.dst).size !== m.dst.length) {
                add({kind: "move", index: m.index, field: "dst", severity: "info",
                    message: "Lists a destination more than once (allowed, has no effect)"});
            }
        }
        for (const g of groups) {
            if (!used.has(g.id) && moves.length > 0) {
                add({kind: "group", index: g.index, field: "id", severity: "info",
                    message: `Group ${g.id} is not used by any move`});
            }
        }
        if (state.moves.length === 0) {
            add({kind: "general", severity: "info", message: "No moves yet; add some on the Moves tab"});
        }
    }
    if (!isValidSeed(state.seed)) {
        add({kind: "general", field: "seed", blocking: true, message: "The seed must be an integer in [0, 2^64 - 1]"});
    }

    return {
        ok: !issues.some(x => x.blocking),
        predicted,
        issues,
        request: {
            groups: groups.map(({id, min_size, current_size, max_size}) => ({id, min_size, current_size, max_size})),
            moves: moves.map(({src, dst}) => ({src, dst})),
        },
        // For the result views: names and preference marks next to what was sent
        groupNames: new Map(groups.map(g => [g.id, state.groups[g.index].name.trim()])),
        groupRows: groups.map(g => g.index),
        people: moves.map((m, k) => ({row: m.index, name: personLabel(state.moves[m.index], m.index),
            preferred: preferred[k]})),
    };
}

// ---------------------------------------------------------------------------------------------------------------
// Result analysis: everything the views draw, derived from what was sent and what came back

export function analyze(compiled, assignments) {
    const {request} = compiled;
    const groups = new Map();
    request.groups.forEach((g, order) => {
        groups.set(g.id, {
            id: g.id, order, name: compiled.groupNames.get(g.id) || "",
            min: g.min_size, current: g.current_size, max: g.max_size,
            after: g.current_size, out: 0, in: 0, wantOut: 0, wantIn: 0,
        });
    });
    const people = request.moves.map((m, i) => {
        const final = assignments ? assignments[i] : null;
        return {
            index: i, row: compiled.people[i].row, name: compiled.people[i].name,
            preferred: compiled.people[i].preferred, src: m.src, dst: m.dst, final,
            moved: final !== null && final !== m.src,
        };
    });
    const edges = new Map();
    const edge = (a, b) => {
        const key = `${a}>${b}`;
        if (!edges.has(key)) edges.set(key, {key, a, b, moved: [], stayed: [], elsewhere: []});
        return edges.get(key);
    };
    for (const p of people) {
        const src = groups.get(p.src);
        if (src) src.wantOut += 1;
        for (const d of new Set(p.dst)) {
            const dst = groups.get(d);
            if (dst) dst.wantIn += 1;
            const e = edge(p.src, d);
            if (p.final === null) e.stayed.push(p.index); // Not run yet: every request is just a request
            else if (p.final === d) e.moved.push(p.index);
            else if (p.moved) e.elsewhere.push(p.index);
            else e.stayed.push(p.index);
        }
        if (p.moved) {
            const s = groups.get(p.src);
            const f = groups.get(p.final);
            if (s) { s.out += 1; s.after -= 1; }
            if (f) { f.in += 1; f.after += 1; }
        }
    }
    let moved = 0, absDelta = 0, changed = 0, outOfBounds = 0;
    for (const p of people) if (p.moved) moved += 1;
    for (const g of groups.values()) {
        g.delta = g.after - g.current;
        absDelta += Math.abs(g.delta);
        if (g.delta !== 0) changed += 1;
        if (g.after < g.min || g.after > g.max) outOfBounds += 1;
    }
    return {
        groups, people, edges,
        hasResult: assignments !== null && assignments !== undefined,
        totals: {people: people.length, moved, stayed: people.length - moved, absDelta, changed, outOfBounds},
    };
}

// A check of the library's answer that doesn't trust the library: valid assignments and bounds kept
export function verify(analysis) {
    const problems = [];
    for (const p of analysis.people) {
        if (p.final !== p.src && !p.dst.includes(p.final)) {
            problems.push(`${p.name} was assigned to ${p.final}, which they didn't ask for`);
        }
    }
    for (const g of analysis.groups.values()) {
        if (g.after < g.min || g.after > g.max) {
            problems.push(`Group ${g.id} ends with ${g.after}, outside [${g.min}, ${g.max}]`);
        }
    }
    return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// Import and export

const isIntToken = (t) => /^[+-]?\d+$/.test(t);

// One move per line. Accepted forms (a trailing + marks a preferred destination):
//   4 3            4 -> 3 / 5+          Anna: 4 -> 3        Anna<TAB>4<TAB>3 5        Anna 4 3
export function parseMoveLines(text, knownNames = new Set()) {
    const moves = [];
    const errors = [];
    text.split(/\r?\n/).forEach((line, n) => {
        const trimmed = line.replace(/#.*$/, "").trim();
        if (!trimmed) return;
        let name = "";
        let rest = trimmed;
        const explicit = trimmed.match(/^([^:\t]*?[^\s:\t\d+-][^:\t]*?)\s*[:\t]\s*(.*)$/);
        if (explicit) {
            name = explicit[1].trim();
            rest = explicit[2];
        }
        rest = rest.replace(/->|→|=>/g, " ").replace(/[\t:]/g, " ");
        let tokens = splitDestinations(rest);
        if (!explicit && tokens.length > 0 && !isIntToken(tokens[0].replace(/\+$/, ""))
            && !knownNames.has(tokens[0].toLowerCase())) {
            // A leading word that isn't a group: the person's name, possibly several words
            const firstGroup = tokens.findIndex(t => isIntToken(t.replace(/\+$/, "")) || knownNames.has(t.toLowerCase()));
            if (firstGroup > 0) {
                name = tokens.slice(0, firstGroup).join(" ");
                tokens = tokens.slice(firstGroup);
            }
        }
        if (tokens.length < 2) {
            errors.push(`Line ${n + 1}: expected a source and at least one destination: "${line.trim()}"`);
            return;
        }
        moves.push(makeMove(tokens[0], tokens.slice(1).join(" "), name));
    });
    return {moves, errors};
}

// One group per line: "id min current max [name]", or "id size [name]" (bounds = size)
export function parseGroupLines(text) {
    const groups = [];
    const errors = [];
    text.split(/\r?\n/).forEach((line, n) => {
        const trimmed = line.replace(/#.*$/, "").trim();
        if (!trimmed) return;
        const tokens = trimmed.split(/[\s,;]+/);
        const numbers = [];
        while (numbers.length < 4 && numbers.length < tokens.length && isIntToken(tokens[numbers.length])) {
            numbers.push(tokens[numbers.length]);
        }
        const name = tokens.slice(numbers.length).join(" ");
        if (numbers.length === 4) {
            groups.push(makeGroup(numbers[0], numbers[1], numbers[2], numbers[3], name));
        } else if (numbers.length === 2) {
            groups.push(makeGroup(numbers[0], numbers[1], numbers[1], numbers[1], name));
        } else {
            errors.push(`Line ${n + 1}: expected "id min current max [name]" or "id size [name]": "${line.trim()}"`);
        }
    });
    return {groups, errors};
}

// The exact stdin format of main.cpp: seed line, group lines, blank line, move lines, blank line
export function parseMainInput(text) {
    const lines = text.split(/\r?\n/);
    const errors = [];
    let i = 0;
    while (i < lines.length && !lines[i].trim()) i++;
    const seed = (lines[i] ?? "").trim();
    if (!/^\d+$/.test(seed)) errors.push(`Line ${i + 1}: expected the seed, got "${seed}"`);
    i++;
    const groupLines = [];
    for (; i < lines.length && lines[i].trim(); i++) groupLines.push(lines[i]);
    i++;
    const moveLines = [];
    for (; i < lines.length && lines[i].trim(); i++) moveLines.push(lines[i]);
    const g = parseGroupLines(groupLines.join("\n"));
    const m = parseMoveLines(moveLines.join("\n"));
    return {seed, groups: g.groups, moves: m.moves, errors: [...errors, ...g.errors, ...m.errors]};
}

export function toMainInput(state, compiled) {
    const lines = [String(state.seed).trim()];
    for (const g of compiled.request.groups) lines.push(`${g.id} ${g.min_size} ${g.current_size} ${g.max_size}`);
    lines.push("");
    for (const m of compiled.request.moves) lines.push(`${m.src} ${m.dst.join(" ")}`);
    lines.push("");
    return lines.join("\n") + "\n";
}

export function toGroupLines(state) {
    return state.groups.map(g => [g.id, g.min, g.current, g.max, g.name].filter(x => x !== "").join(" ")).join("\n");
}

export function toMoveLines(state) {
    return state.moves.map(m => {
        const core = `${m.src} -> ${splitDestinations(m.dst).join(" / ")}`;
        return m.name.trim() ? `${m.name.trim()}: ${core}` : core;
    }).join("\n");
}

export function toProjectJson(state) {
    return JSON.stringify({
        format: "group-mover-ui",
        version: 1,
        seed: state.seed,
        groups: state.groups.map(({id, name, min, current, max}) => ({id, name, min, current, max})),
        moves: state.moves.map(({name, src, dst}) => ({name, src, dst})),
    }, null, 2);
}

export function fromProjectJson(text) {
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.groups) || !Array.isArray(data.moves)) {
        throw new Error("Not a group-mover project (expected groups and moves arrays)");
    }
    const str = (v) => v === undefined || v === null ? "" : String(v);
    return {
        seed: str(data.seed ?? "12345"),
        groups: data.groups.map(g => makeGroup(str(g.id), str(g.min ?? g.min_size), str(g.current ?? g.current_size),
            str(g.max ?? g.max_size), str(g.name))),
        moves: data.moves.map(m => makeMove(str(m.src), Array.isArray(m.dst) ? m.dst.join(" ") : str(m.dst),
            str(m.name))),
    };
}

export function resultsCsv(analysis, groupLabel) {
    const quote = (s) => /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    const rows = [["person", "from", "wants", "result", "moved"]];
    for (const p of analysis.people) {
        rows.push([p.name, groupLabel(p.src), p.dst.map(groupLabel).join(" / "),
            p.final === null ? "" : groupLabel(p.final), p.moved ? "yes" : "no"]);
    }
    return rows.map(r => r.map(x => quote(String(x))).join(",")).join("\n") + "\n";
}

// ---------------------------------------------------------------------------------------------------------------
// Examples

const G = (id, min, current, max, name = "") => makeGroup(id, min, current, max, name);
const M = (src, dst, name = "") => makeMove(src, dst, name);

export const EXAMPLES = [
    {
        id: "big",
        title: "Big class (15 groups, 100 people)",
        description: "Midday slots are popular, early and late ones aren't. With ±0, 43 people move; each extra step " +
            "of slack lets more through, until all 100 move at ±10. Try Analysis → Slack sweep, or change the bounds.",
        build: () => ({
            groups: BIG_CLASS.groups.map(([id, name, n]) => G(id, Math.max(0, n - 2), n, n + 2, name)),
            moves: BIG_CLASS.moves.map(([person, src, dst]) => M(src, dst.join(" "), person)),
        }),
    },
    {
        id: "cycle",
        title: "Three-way cycle",
        description: "A\u2192B\u2192C\u2192A can all happen; the extra A\u2192C cannot without breaking sizes.",
        build: () => ({
            groups: [G(1, 10, 10, 10, "A"), G(2, 10, 10, 10, "B"), G(3, 10, 10, 10, "C")],
            moves: [M(1, 2, "Ada"), M(2, 3, "Brian"), M(3, 1, "Chen"), M(1, 3, "Dana")],
        }),
    },
    {
        id: "options",
        title: "People with several options",
        description: "Everyone lists acceptable groups; the library picks one per person so the most people move.",
        build: () => ({
            groups: [G(1, 12, 12, 12, "Mon AM"), G(2, 12, 12, 12, "Mon PM"), G(3, 12, 12, 12, "Tue AM"),
                G(4, 12, 12, 12, "Tue PM")],
            moves: [M(1, "2 3", "Ola"), M(2, "4", "Piotr"), M(3, "1", "Kasia"), M(4, "1 2", "Marek"),
                M(1, "4", "Zofia"), M(2, "3 1", "Jan"), M(3, "4 2", "Ewa"), M(4, "3", "Tomek")],
        }),
    },
    {
        id: "slack",
        title: "Slack in group sizes",
        description: "Groups may grow or shrink by one, so one-way moves become possible.",
        build: () => ({
            groups: [G(1, 14, 15, 16, "Lab 1"), G(2, 14, 15, 16, "Lab 2"), G(3, 15, 15, 15, "Lab 3 (full)"),
                G(4, 14, 15, 16, "Lab 4")],
            moves: [M(1, "2", "Ann"), M(1, "2", "Ben"), M(3, "4", "Cleo"), M(2, "3", "Dev"), M(4, "1 3", "Eli"),
                M(1, "3", "Fay")],
        }),
    },
    {
        id: "chain",
        title: "Long chain, both ends",
        description: "1\u21922\u21923\u21924\u21925 is a chain, not a cycle; it only happens if the ends may change size.",
        build: () => ({
            groups: [G(1, 9, 10, 11), G(2, 10, 10, 10), G(3, 10, 10, 10), G(4, 10, 10, 10), G(5, 9, 10, 11)],
            moves: [M(1, 2), M(2, 3), M(3, 4), M(4, 5)],
        }),
    },
    {
        id: "invalid",
        title: "Invalid input (diagnostics)",
        description: "Shows how problems are reported before and after calling the library.",
        build: () => ({
            groups: [G(1, 5, 5, 5), G(2, 5, 7, 6, "too big"), G(3, 5, 5, 5)],
            moves: [M(1, "2"), M(2, "2 3", "self move"), M(3, "9", "unknown group"), M(1, "", "no destination")],
        }),
    },
];

// A class like the real one: n groups of about `size`, a few people each wanting 1-3 other groups
export function generateClass({groups = 14, size = 15, slack = 1, people = 22, maxOptions = 3, seed = 1} = {}) {
    const rng = makeRng(seed);
    const pick = (n) => Math.floor(rng() * n);
    const out = {groups: [], moves: []};
    for (let g = 1; g <= groups; g++) {
        out.groups.push(G(g, Math.max(0, size - slack), size, size + slack));
    }
    // Some groups are popular, which is what makes real requests unbalanced
    const weights = Array.from({length: groups}, () => 0.3 + rng() * rng() * 3);
    const total = weights.reduce((a, b) => a + b, 0);
    const weighted = () => {
        let r = rng() * total;
        for (let g = 0; g < groups; g++) {
            r -= weights[g];
            if (r <= 0) return g + 1;
        }
        return groups;
    };
    for (let p = 0; p < people && groups > 1; p++) {
        const src = 1 + pick(groups);
        const options = 1 + pick(Math.min(maxOptions, groups - 1));
        const dst = [];
        for (let tries = 0; dst.length < options && tries < 100; tries++) {
            const d = weighted();
            if (d !== src && !dst.includes(d)) dst.push(d);
        }
        out.moves.push(M(src, dst.join(" ")));
    }
    return out;
}
