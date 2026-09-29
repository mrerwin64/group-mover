// Opened with ?selftest: drives the page through its features against the real library and reports the outcome
// in document.title ("SELFTEST PASS" / "SELFTEST FAIL") and in #selftest-result, so a headless browser can check it.
// The page doesn't save the input in this mode, so the input saved in the browser is left alone.

import {EXAMPLES, STATUS, parseMoveLines, parseGroupLines, parseMainInput, generateClass, compile, toMainInput,
    fromProjectJson, toProjectJson, verify} from "./model.js";

export async function selftest(hooks) {
    const results = [];
    const check = (name, ok, detail = "") => results.push({name, ok: Boolean(ok), detail: String(detail)});
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const waitUntil = async (condition, ms) => {
        for (const end = performance.now() + ms; performance.now() < end; await sleep(50)) {
            if (condition()) return true;
        }
        return condition();
    };
    hooks.setAutoRun(false);
    await sleep(50);

    try {
        // Parsing the formats people paste
        const real = parseMoveLines("4 -> 3\n10 -> 5 / 11\n11 -> 6+ / 9\nAnna: 3 -> 4\nBob Smith 5 1 2\nCleo\t7\t8 9\n# comment\n");
        check("parse: move count", real.moves.length === 6, real.moves.length);
        check("parse: arrow and slash", real.moves[1].src === "10" && real.moves[1].dst === "5 11", JSON.stringify(real.moves[1]));
        check("parse: preference mark kept", real.moves[2].dst === "6+ 9", real.moves[2].dst);
        check("parse: name with colon", real.moves[3].name === "Anna" && real.moves[3].src === "3", JSON.stringify(real.moves[3]));
        check("parse: multi-word name", real.moves[4].name === "Bob Smith" && real.moves[4].dst === "1 2", JSON.stringify(real.moves[4]));
        check("parse: tab separated", real.moves[5].name === "Cleo" && real.moves[5].dst === "8 9", JSON.stringify(real.moves[5]));
        const groups = parseGroupLines("1 14 15 16 Lab A\n2 15\n3 x");
        check("parse: groups", groups.groups.length === 2 && groups.groups[0].name === "Lab A" && groups.groups[1].max === "15"
            && groups.errors.length === 1, JSON.stringify(groups));
        const main = parseMainInput("42\n1 0 1 2\n2 0 1 2\n\n1 2\n\n");
        check("parse: main.cpp input", main.seed === "42" && main.groups.length === 2 && main.moves.length === 1, JSON.stringify(main.errors));
        const roundTrip = toMainInput({seed: "42"}, compile({seed: "42", groups: main.groups, moves: main.moves}));
        check("export: main.cpp input round trip", roundTrip === "42\n1 0 1 2\n2 0 1 2\n\n1 2\n\n", JSON.stringify(roundTrip));
        const project = fromProjectJson(toProjectJson({seed: "7", groups: main.groups, moves: main.moves}));
        check("export: project JSON round trip", project.seed === "7" && project.groups.length === 2 && project.moves[0].dst === "2");

        // Every example through the real library
        for (const example of EXAMPLES) {
            hooks.loadExample(example.id);
            const predicted = hooks.compile().predicted;
            await hooks.run();
            const run = hooks.lastRun;
            if (example.id === "invalid") {
                check(`example ${example.id}: rejected as predicted`, run && run.result.status !== STATUS.OK
                    && run.result.status === predicted, run && `${run.result.status} vs ${predicted}`);
                continue;
            }
            check(`example ${example.id}: ok`, run && run.result.status === STATUS.OK, run?.result.status_string);
            check(`example ${example.id}: verified`, run && run.problems.length === 0, run?.problems.join("; "));
        }
        hooks.loadExample("cycle");
        await hooks.run();
        const cycle = hooks.lastRun.analysis;
        check("cycle: three of four move", cycle.totals.moved === 3, cycle.totals.moved);
        check("cycle: Dana stays", !cycle.people.find(p => p.name === "Dana").moved);

        hooks.loadExample("chain");
        hooks.applySlack(0);
        await hooks.run();
        check("chain without slack: nobody moves", hooks.lastRun.analysis.totals.moved === 0, hooks.lastRun.analysis.totals.moved);
        hooks.applySlack(1);
        await hooks.run();
        check("chain with slack 1: everyone moves", hooks.lastRun.analysis.totals.moved === 4, hooks.lastRun.analysis.totals.moved);

        // The big example moves more people with every step of slack (numbers from generate_big_class.py)
        hooks.loadExample("big");
        hooks.setSeed("12345");
        const bigCurve = [];
        for (const k of [0, 2, 5, 10]) {
            hooks.applySlack(k);
            await hooks.run();
            bigCurve.push(hooks.lastRun.analysis.totals.moved);
        }
        check("big example: 43, 60, 78, 100 move at ±0, 2, 5, 10", bigCurve.join(",") === "43,60,78,100", bigCurve.join(","));

        // Same seed, same answer; the result only depends on input and seed
        hooks.loadState({...generateClass({groups: 14, size: 15, slack: 1, people: 60, maxOptions: 3, seed: 5}), seed: "99"});
        await hooks.run();
        const first = hooks.lastRun.result.assignments.join(",");
        await hooks.run();
        check("deterministic for a seed", hooks.lastRun.result.assignments.join(",") === first);
        check("generated class verified", verify(hooks.lastRun.analysis).length === 0);

        // Every view renders without errors
        for (const tab of ["graph", "flow", "matrix", "people", "groups-out", "analysis"]) {
            hooks.selectOutput(tab);
            await sleep(30);
        }
        hooks.selectOutput("graph");
        await sleep(30);
        const nodes = document.querySelectorAll("#graph .node").length;
        check("graph: one node per group", nodes === 14, nodes);
        check("graph: arrows drawn", document.querySelectorAll("#graph .edge-moved").length > 0);
        const graph = hooks.views.graph;
        const someGroup = [...graph.analysis.groups.keys()][0];
        graph.select({type: "node", id: someGroup});
        check("graph: selecting a group shows it", document.querySelector("#details h3")?.textContent.includes(String(someGroup)),
            document.querySelector("#details")?.textContent.slice(0, 80));
        check("graph: selection dims the rest", document.querySelector("#graph svg").classList.contains("has-focus"));
        const someEdge = [...graph.analysis.edges.values()].find(e => e.moved.length);
        graph.select({type: "edge", key: someEdge.key});
        check("graph: selecting an arrow lists who moved", document.querySelectorAll("#details .people-list li").length >= someEdge.moved.length);
        graph.select(null);
        for (const mode of ["grid", "circle"]) graph.setLayout(mode);
        check("graph: layouts keep every group", document.querySelectorAll("#graph .node").length === 14);
        graph.setLayout("swim");
        check("graph: swim starts moving", graph.simulating);
        const settled = await waitUntil(() => !graph.simulating, 20000);
        check("graph: swim settles", settled, `alpha ${graph.sim.alpha.toFixed(4)} target ${graph.sim.alphaTarget}`);
        let closest = Infinity;
        const ids = [...graph.analysis.groups.keys()];
        for (let i = 0; i < ids.length; i++) {
            for (let j = i + 1; j < ids.length; j++) {
                const p = graph.positions.get(ids[i]), q = graph.positions.get(ids[j]);
                closest = Math.min(closest, Math.hypot(p.x - q.x, p.y - q.y) - graph.radii.get(ids[i]) - graph.radii.get(ids[j]));
            }
        }
        check("graph: swim leaves room between groups", closest > 20, closest.toFixed(1));
        const drawn = document.querySelector(`#graph .node[data-id="${ids[0]}"]`).getAttribute("transform");
        const p0 = graph.positions.get(ids[0]);
        check("graph: drawing follows the simulation", drawn === `translate(${p0.x.toFixed(1)},${p0.y.toFixed(1)})`, drawn);
        const svgText = graph.standaloneSvg().text;
        check("graph: SVG export", svgText.startsWith("<svg") && svgText.includes("xmlns"), svgText.slice(0, 40));
        hooks.selectOutput("flow");
        await sleep(30);
        check("flow: bands drawn", document.querySelectorAll("#flow .band").length > 0);
        hooks.selectOutput("matrix");
        check("matrix: table", document.querySelectorAll("#matrix td.filled").length > 0);
        hooks.selectOutput("people");
        check("people: one row per person", document.querySelectorAll("#people tbody tr").length === 60);
        hooks.selectOutput("groups-out");
        check("groups: one row per group", document.querySelectorAll("#groups-out tbody tr").length === 14);

        // Analysis tools
        hooks.selectOutput("analysis");
        const analysis = hooks.views.analysisView;
        analysis.seedCount.value = "60";
        await analysis.runSeedStudy();
        const tiles = [...document.querySelectorAll("#analysis .tile-value")].map(t => t.textContent);
        check("seed study: moved count is seed independent", tiles.length >= 4 && /^\d+$/.test(tiles[0]), tiles.join(" | "));
        analysis.slackMax.value = "2";
        await analysis.runSlackSweep();
        const sweepRows = document.querySelectorAll("#analysis .card:nth-child(2) table.data")[0]?.tBodies[0].rows.length;
        check("slack sweep: one row per slack", sweepRows === 3, sweepRows);

        // The import tab and the editors, through the DOM like a person would
        hooks.loadState({seed: "5", groups: [], moves: []});
        hooks.selectInput("io");
        document.getElementById("io-text").value = "Ann: 1 -> 2\nBen: 2 -> 1 / 3\n";
        document.getElementById("create-missing").checked = true;
        document.getElementById("missing-size").value = "10";
        document.getElementById("missing-slack").value = "0";
        document.getElementById("import-moves-replace").click();
        check("import: moves and missing groups", hooks.state.moves.length === 2 && hooks.state.groups.length === 3
            && hooks.state.groups[2].max === "10", JSON.stringify(hooks.state.groups));
        await hooks.run();
        check("import: swap happens", hooks.lastRun?.analysis.totals.moved === 2, hooks.lastRun?.analysis.totals.moved);
        hooks.selectInput("moves");
        const dst = document.querySelector('#moves-table input[data-row="1"][data-field="dst"]');
        dst.value = "3";
        dst.dispatchEvent(new Event("input", {bubbles: true}));
        check("editor: typing updates the input", hooks.state.moves[1].dst === "3");
        await hooks.run();
        check("editor: result follows the edit", hooks.lastRun.analysis.totals.moved === 0, hooks.lastRun.analysis.totals.moved);
        check("editor: result column filled", document.querySelectorAll("#moves-table td.result .badge").length === 2);
        const src = document.querySelector('#moves-table input[data-row="0"][data-field="src"]');
        src.value = "x";
        src.dispatchEvent(new Event("input", {bubbles: true}));
        check("editor: bad cell is marked", src.classList.contains("invalid") && document.querySelector("#problems .problem-error"));

        // Input problems are caught before the library is called
        hooks.loadState({seed: "1", groups: [], moves: []});
        hooks.state.groups.push(...parseGroupLines("1 5 5 5\n1 5 5 5").groups);
        hooks.state.moves.push(...parseMoveLines("1 2").moves);
        const c = hooks.compile();
        check("problems: duplicate group predicted", c.predicted === STATUS.INVALID_GROUP, c.predicted);
        hooks.loadState({seed: "abc", groups: parseGroupLines("1 5").groups, moves: []});
        check("problems: bad seed blocks the run", !hooks.compile().ok);
        hooks.loadExample("options");
        await hooks.run();
    } catch (e) {
        check("no exceptions", false, e.stack || e.message);
    }
    const pageErrors = window.__uiErrors || [];
    check("no page errors", pageErrors.length === 0, pageErrors.join("; "));

    const failed = results.filter(r => !r.ok);
    const report = results.map(r => `${r.ok ? "PASS" : "FAIL"} ${r.name}${r.ok || !r.detail ? "" : ` -- ${r.detail}`}`).join("\n");
    const out = document.getElementById("selftest-result");
    out.textContent = `${failed.length ? "SELFTEST FAIL" : "SELFTEST PASS"} (${results.length - failed.length}/${results.length})\n${report}`;
    out.hidden = false;
    document.title = failed.length ? "SELFTEST FAIL" : "SELFTEST PASS";
    console.log(out.textContent);
}
