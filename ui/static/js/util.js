// Small DOM and formatting helpers shared by every view

export const SVG_NS = "http://www.w3.org/2000/svg";

// The props object is optional: anything else in second place is the first child
function isProps(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Node);
}

// el("div.card#id", {attrs, on: {click}}, children...)
export function el(spec, props, ...children) {
    if (!isProps(props)) {
        if (props !== undefined) children.unshift(props);
        props = {};
    }
    const [tagPart, ...rest] = spec.split(/(?=[.#])/);
    const node = document.createElement(tagPart || "div");
    for (const part of rest) {
        if (part[0] === ".") node.classList.add(part.slice(1));
        else if (part[0] === "#") node.id = part.slice(1);
    }
    applyProps(node, props);
    append(node, children);
    return node;
}

export function svg(tag, props, ...children) {
    if (!isProps(props)) {
        if (props !== undefined) children.unshift(props);
        props = {};
    }
    const node = document.createElementNS(SVG_NS, tag);
    applyProps(node, props);
    append(node, children);
    return node;
}

function applyProps(node, props) {
    if (!props) return;
    for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null || value === false) continue;
        if (key === "on") {
            for (const [event, handler] of Object.entries(value)) node.addEventListener(event, handler);
        } else if (key === "class") {
            node.setAttribute("class", value);
        } else if (key === "style" && typeof value === "object") {
            Object.assign(node.style, value);
        } else if (key === "text") {
            node.textContent = value;
        } else if (key === "dataset") {
            Object.assign(node.dataset, value);
        } else if (key in node && !(node instanceof SVGElement) && typeof value !== "string") {
            node[key] = value;
        } else if (key === "value" && "value" in node) {
            node.value = value;
        } else {
            node.setAttribute(key, value === true ? "" : value);
        }
    }
}

export function append(node, children) {
    for (const child of children.flat(Infinity)) {
        if (child === null || child === undefined || child === false) continue;
        node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
}

export function clear(node) {
    while (node.firstChild) node.firstChild.remove();
    return node;
}

export function debounce(fn, ms) {
    let timer = null;
    const wrapped = (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
    wrapped.cancel = () => clearTimeout(timer);
    return wrapped;
}

// Strict integer parsing: optional sign and digits only, returns null when invalid
export function parseInteger(text) {
    const s = String(text ?? "").trim();
    if (!/^[+-]?\d+$/.test(s)) return null;
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : null;
}

export const INT32_MIN = -(2 ** 31);
export const INT32_MAX = 2 ** 31 - 1;
export const UINT64_MAX = (1n << 64n) - 1n;

export function isValidSeed(text) {
    const s = String(text ?? "").trim();
    if (!/^\d+$/.test(s)) return false;
    return BigInt(s) <= UINT64_MAX;
}

export function randomSeed() {
    const words = new Uint32Array(2);
    crypto.getRandomValues(words);
    return ((BigInt(words[0]) << 32n) | BigInt(words[1])).toString();
}

export function addToSeed(seed, offset) {
    return ((BigInt(seed) + BigInt(offset)) & UINT64_MAX).toString();
}

export function download(filename, content, type = "text/plain") {
    const blob = content instanceof Blob ? content : new Blob([content], {type});
    const url = URL.createObjectURL(blob);
    const a = el("a", {href: url, download: filename});
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const area = el("textarea", {value: text, style: {position: "fixed", opacity: "0"}});
        document.body.append(area);
        area.select();
        let ok = false;
        try { ok = document.execCommand("copy"); } catch { ok = false; }
        area.remove();
        return ok;
    }
}

export function plural(n, word, many = word + "s") {
    return `${n} ${n === 1 ? word : many}`;
}

export function signed(n) {
    return n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "0";
}

export function percent(x, digits = 0) {
    return `${(x * 100).toFixed(digits)}%`;
}

export function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Reads localStorage without ever throwing (private windows, blocked storage)
export const storage = {
    get(key) {
        try { return localStorage.getItem(key); } catch { return null; }
    },
    set(key, value) {
        try { localStorage.setItem(key, value); return true; } catch { return false; }
    },
    remove(key) {
        try { localStorage.removeItem(key); } catch { /* ignored */ }
    },
};

// UTF-8 safe base64 for share links
export function toBase64Url(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text) {
    const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(b64 + "===".slice((b64.length + 3) % 4));
    return new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0)));
}

export function formatTime(seconds) {
    const d = new Date(seconds * 1000);
    return d.toLocaleString(undefined, {dateStyle: "medium", timeStyle: "short"});
}

export function formatMs(ms) {
    if (ms < 1) return `${ms.toFixed(2)} ms`;
    if (ms < 1000) return `${ms.toFixed(ms < 10 ? 1 : 0)} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
}

// Deterministic PRNG for the example generator (mulberry32)
export function makeRng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
