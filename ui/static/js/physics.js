// A small force simulation for the graph's "Swim" layout, in the spirit of d3-force.
//
// Every tick nudges each node's velocity with a few forces, then moves it:
//   links      pull groups with people moving between them towards a comfortable distance
//   charge     pushes every pair of groups apart, so the picture spreads out
//   avoidance  pushes groups off arrows that aren't theirs, so arrows don't run through circles
//   collision  keeps circles and their labels from overlapping
//   gravity    keeps everything, including groups without any moves, near the middle
// "alpha" is the temperature: it scales the forces and decays towards alphaTarget, so the motion
// slows down and stops once the layout has settled. Dragging a node pins it and keeps things warm.

import {makeRng} from "./util.js";

export class Simulation {
    constructor() {
        this.nodes = new Map();   // id -> {id, x, y, vx, vy, r, fx, fy}
        this.links = [];
        this.alpha = 0;
        this.alphaTarget = 0;
        this.alphaMin = 0.003;
        this.alphaDecay = 1 - Math.pow(this.alphaMin, 1 / 240);   // About 240 ticks (4 s) from alpha 1 to rest
        this.velocityDecay = 0.4;
        this.random = makeRng(12345);
        this.aspect = 1;          // Width / height of the view; gravity squeezes the other way to fill it
    }

    get running() {
        return this.alpha >= this.alphaMin || this.alphaTarget > 0;
    }

    // nodes: [{id, r}], links: [{a, b, weight}] (undirected), positions: Map id -> {x, y}
    setGraph(nodes, links, positions) {
        const next = new Map();
        for (const {id, r} of nodes) {
            const p = positions.get(id) || {x: 0, y: 0};
            const old = this.nodes.get(id);
            next.set(id, old ? {...old, r, x: p.x, y: p.y} : {id, r, x: p.x, y: p.y, vx: 0, vy: 0, fx: null, fy: null});
        }
        this.nodes = next;
        this.links = links.filter(l => l.a !== l.b && next.has(l.a) && next.has(l.b))
            .map(l => ({source: next.get(l.a), target: next.get(l.b), weight: l.weight}));
        const degree = new Map();
        for (const l of this.links) {
            degree.set(l.source.id, (degree.get(l.source.id) || 0) + 1);
            degree.set(l.target.id, (degree.get(l.target.id) || 0) + 1);
        }
        for (const l of this.links) {
            const ds = degree.get(l.source.id), dt = degree.get(l.target.id);
            l.bias = ds / (ds + dt);   // The better-connected end moves less
            l.strength = Math.min(1, 0.3 + 0.2 * Math.sqrt(l.weight)) / Math.min(ds, dt);
            // Busier connections sit a little closer, but never so close that labels collide
            l.distance = l.source.r + l.target.r + Math.max(95, 140 - 10 * Math.sqrt(l.weight));
        }
    }

    reheat(alpha) {
        this.alpha = Math.max(this.alpha, alpha);
    }

    jiggle() {
        return (this.random() - 0.5) * 1e-3;
    }

    tick() {
        this.alpha += (this.alphaTarget - this.alpha) * this.alphaDecay;
        const alpha = this.alpha;
        const nodes = [...this.nodes.values()];

        // Links: springs towards each link's distance
        for (const l of this.links) {
            const s = l.source, t = l.target;
            let dx = t.x + t.vx - s.x - s.vx || this.jiggle();
            let dy = t.y + t.vy - s.y - s.vy || this.jiggle();
            const d = Math.hypot(dx, dy);
            const k = ((d - l.distance) / d) * alpha * l.strength;
            dx *= k;
            dy *= k;
            t.vx -= dx * l.bias;
            t.vy -= dy * l.bias;
            s.vx += dx * (1 - l.bias);
            s.vy += dy * (1 - l.bias);
        }

        // Charge: every pair repels, weaker with distance
        for (let i = 0; i < nodes.length; i++) {
            const a = nodes[i];
            for (let j = i + 1; j < nodes.length; j++) {
                const b = nodes[j];
                let dx = b.x - a.x || this.jiggle(), dy = b.y - a.y || this.jiggle();
                let d2 = dx * dx + dy * dy;
                if (d2 > 450 * 450) continue;
                d2 = Math.max(d2, 100);
                const w = (-30 * (a.r + b.r) * alpha) / d2;
                a.vx += dx * w;
                a.vy += dy * w;
                b.vx -= dx * w;
                b.vy -= dy * w;
            }
        }

        // Avoidance: a group lying on someone else's arrow slides off it, and the arrow bends away a little
        for (const l of this.links) {
            const s = l.source, t = l.target;
            const ex = t.x - s.x, ey = t.y - s.y;
            const len2 = ex * ex + ey * ey;
            if (len2 < 1) continue;
            for (const c of nodes) {
                if (c === s || c === t) continue;
                const u = ((c.x - s.x) * ex + (c.y - s.y) * ey) / len2;
                if (u <= 0.05 || u >= 0.95) continue;
                const dx = c.x - (s.x + u * ex) || this.jiggle(), dy = c.y - (s.y + u * ey) || this.jiggle();
                const d = Math.hypot(dx, dy);
                const clearance = c.r + 22;
                if (d >= clearance) continue;
                const k = ((clearance - d) / d) * alpha * 0.6;
                c.vx += dx * k;
                c.vy += dy * k;
                s.vx -= dx * k * 0.25;
                s.vy -= dy * k * 0.25;
                t.vx -= dx * k * 0.25;
                t.vy -= dy * k * 0.25;
            }
        }

        // Gravity towards the middle, stronger across the view's short side so the graph fills a wide pane
        const stretch = Math.sqrt(Math.min(3, Math.max(1 / 3, this.aspect)));
        for (const n of nodes) {
            n.vx -= n.x * (0.06 / stretch) * alpha;
            n.vy -= n.y * (0.06 * stretch) * alpha;
        }

        // Collision: circles plus room for the labels underneath, on the positions they are about to have
        for (let i = 0; i < nodes.length; i++) {
            const a = nodes[i];
            const ra = a.r + 36;
            for (let j = i + 1; j < nodes.length; j++) {
                const b = nodes[j];
                const rb = b.r + 36;
                let dx = a.x + a.vx - b.x - b.vx || this.jiggle();
                let dy = a.y + a.vy - b.y - b.vy || this.jiggle();
                const d = Math.hypot(dx, dy);
                const min = ra + rb;
                if (d >= min) continue;
                const k = ((min - d) / d) * 0.7;
                dx *= k;
                dy *= k;
                const share = (rb * rb) / (ra * ra + rb * rb);   // The smaller circle gives way more
                a.vx += dx * share;
                a.vy += dy * share;
                b.vx -= dx * (1 - share);
                b.vy -= dy * (1 - share);
            }
        }

        // Move, with friction; pinned nodes stay where the pointer holds them
        for (const n of nodes) {
            if (n.fx !== null) {
                n.x = n.fx;
                n.y = n.fy;
                n.vx = 0;
                n.vy = 0;
                continue;
            }
            n.vx *= 1 - this.velocityDecay;
            n.vy *= 1 - this.velocityDecay;
            const speed = Math.hypot(n.vx, n.vy);
            if (speed > 40) {   // Keeps a crowded start from exploding
                n.vx *= 40 / speed;
                n.vy *= 40 / speed;
            }
            n.x += n.vx;
            n.y += n.vy;
        }
    }
}
