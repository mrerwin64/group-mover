// Before/after flow diagram: each group is a bar on the left (before) and on the right (after);
// bands between them are people who stayed (grey) or moved (coloured), and their thickness is the number of people.

import {el, svg, clear, plural, signed} from "./util.js";

export class FlowView {
    constructor(container, {groupLabel}) {
        this.groupLabel = groupLabel;
        this.analysis = null;
        this.onlyMovers = false;
        this.root = el("div.flow-view");
        this.toolbar = el("div.toolbar",
            el("label.check", {title: "Hide people who stayed, so the moves get the whole height"},
                el("input", {type: "checkbox", on: {change: (e) => { this.onlyMovers = e.target.checked; this.draw(); }}}),
                "Only people who moved"),
            el("span.spacer"),
            el("span.muted.small", "Hover a band to see who is in it"));
        this.svg = svg("svg", {class: "flow-svg", role: "img", "aria-label": "Group sizes before and after the moves"});
        this.tooltip = el("div.tooltip", {role: "tooltip", hidden: true});
        this.empty = el("div.empty-state", {hidden: true});
        this.wrap = el("div.flow-wrap", this.svg, this.tooltip, this.empty);
        this.root.append(this.toolbar, this.wrap);
        container.append(this.root);
        new ResizeObserver(() => this.draw()).observe(this.wrap);
    }

    update(analysis) {
        this.analysis = analysis;
        this.draw();
    }

