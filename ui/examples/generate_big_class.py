"""Generates the "Big class" example: 15 lab groups (Mon-Wed, 08:00-16:00) and 100 people who want to move.

    python ui/examples/generate_big_class.py

Early and late slots are unpopular and midday ones popular, so requests are unbalanced. With no slack only
swaps and cycles can happen (43 of 100 move); every extra person of slack lets more one-way moves through,
until everyone moves at +-10. Most people want another slot on the same day, so the Swim layout shows the days
as clusters with a few bridges between them.

Writes, next to this script:
    big-class.json   a project for the UI's "Open project..." (bounds: current +-2)
    big-class.txt    main.cpp's stdin format (seed, groups with bounds +-2, blank line, moves, blank line)
and ../static/js/big-class.js, which the UI's Examples menu loads.
The same seed always gives the same files.
"""

import json
import random
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

DAYS = ["Mon", "Tue", "Wed"]
SLOTS = ["08", "10", "12", "14", "16"]
APPEAL = {"08": 0.2, "10": 1.0, "12": 2.2, "14": 1.4, "16": 0.35}   # How much people like each slot
FIRST = ["Ola", "Piotr", "Kasia", "Marek", "Zofia", "Jan", "Ewa", "Tomek", "Ania", "Kuba", "Magda", "Paweł",
         "Iga", "Szymon", "Julia", "Michał", "Natalia", "Bartek", "Agata", "Filip", "Maja", "Wojtek", "Lena",
         "Adam", "Hania", "Kamil", "Ula", "Igor", "Zuza", "Mateusz", "Wiktoria", "Oskar", "Nina", "Krzysiek",
         "Alicja", "Dawid", "Emilia", "Łukasz", "Weronika", "Staś"]
LAST = "ABCDEFGHIJKLMNOPRSTWZ"
SEED = 29
CROSS_DAY = 0.1   # Share of wishes for another day; the rest stay on the same day
PEOPLE = 100
SLACK = 2          # Bounds written into the files: current +- SLACK
RUN_SEED = 12345   # Seed written into the files for the library


def gid(day, slot):
    return (DAYS.index(day) + 1) * 10 + SLOTS.index(slot) + 1


def build(seed=SEED, people=PEOPLE):
    """Returns groups [(id, name, size)] and moves [(person, src, [dst, ...])]."""
    rng = random.Random(seed)
    groups = [(gid(d, s), f"{d} {s}:00", rng.randint(14, 18)) for d in DAYS for s in SLOTS]
    size = {g: n for g, _, n in groups}
    leaving = {g: 0 for g, _, _ in groups}
    names = set()
    moves = []

    def name():
        while True:
            n = f"{rng.choice(FIRST)} {rng.choice(LAST)}."
            if n not in names:
                names.add(n)
                return n

    def weighted(options):
        r = rng.random() * sum(w for _, w in options)
        for o, w in options:
            r -= w
            if r <= 0:
                return o
        return options[-1][0]

    def add(src, dst):
        moves.append((name(), src, dst))
        leaving[src] += 1

    # A few swaps and three-way cycles, so something moves even without slack
    for _ in range(4):
        d = rng.choice(DAYS)
        a, b = rng.sample(SLOTS, 2)
        add(gid(d, a), [gid(d, b)])
        add(gid(d, b), [gid(d, a)])
    for _ in range(2):
        d = rng.choice(DAYS)
        a, b, c = [(d, s) for s in rng.sample(SLOTS, 3)]
        add(gid(*a), [gid(*b)])
        add(gid(*b), [gid(*c)])
        add(gid(*c), [gid(*a)])

    # Everyone else leaves an unpopular slot for popular ones, usually on the same day; at most 60% of a group asks
    while len(moves) < people:
        src = weighted([((d, s), 1.2 / APPEAL[s]) for d in DAYS for s in SLOTS])
        if leaving[gid(*src)] >= 0.6 * size[gid(*src)]:
            continue
        count = weighted([(1, 0.6), (2, 0.3), (3, 0.1)])
        options = []
        for _ in range(20):
            if len(options) == count:
                break
            if rng.random() >= CROSS_DAY:
                day = src[0]
                slot = weighted([(s, APPEAL[s] / (1 + abs(SLOTS.index(s) - SLOTS.index(src[1])))) for s in SLOTS])
            else:
                day = rng.choice(DAYS)
                slot = src[1] if rng.random() < 0.6 else weighted([(s, APPEAL[s]) for s in SLOTS])
            dst = gid(day, slot)
            if (day, slot) != src and dst not in options:
                options.append(dst)
        if options:
            add(gid(*src), options)
    rng.shuffle(moves)
    return groups, moves


def slack_curve(groups, moves, slacks):
    """How many people move at each slack, according to the real library (built on demand)."""
    import group_mover as gm
    lib = gm.load(log=lambda _: None)
    prepared_moves = [{"src": s, "dst": d} for _, s, d in moves]
    curve = []
    for k in slacks:
        api_groups = [{"id": g, "min_size": max(0, n - k), "current_size": n, "max_size": n + k} for g, _, n in groups]
        status, assignments = lib.select_moves(api_groups, prepared_moves, RUN_SEED)
        assert status == gm.OK, lib.status_string(status)
        curve.append(sum(f != m["src"] for f, m in zip(assignments, prepared_moves)))
    return curve


def main():
    groups, moves = build()
    project = {
        "format": "group-mover-ui", "version": 1, "seed": str(RUN_SEED),
        "groups": [{"id": str(g), "name": name, "min": str(max(0, n - SLACK)), "current": str(n), "max": str(n + SLACK)}
                   for g, name, n in groups],
        "moves": [{"name": person, "src": str(src), "dst": " ".join(map(str, dst))} for person, src, dst in moves],
    }
    (HERE / "big-class.json").write_text(json.dumps(project, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    lines = [str(RUN_SEED)]
    lines += [f"{g} {max(0, n - SLACK)} {n} {n + SLACK}" for g, _, n in groups]
    lines.append("")
    lines += [f"{src} {' '.join(map(str, dst))}" for _, src, dst in moves]
    lines.append("")
    (HERE / "big-class.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")

    module = ("// Generated by ui/examples/generate_big_class.py; edit that script instead.\n"
              "// groups: [id, name, current size]; moves: [person, src, [destinations]]\n"
              f"export const BIG_CLASS = {json.dumps({'groups': groups, 'moves': moves}, ensure_ascii=False)};\n")
    (HERE.parent / "static" / "js" / "big-class.js").write_text(module, encoding="utf-8")

    print(f"{len(groups)} groups, {len(moves)} people, {sum(n for _, _, n in groups)} students in total")
    curve = slack_curve(groups, moves, range(0, 11))
    print("moved at slack " + ", ".join(f"±{k}: {m}" for k, m in enumerate(curve)))


if __name__ == "__main__":
    main()
