// Group graph: groups are nodes, people are arrows from their group to the group they moved to.
// Requests that weren't granted are drawn dashed. Nodes can be dragged; the background pans; the wheel zooms.

import {el, svg, clear, signed, plural, download, storage} from "./util.js";
import {Simulation} from "./physics.js";

const LAYOUT_KEY = "group-mover-ui.graph-layout";
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export class GraphView {
    constructor(container, {groupLabel, onSelect}) {
        this.groupLabel = groupLabel;
        this.onSelect = onSelect || (() => {});
        this.analysis = null;
        this.positions = new Map();
        this.signature = "";
        const saved = storage.get(LAYOUT_KEY);
        this.layoutMode = ["swim", "circle", "grid"].includes(saved) ? saved : "swim";
        this.sim = new Simulation();
        this.frame = null;
        this.loop = this.loop.bind(this);
        this.view = {x: 0, y: 0, k: 1};
        this.highlight = null;   // {type: "node", id} | {type: "edge", key}
        this.selection = null;
        this.options = {unmet: true, counts: true, sizes: true};

        this.root = el("div.graph-view");
        const toggle = (key, label, title) => el("label.check", {title},
            el("input", {type: "checkbox", checked: this.options[key],
                on: {change: (e) => { this.options[key] = e.target.checked; this.draw(); }}}), label);
        this.layoutButtons = {};
        const layoutButton = (mode, label, title) => {
            const b = el("button.seg", {type: "button", title, on: {click: () => this.setLayout(mode, true)}}, label);
            this.layoutButtons[mode] = b;
            return b;
        };
        this.toolbar = el("div.toolbar",
            el("div.segmented", {role: "group", "aria-label": "Layout"},
                layoutButton("swim", "Swim", "Groups float into a readable arrangement and make room when you drag one. " +
                    "Click again to start over"),
                layoutButton("circle", "Circle", "Groups on a circle, in list order"),
                layoutButton("grid", "Grid", "Groups on a grid, in list order")),
            el("button.ghost", {type: "button", title: "Zoom to fit (double-click the background)",
                on: {click: () => this.fit(true)}}, "Fit"),
            el("span.toolbar-sep"),
            toggle("unmet", "Requests not granted", "Dashed arrows for people who stayed although they asked to move"),
            toggle("counts", "Counts", "Number of people on each arrow"),
            toggle("sizes", "Sizes", "Group sizes under each group"),
            el("span.spacer"),
            el("button.ghost", {type: "button", title: "Download the graph as SVG", on: {click: () => this.exportSvg()}}, "SVG"),
            el("button.ghost", {type: "button", title: "Download the graph as PNG", on: {click: () => this.exportPng()}}, "PNG"));

        this.svg = svg("svg", {class: "graph-svg", role: "img", "aria-label": "Graph of moves between groups"});
        this.defs = svg("defs");
        for (const kind of ["moved", "unmet"]) {
            const size = kind === "unmet" ? "7" : "9";
            this.defs.append(svg("marker", {id: `arrow-${kind}`, viewBox: "0 0 10 10", refX: "9", refY: "5",
                markerWidth: size, markerHeight: size, markerUnits: "userSpaceOnUse", orient: "auto-start-reverse"},
            svg("path", {d: "M0,0 L10,5 L0,10 z", class: `arrowhead arrowhead-${kind}`})));
        }
        this.viewport = svg("g", {class: "viewport"});
        this.layers = {
            unmet: svg("g", {class: "layer-unmet"}),
            moved: svg("g", {class: "layer-moved"}),
            labels: svg("g", {class: "layer-labels"}),
            nodes: svg("g", {class: "layer-nodes"}),
        };
        this.viewport.append(this.layers.unmet, this.layers.moved, this.layers.labels, this.layers.nodes);
        this.svg.append(this.defs, this.viewport);

        this.tooltip = el("div.tooltip", {role: "tooltip", hidden: true});
        this.empty = el("div.empty-state", {hidden: true});
        this.legend = el("div.legend",
            el("span.legend-item.after-run", el("span.key.key-moved"), "Moved"),
            el("span.legend-item.after-run", el("span.key.key-unmet"), "Asked, but stayed"),
            el("span.legend-item.before-run", el("span.key.key-unmet"), "Requested (not run yet)"),
            el("span.legend-item.after-run", el("span.key-ring.ring-grew"), "Grew"),
            el("span.legend-item.after-run", el("span.key-ring.ring-shrank"), "Shrank"),
            el("span.legend-item.after-run", el("span.key-ring.ring-same"), "Same size"));
        this.wrap = el("div.graph-wrap", this.svg, this.tooltip, this.empty, this.legend);
        this.root.append(this.toolbar, this.wrap);
        container.append(this.root);

        this.installInteraction();
        // Keep the whole graph in view when the pane resizes, until the user pans, zooms or drags
        this.resizeObserver = new ResizeObserver(() => { if (this.needsFit || !this.userView) this.fit(); });
        this.resizeObserver.observe(this.wrap);
        this.updateLayoutButtons();
    }

    // ------------------------------------------------------------------------------------------------------------
    update(analysis) {
        this.analysis = analysis;
        const signature = [...analysis.groups.keys()].join(",");
        let reheat = 0;
        if (signature !== this.signature) {
            reheat = this.signature === "" ? 1 : 0.6;
            this.signature = signature;
            this.applyLayout(this.layoutMode);
            this.needsFit = true;
        }
        if (this.selection && !this.selectionExists(this.selection)) this.selection = null;
        if (this.highlight && !this.selectionExists(this.highlight)) this.highlight = null;
        this.draw();
        if (this.needsFit) this.fit();
        if (this.layoutMode === "swim") {
            // New arrows change the forces: let the groups drift into their new places
            const links = this.linkSignature();
            if (links !== this.linksSeen) {
                if (this.linksSeen !== undefined) reheat = Math.max(reheat, 0.4);
                this.linksSeen = links;
            }
            this.startSimulation(reheat);
        }
        this.onSelect(this.selection);
    }

    selectionExists(sel) {
        if (!this.analysis) return false;
        return sel.type === "node" ? this.analysis.groups.has(sel.id) : this.analysis.edges.has(sel.key);
    }

    setLayout(mode, animate = false) {
        this.layoutMode = mode;
        storage.set(LAYOUT_KEY, mode);
        this.updateLayoutButtons();
        if (!this.analysis) return;
        if (mode === "swim") {
            // Clicking Swim (again) starts over from the circle, and the groups swim into place
            this.circleLayout([...this.analysis.groups.keys()]);
            for (const n of this.sim.nodes.values()) { n.vx = 0; n.vy = 0; }
            this.reposition();
            this.fit(true);
            this.linksSeen = this.linkSignature();
            this.startSimulation(1);
            return;
        }
        this.stopSimulation();
        const before = new Map([...this.positions].map(([k, v]) => [k, {...v}]));
        this.applyLayout(mode);
        if (animate && before.size) this.animateFrom(before);
        else { this.reposition(); this.fit(); }
    }

    updateLayoutButtons() {
        for (const [mode, button] of Object.entries(this.layoutButtons)) {
            button.classList.toggle("active", mode === this.layoutMode);
            button.setAttribute("aria-pressed", String(mode === this.layoutMode));
        }
    }

    animateFrom(before) {
        const after = new Map([...this.positions].map(([k, v]) => [k, {...v}]));
        const start = performance.now();
        const step = (now) => {
            const t = Math.min(1, (now - start) / 350);
            const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
            for (const [id, to] of after) {
                const from = before.get(id) || to;
                this.positions.set(id, {x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e});
            }
            this.reposition();
            if (t < 1) requestAnimationFrame(step);
            else this.fit(true);
        };
        requestAnimationFrame(step);
    }

    applyLayout(mode) {
        const ids = [...this.analysis.groups.keys()];
        if (mode === "grid") {
            const cols = Math.max(1, Math.ceil(Math.sqrt(ids.length * 1.4)));
            ids.forEach((id, i) => this.positions.set(id, {x: (i % cols) * 150, y: Math.floor(i / cols) * 130}));
            return;
        }
        if (mode === "swim" && ids.some(id => this.positions.has(id))) {
            // Keep the groups that are already placed; new ones start from their spot on the circle
            const placed = new Map(ids.filter(id => this.positions.has(id)).map(id => [id, this.positions.get(id)]));
            this.circleLayout(ids);
            for (const [id, p] of placed) this.positions.set(id, p);
            return;
        }
        this.circleLayout(ids);
    }

    circleLayout(ids) {
        const n = ids.length;
        const radius = Math.max(130, n * 15);
        ids.forEach((id, i) => {
            const angle = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(1, n);
            this.positions.set(id, {x: radius * Math.cos(angle), y: radius * Math.sin(angle)});
        });
    }

    // ------------------------------------------------------------------------------------------------------------
    // Swim: the force simulation in physics.js, one tick per animation frame until it settles

    get simulating() {
        return this.frame !== null;
    }

    // Undirected, weighted connections. After a run only the moves that happened pull groups together:
    // requests that weren't granted are drawn, but would crowd the layout. Before a run the requests are all there is.
    simulationLinks() {
        const weight = new Map();
        const ran = this.analysis.hasResult;
        for (const e of this.analysis.edges.values()) {
            if (e.a === e.b || !this.analysis.groups.has(e.a) || !this.analysis.groups.has(e.b)) continue;
            const key = e.a < e.b ? `${e.a}|${e.b}` : `${e.b}|${e.a}`;
            const w = ran ? e.moved.length : e.stayed.length;
            if (w > 0) weight.set(key, (weight.get(key) || 0) + w);
        }
        return [...weight].map(([key, w]) => {
            const [a, b] = key.split("|").map(Number);
            return {a, b, weight: w};
        });
    }

    linkSignature() {
        return JSON.stringify(this.simulationLinks());
    }

    startSimulation(alpha = 0) {
        if (this.layoutMode !== "swim" || !this.analysis || !this.radii) return;
        const nodes = [...this.analysis.groups.keys()].map(id => ({id, r: this.radii.get(id) || 20}));
        this.sim.setGraph(nodes, this.simulationLinks(), this.positions);
        const box = this.svg.getBoundingClientRect();
        if (box.width > 10 && box.height > 50) this.sim.aspect = box.width / (box.height - 34);
        if (alpha > 0) this.sim.reheat(alpha);
        if (!this.sim.running) return;
        if (reducedMotion() && this.sim.alphaTarget === 0) {
            // No animation: jump straight to the settled layout
            for (let i = 0; i < 600 && this.sim.running; i++) this.sim.tick();
            this.sim.alpha = 0;
            this.copyPositions();
            this.reposition();
            if (!this.userView) this.fit();
            return;
        }
        if (this.frame === null) {
            this.lastTick = performance.now();
            this.schedule();
        }
    }

    // Next frame, or a timer if frames are throttled (some browsers slow animation frames down a lot)
    schedule() {
        const run = () => {
            if (this.frame === null) return;
            cancelAnimationFrame(this.frame.raf);
            clearTimeout(this.frame.timer);
            this.loop();
        };
        this.frame = {raf: requestAnimationFrame(run), timer: setTimeout(run, 100)};
    }

    stopSimulation() {
        if (this.frame !== null) {
            cancelAnimationFrame(this.frame.raf);
            clearTimeout(this.frame.timer);
        }
        this.frame = null;
        this.sim.alpha = 0;
        this.sim.alphaTarget = 0;
    }

    loop() {
        this.frame = null;
        if (this.layoutMode !== "swim" || !this.wrap.isConnected) return;
        // Pause while the graph tab is hidden; update() resumes when it is shown again
        if (this.wrap.offsetParent === null) return;
        // One tick per 60th of a second, so the swim takes the same time at any frame rate
        const now = performance.now();
        const ticks = Math.max(1, Math.min(8, Math.round((now - this.lastTick) / 16.7)));
        this.lastTick = now;
        for (let i = 0; i < ticks && this.sim.running; i++) this.sim.tick();
        this.copyPositions();
        this.reposition();
        if (!this.userView && !this.dragging) this.follow();
        if (this.sim.running) this.schedule();
    }

    copyPositions() {
        for (const n of this.sim.nodes.values()) this.positions.set(n.id, {x: n.x, y: n.y});
    }

    // ------------------------------------------------------------------------------------------------------------
    radius(g, largest) {
        const size = this.analysis.hasResult ? g.after : g.current;
        return 16 + 14 * Math.sqrt(Math.max(0, size) / largest);
    }

    draw() {
        const a = this.analysis;
        for (const layer of Object.values(this.layers)) clear(layer);
        if (!a || a.groups.size === 0) {
            this.empty.hidden = false;
            this.empty.textContent = "Add groups and moves to see the graph.";
            this.legend.hidden = true;
            return;
        }
        this.empty.hidden = true;
        this.legend.hidden = false;
        this.legend.classList.toggle("pre-run", !a.hasResult);

        const largest = Math.max(1, ...[...a.groups.values()].map(x => Math.max(x.after, x.current)));
        const radii = new Map([...a.groups.values()].map(g => [g.id, this.radius(g, largest)]));
        // Kept so reposition() can move everything without rebuilding it (dragging, swimming)
        this.radii = radii;
        this.nodeEls = new Map();
        this.edgeEls = [];

        for (const e of a.edges.values()) {
            if (e.a === e.b) continue;
            const A = this.positions.get(e.a), B = this.positions.get(e.b);
            if (!A || !B) continue;
            const key = {dataset: {key: e.key}};
            // Before a run every request is drawn dashed; afterwards only the ones not granted
            const unmet = e.stayed.length;
            if (unmet > 0 && (this.options.unmet || !a.hasResult)) {
                const bend = a.hasResult ? 1.7 : 1;
                const geo = curve(A, B, radii.get(e.a), radii.get(e.b), bend);
                const hit = this.edgeHit(geo.d, e);
                const path = svg("path", {d: geo.d, class: "edge edge-unmet", ...key,
                    "marker-end": "url(#arrow-unmet)", "stroke-width": String(1.2 + 0.5 * Math.sqrt(unmet))});
                this.layers.unmet.append(hit, path);
                let label = null;
                if (this.options.counts && (unmet > 1 || !a.hasResult)) {
                    label = svg("text", {x: geo.label.x, y: geo.label.y, ...key,
                        class: "edge-count", "text-anchor": "middle", "dominant-baseline": "central"}, String(unmet));
                    this.layers.labels.append(label);
                }
                this.edgeEls.push({e, bend, hit, path, label, pill: false});
            }
            const moved = e.moved.length;
            if (moved > 0) {
                const geo = curve(A, B, radii.get(e.a), radii.get(e.b), 1);
                const hit = this.edgeHit(geo.d, e);
                const path = svg("path", {d: geo.d, class: "edge edge-moved", ...key,
                    "marker-end": "url(#arrow-moved)", "stroke-width": String(1.8 + 1.4 * Math.sqrt(moved))});
                this.layers.moved.append(hit, path);
                let label = null;
                if (this.options.counts) {
                    const text = String(moved);
                    const w = 8 + 7 * text.length;
                    label = svg("g", {class: "edge-pill", ...key,
                        transform: `translate(${geo.label.x.toFixed(1)},${geo.label.y.toFixed(1)})`},
                    svg("rect", {x: -w / 2, y: -9, width: w, height: 18, rx: 9}),
                    svg("text", {"text-anchor": "middle", "dominant-baseline": "central"}, text));
                    this.layers.labels.append(label);
                }
                this.edgeEls.push({e, bend: 1, hit, path, label, pill: true});
            }
        }

        for (const g of a.groups.values()) {
            const p = this.positions.get(g.id);
            if (!p) continue;
            const r = radii.get(g.id);
            const ring = !a.hasResult ? "ring-same" : g.delta > 0 ? "ring-grew" : g.delta < 0 ? "ring-shrank" : "ring-same";
            const out = a.hasResult && (g.after < g.min || g.after > g.max);
            const node = svg("g", {class: `node ${ring}${out ? " out-of-bounds" : ""}`,
                transform: `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`, tabindex: "0", role: "button",
                "aria-label": this.describeGroup(g), dataset: {id: String(g.id)}},
            svg("circle", {r: r + 6, class: "node-halo"}),
            svg("circle", {r, class: "node-circle"}),
            svg("text", {class: "node-id", "text-anchor": "middle", "dominant-baseline": "central"}, String(g.id)));
            let y = r + 16;
            if (g.name) {
                node.append(svg("text", {class: "node-name", y, "text-anchor": "middle"}, truncate(g.name, 22)));
                y += 15;
            }
            if (this.options.sizes) {
                const size = a.hasResult && g.delta !== 0 ? `${g.current} → ${g.after} (${signed(g.delta)})` : `${g.current}`;
                node.append(svg("text", {class: "node-size", y, "text-anchor": "middle"}, size));
            }
            node.addEventListener("pointerenter", (ev) => this.hover({type: "node", id: g.id}, ev));
            node.addEventListener("pointermove", (ev) => this.moveTooltip(ev));
            node.addEventListener("pointerleave", () => this.hover(null));
            node.addEventListener("pointerdown", (ev) => this.startDrag(ev, g.id));
            node.addEventListener("keydown", (ev) => {
                if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); this.select({type: "node", id: g.id}); }
                if (ev.key === "Escape") this.select(null);
            });
            this.layers.nodes.append(node);
            this.nodeEls.set(g.id, node);
        }
        this.applyHighlight();
        this.applyView();
    }

    // Moves the existing elements to the current positions
    reposition() {
        if (!this.nodeEls) return;
        for (const [id, node] of this.nodeEls) {
            const p = this.positions.get(id);
            if (p) node.setAttribute("transform", `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`);
        }
        for (const item of this.edgeEls) {
            const A = this.positions.get(item.e.a), B = this.positions.get(item.e.b);
            if (!A || !B) continue;
            const geo = curve(A, B, this.radii.get(item.e.a), this.radii.get(item.e.b), item.bend);
            item.path.setAttribute("d", geo.d);
            item.hit.setAttribute("d", geo.d);
            if (!item.label) continue;
            if (item.pill) item.label.setAttribute("transform", `translate(${geo.label.x.toFixed(1)},${geo.label.y.toFixed(1)})`);
            else {
                item.label.setAttribute("x", geo.label.x.toFixed(1));
                item.label.setAttribute("y", geo.label.y.toFixed(1));
            }
        }
    }

    // Hover and selection only change classes, so the elements (and keyboard focus) survive
    applyHighlight() {
        const a = this.analysis;
        if (!a) return;
        const hlNodes = new Set();
        const hlEdges = new Set();
        const focus = this.highlight || this.selection;
        if (focus?.type === "node") {
            hlNodes.add(focus.id);
            for (const e of a.edges.values()) {
                if (e.a === focus.id || e.b === focus.id) { hlEdges.add(e.key); hlNodes.add(e.a); hlNodes.add(e.b); }
            }
        } else if (focus?.type === "edge" && a.edges.has(focus.key)) {
            const e = a.edges.get(focus.key);
            hlEdges.add(e.key); hlNodes.add(e.a); hlNodes.add(e.b);
        }
        this.svg.classList.toggle("has-focus", Boolean(focus));
        for (const node of this.layers.nodes.children) {
            const id = Number(node.dataset.id);
            node.classList.toggle("hl", hlNodes.has(id));
            node.classList.toggle("selected", this.selection?.type === "node" && this.selection.id === id);
        }
        for (const item of this.viewport.querySelectorAll("[data-key]")) {
            item.classList.toggle("hl", hlEdges.has(item.dataset.key));
        }
    }

    edgeHit(d, e) {
        const hit = svg("path", {d, class: "edge-hit", dataset: {hit: e.key}});
        hit.addEventListener("pointerenter", (ev) => this.hover({type: "edge", key: e.key}, ev));
        hit.addEventListener("pointermove", (ev) => this.moveTooltip(ev));
        hit.addEventListener("pointerleave", () => this.hover(null));
        hit.addEventListener("click", (ev) => { ev.stopPropagation(); this.select({type: "edge", key: e.key}); });
        return hit;
    }

    describeGroup(g) {
        const parts = [`Group ${this.groupLabel(g.id)}`, `allowed ${g.min} to ${g.max}`];
        parts.push(this.analysis.hasResult ? `size ${g.current} to ${g.after}` : `size ${g.current}`);
        return parts.join(", ");
    }

    // ------------------------------------------------------------------------------------------------------------
    hover(target, ev) {
        if (this.dragging || this.panning) return;
        this.highlight = target;
        this.applyHighlight();
        if (!target) {
            this.tooltip.hidden = true;
            return;
        }
        clear(this.tooltip).append(...this.tooltipContent(target));
        this.tooltip.hidden = false;
        if (ev) this.moveTooltip(ev);
    }

    tooltipContent(target) {
        const a = this.analysis;
        const names = (list) => {
            const shown = list.slice(0, 8).map(i => a.people[i].name).join(", ");
            return list.length > 8 ? `${shown} +${list.length - 8} more` : shown;
        };
        if (target.type === "node") {
            const g = a.groups.get(target.id);
            if (!g) return [];
            const rows = [el("div.tt-title", `Group ${this.groupLabel(g.id)}`)];
            rows.push(el("div", `Size ${g.current}` + (a.hasResult && g.delta ? ` → ${g.after} (${signed(g.delta)})` : "")
                + `, allowed ${g.min}–${g.max}`));
            if (a.hasResult) rows.push(el("div", `${g.out} of ${g.wantOut} asking left · ${g.in} joined (${g.wantIn} asked)`));
            else rows.push(el("div", `${g.wantOut} want to leave · ${g.wantIn} would join`));
            return rows;
        }
        const e = a.edges.get(target.key);
        if (!e) return [];
        const rows = [el("div.tt-title", `${this.groupLabel(e.a)} → ${this.groupLabel(e.b)}`)];
        if (!a.hasResult) {
            rows.push(el("div", `${plural(e.stayed.length, "person", "people")} asked: ${names(e.stayed)}`));
            return rows;
        }
        if (e.moved.length) rows.push(el("div", `Moved (${e.moved.length}): ${names(e.moved)}`));
        if (e.stayed.length) rows.push(el("div.muted", `Asked but stayed (${e.stayed.length}): ${names(e.stayed)}`));
        if (e.elsewhere.length) rows.push(el("div.muted", `Got another choice (${e.elsewhere.length}): ${names(e.elsewhere)}`));
        return rows;
    }

    moveTooltip(ev) {
        if (this.tooltip.hidden) return;
        const box = this.wrap.getBoundingClientRect();
        const x = ev.clientX - box.left, y = ev.clientY - box.top;
        const w = this.tooltip.offsetWidth, h = this.tooltip.offsetHeight;
        const left = x + 14 + w > box.width ? x - 14 - w : x + 14;
        const top = y + 14 + h > box.height ? y - 14 - h : y + 14;
        this.tooltip.style.left = `${Math.max(4, left)}px`;
        this.tooltip.style.top = `${Math.max(4, top)}px`;
    }

    select(target) {
        this.selection = target;
        this.applyHighlight();
        this.onSelect(target);
    }

    // ------------------------------------------------------------------------------------------------------------
    installInteraction() {
        this.svg.addEventListener("pointerdown", (ev) => {
            if (ev.button !== 0 || ev.target.closest(".node") || ev.target.classList.contains("edge-hit")) return;
            this.panning = {x: ev.clientX, y: ev.clientY, vx: this.view.x, vy: this.view.y, moved: false};
            this.svg.setPointerCapture(ev.pointerId);
            this.svg.classList.add("panning");
        });
        this.svg.addEventListener("pointermove", (ev) => {
            if (this.dragging) {
                const d = this.dragging;
                if (Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY) > 3) d.moved = true;
                if (d.moved) {
                    const p = this.toWorld(ev);
                    const x = p.x - d.offsetX, y = p.y - d.offsetY;
                    this.positions.set(d.id, {x, y});
                    const node = this.sim.nodes.get(d.id);
                    if (this.layoutMode === "swim" && node) {
                        // Pin the dragged group; the others swim out of its way
                        node.fx = x;
                        node.fy = y;
                        this.sim.alphaTarget = 0.3;
                        this.startSimulation(0.3);
                    } else {
                        this.reposition();
                    }
                }
            } else if (this.panning) {
                const p = this.panning;
                if (Math.hypot(ev.clientX - p.x, ev.clientY - p.y) > 3) p.moved = true;
                this.view.x = p.vx + (ev.clientX - p.x);
                this.view.y = p.vy + (ev.clientY - p.y);
                this.needsFit = false;
                this.userView = true;
                this.applyView();
            }
        });
        const end = (ev) => {
            if (this.dragging) {
                const d = this.dragging;
                this.dragging = null;
                this.svg.classList.remove("dragging");
                const node = this.sim.nodes.get(d.id);
                if (node) { node.fx = null; node.fy = null; }
                this.sim.alphaTarget = 0;
                if (!d.moved) this.select({type: "node", id: d.id});
                else if (this.layoutMode !== "swim") { this.needsFit = false; this.userView = true; }
            } else if (this.panning) {
                const moved = this.panning.moved;
                this.panning = null;
                this.svg.classList.remove("panning");
                if (!moved && ev.type === "pointerup") this.select(null);
            }
        };
        this.svg.addEventListener("pointerup", end);
        this.svg.addEventListener("pointercancel", end);
        this.svg.addEventListener("wheel", (ev) => {
            ev.preventDefault();
            const box = this.svg.getBoundingClientRect();
            const mx = ev.clientX - box.left, my = ev.clientY - box.top;
            const factor = Math.exp(-ev.deltaY * (ev.deltaMode === 1 ? 0.05 : 0.0015));
            const k = Math.min(6, Math.max(0.15, this.view.k * factor));
            this.view.x = mx - ((mx - this.view.x) * k) / this.view.k;
            this.view.y = my - ((my - this.view.y) * k) / this.view.k;
            this.view.k = k;
            this.needsFit = false;
            this.userView = true;
            this.applyView();
        }, {passive: false});
        this.svg.addEventListener("dblclick", (ev) => {
            if (!ev.target.closest(".node")) this.fit(true);
        });
    }

    startDrag(ev, id) {
        if (ev.button !== 0) return;
        ev.stopPropagation();
        const p = this.toWorld(ev);
        const pos = this.positions.get(id);
        this.dragging = {id, offsetX: p.x - pos.x, offsetY: p.y - pos.y, startX: ev.clientX, startY: ev.clientY,
            moved: false};
        this.tooltip.hidden = true;
        this.svg.setPointerCapture(ev.pointerId);
        this.svg.classList.add("dragging");
    }

    toWorld(ev) {
        const box = this.svg.getBoundingClientRect();
        return {x: (ev.clientX - box.left - this.view.x) / this.view.k, y: (ev.clientY - box.top - this.view.y) / this.view.k};
    }

    applyView() {
        this.viewport.setAttribute("transform", `translate(${this.view.x},${this.view.y}) scale(${this.view.k})`);
    }

    bounds() {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [id, p] of this.positions) {
            if (!this.analysis?.groups.has(id)) continue;
            minX = Math.min(minX, p.x - 70); maxX = Math.max(maxX, p.x + 70);
            minY = Math.min(minY, p.y - 50); maxY = Math.max(maxY, p.y + 80);
        }
        if (!Number.isFinite(minX)) return {minX: -100, minY: -100, maxX: 100, maxY: 100};
        return {minX, minY, maxX, maxY};
    }

    fitTarget() {
        const box = this.svg.getBoundingClientRect();
        if (box.width < 10 || box.height < 10) return null;
        const b = this.bounds();
        const usable = box.height - 34; // Leave room for the legend
        const k = Math.min(1.6, box.width / (b.maxX - b.minX), usable / (b.maxY - b.minY));
        return {k, x: box.width / 2 - ((b.minX + b.maxX) / 2) * k, y: usable / 2 - ((b.minY + b.maxY) / 2) * k};
    }

    // While the groups swim, the camera glides along so the whole graph stays in view
    follow() {
        const target = this.fitTarget();
        if (!target) return;
        const f = 0.12;
        this.view = {x: this.view.x + (target.x - this.view.x) * f, y: this.view.y + (target.y - this.view.y) * f,
            k: this.view.k + (target.k - this.view.k) * f};
        this.applyView();
    }

    fit(animate = false) {
        const target = this.fitTarget();
        if (!target) { this.needsFit = true; return; }
        this.needsFit = false;
        this.userView = false;
        if (!animate) {
            this.view = target;
            this.applyView();
            return;
        }
        const from = {...this.view};
        const start = performance.now();
        const step = (now) => {
            const t = Math.min(1, (now - start) / 250);
            const e = 1 - (1 - t) ** 3;
            this.view = {x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e,
                k: from.k + (target.k - from.k) * e};
            this.applyView();
            if (t < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Export: copy the computed colours into a clone, so the file looks the same outside the page
    standaloneSvg() {
        const clone = this.svg.cloneNode(true);
        const source = [this.svg, ...this.svg.querySelectorAll("*")];
        const target = [clone, ...clone.querySelectorAll("*")];
        const props = ["fill", "fill-opacity", "stroke", "stroke-width", "stroke-dasharray", "stroke-opacity", "opacity",
            "font-family", "font-size", "font-weight", "paint-order", "stroke-linecap", "stroke-linejoin"];
        const hidden = [];
        source.forEach((node, i) => {
            const style = getComputedStyle(node);
            if (style.display === "none" || node.classList.contains("edge-hit")) hidden.push(target[i]);
            target[i].setAttribute("style", props.map(p => `${p}:${style.getPropertyValue(p)}`).join(";"));
            target[i].removeAttribute("class");
            target[i].removeAttribute("tabindex");
        });
        hidden.forEach(n => n.remove());
        const b = this.bounds();
        const width = b.maxX - b.minX, height = b.maxY - b.minY;
        clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
        clone.setAttribute("viewBox", `${b.minX} ${b.minY} ${width} ${height}`);
        clone.setAttribute("width", String(Math.round(width)));
        clone.setAttribute("height", String(Math.round(height)));
        const viewport = target[source.indexOf(this.viewport)];
        viewport.removeAttribute("transform");
        const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        for (const [k, v] of Object.entries({x: b.minX, y: b.minY, width, height})) bg.setAttribute(k, String(v));
        bg.setAttribute("fill", getComputedStyle(this.wrap).backgroundColor);
        clone.insertBefore(bg, viewport);
        return {text: new XMLSerializer().serializeToString(clone), width, height};
    }

    exportSvg() {
        download("group-mover-graph.svg", this.standaloneSvg().text, "image/svg+xml");
    }

    exportPng() {
        const {text, width, height} = this.standaloneSvg();
        const img = new Image();
        const scale = 2;
        img.onload = () => {
            const canvas = el("canvas", {width: Math.round(width * scale), height: Math.round(height * scale)});
            canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
            canvas.toBlob((blob) => download("group-mover-graph.png", blob));
        };
        img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(text);
    }
}

// A gently bent arrow from A to B that stops at both circles; reverse arrows bend the other way
function curve(A, B, rA, rB, bend) {
    const dx = B.x - A.x, dy = B.y - A.y;
    const len = Math.max(1, Math.hypot(dx, dy));
    const nx = -dy / len, ny = dx / len;
    const offset = Math.min(60, len * 0.14) * bend;
    const C = {x: (A.x + B.x) / 2 + nx * offset, y: (A.y + B.y) / 2 + ny * offset};
    const toward = (P, Q, dist) => {
        const ux = Q.x - P.x, uy = Q.y - P.y;
        const l = Math.max(1, Math.hypot(ux, uy));
        return {x: P.x + (ux / l) * dist, y: P.y + (uy / l) * dist};
    };
    const S = toward(A, C, rA + 3);
    const E = toward(B, C, rB + 4);
    return {
        d: `M${S.x.toFixed(1)},${S.y.toFixed(1)} Q${C.x.toFixed(1)},${C.y.toFixed(1)} ${E.x.toFixed(1)},${E.y.toFixed(1)}`,
        label: {x: 0.25 * S.x + 0.5 * C.x + 0.25 * E.x, y: 0.25 * S.y + 0.5 * C.y + 0.25 * E.y},
    };
}

function truncate(text, n) {
    return text.length > n ? text.slice(0, n - 1) + "…" : text;
}