    draw() {
        clear(this.svg);
        const a = this.analysis;
        const box = this.wrap.getBoundingClientRect();
        if (!a || !a.hasResult || a.groups.size === 0) {
            this.empty.hidden = false;
            this.empty.textContent = a && a.groups.size ? "Run the library to see where people end up." :
                "Add groups and moves to see the flow.";
            return;
        }
        if (this.onlyMovers && a.totals.moved === 0) {
            this.empty.hidden = false;
            this.empty.textContent = "Nobody moved.";
            return;
        }
        this.empty.hidden = true;
        const width = Math.max(420, box.width), height = Math.max(260, box.height);
        this.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

        const groups = [...a.groups.values()];
        // Flows between groups: stays and moves
        const flows = [];
        for (const g of groups) {
            const stay = g.current - g.out;
            if (!this.onlyMovers && stay > 0) flows.push({a: g.id, b: g.id, value: stay, people: null});
        }
        for (const e of a.edges.values()) {
            if (e.moved.length) flows.push({a: e.a, b: e.b, value: e.moved.length, people: e.moved});
        }
        const leftValue = new Map(groups.map(g => [g.id, 0]));
        const rightValue = new Map(groups.map(g => [g.id, 0]));
        for (const f of flows) {
            leftValue.set(f.a, leftValue.get(f.a) + f.value);
            rightValue.set(f.b, rightValue.get(f.b) + f.value);
        }
        const shown = groups.filter(g => leftValue.get(g.id) > 0 || rightValue.get(g.id) > 0 ||
            (!this.onlyMovers && g.current + g.after === 0));

        const labelWidth = Math.min(170, width * 0.22);
        const x0 = labelWidth, x1 = width - labelWidth, barW = 12;
        const top = 28, bottom = height - 10;
        const gap = Math.min(10, (bottom - top) * 0.3 / Math.max(1, shown.length - 1));
        const total = Math.max(1, Math.max(sum(shown, g => leftValue.get(g.id)), sum(shown, g => rightValue.get(g.id))));
        const scale = (bottom - top - gap * Math.max(0, shown.length - 1)) / total;
        const minBar = 2;

        const layout = (values) => {
            const pos = new Map();
            let y = top;
            for (const g of shown) {
                const h = Math.max(minBar, values.get(g.id) * scale);
                pos.set(g.id, {y, h, cursor: y});
                y += h + gap;
            }
            return pos;
        };
        const left = layout(leftValue);
        const right = layout(rightValue);
        const order = new Map(shown.map((g, i) => [g.id, i]));

        // Bands leave each left bar ordered by destination and enter each right bar ordered by source,
        // which keeps crossings down
        const bands = flows.filter(f => order.has(f.a) && order.has(f.b))
            .sort((p, q) => order.get(p.a) - order.get(q.a) || order.get(p.b) - order.get(q.b));
        for (const f of bands) f.h = f.value * scale;
        for (const f of bands) {
            const l = left.get(f.a);
            f.y0 = l.cursor;
            l.cursor += f.h;
        }
        [...bands].sort((p, q) => order.get(p.b) - order.get(q.b) || order.get(p.a) - order.get(q.a)).forEach(f => {
            const r = right.get(f.b);
            f.y1 = r.cursor;
            r.cursor += f.h;
        });

        this.svg.append(
            svg("text", {x: x0 + barW / 2, y: 16, class: "flow-heading", "text-anchor": "middle"}, "Before"),
            svg("text", {x: x1 - barW / 2, y: 16, class: "flow-heading", "text-anchor": "middle"}, "After"));

        const bandLayer = svg("g");
        const xa = x0 + barW, xb = x1 - barW, xm = (xa + xb) / 2;
        for (const f of bands) {
            const d = `M${xa},${f.y0} C${xm},${f.y0} ${xm},${f.y1} ${xb},${f.y1}` +
                ` L${xb},${f.y1 + f.h} C${xm},${f.y1 + f.h} ${xm},${f.y0 + f.h} ${xa},${f.y0 + f.h} Z`;
            const band = svg("path", {d, class: f.people ? "band band-moved" : "band band-stay"});
            band.addEventListener("pointerenter", (ev) => this.showTooltip(ev, this.bandTooltip(f)));
            band.addEventListener("pointermove", (ev) => this.moveTooltip(ev));
            band.addEventListener("pointerleave", () => { this.tooltip.hidden = true; });
            bandLayer.append(band);
        }
        this.svg.append(bandLayer);

        for (const g of shown) {
            const l = left.get(g.id), r = right.get(g.id);
            const cls = g.delta > 0 ? "bar-grew" : g.delta < 0 ? "bar-shrank" : "bar-same";
            this.svg.append(
                svg("rect", {x: x0, y: l.y, width: barW, height: l.h, rx: 2, class: "flow-bar"}),
                svg("rect", {x: x1 - barW, y: r.y, width: barW, height: r.h, rx: 2, class: `flow-bar ${cls}`}));
            const label = this.groupLabel(g.id);
            const before = this.onlyMovers ? `${plural(g.out, "leaves", "leave")}` : `${g.current}`;
            const after = this.onlyMovers ? `${plural(g.in, "joins", "join")}` :
                g.delta ? `${g.after} (${signed(g.delta)})` : `${g.after}`;
            if (l.h >= 9 || shown.length <= 20) {
                this.svg.append(svg("text", {x: x0 - 8, y: l.y + l.h / 2, class: "flow-label", "text-anchor": "end",
                    "dominant-baseline": "central"}, svg("tspan", {class: "strong"}, label), `  ${before}`));
            }
            if (r.h >= 9 || shown.length <= 20) {
                this.svg.append(svg("text", {x: x1 + 8, y: r.y + r.h / 2, class: "flow-label", "dominant-baseline": "central"},
                    svg("tspan", {class: "strong"}, label), `  ${after}`));
            }
        }
    }

    bandTooltip(f) {
        const a = this.analysis;
        if (!f.people) {
            return [el("div.tt-title", `Stayed in ${this.groupLabel(f.a)}`), el("div", plural(f.value, "person", "people"))];
        }
        const names = f.people.slice(0, 10).map(i => a.people[i].name).join(", ");
        return [el("div.tt-title", `${this.groupLabel(f.a)} → ${this.groupLabel(f.b)}`),
            el("div", `${plural(f.value, "person", "people")}: ${names}${f.people.length > 10 ? ` +${f.people.length - 10} more` : ""}`)];
    }

    showTooltip(ev, content) {
        clear(this.tooltip).append(...content);
        this.tooltip.hidden = false;
        this.moveTooltip(ev);
    }

    moveTooltip(ev) {
        const box = this.wrap.getBoundingClientRect();
        const x = ev.clientX - box.left, y = ev.clientY - box.top;
        const w = this.tooltip.offsetWidth, h = this.tooltip.offsetHeight;
        this.tooltip.style.left = `${Math.max(4, x + 14 + w > box.width ? x - 14 - w : x + 14)}px`;
        this.tooltip.style.top = `${Math.max(4, y + 14 + h > box.height ? y - 14 - h : y + 14)}px`;
    }
}

function sum(list, f) {
    return list.reduce((acc, x) => acc + f(x), 0);
}
