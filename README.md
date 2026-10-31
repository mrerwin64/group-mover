# group-mover

A C++20 library that decides which group-change requests can be granted. Each person is in one group and
wants to move to any one of several other groups. Every group has to end up with a size between its minimum
and maximum. group-mover grants as many moves as possible and, among the best solutions, keeps group sizes as
close as possible to the current ones. Ties are broken randomly using a seed, so the order of the input
doesn't matter and results can be reproduced.

I wrote it for a real problem: students swapping between class groups that have size limits.

## How it works

The problem is modelled as a **min-cost flow** network:

- each group is a node, and each person is a node connecting their source group to all of their
  acceptable destinations,
- a shared slack node is connected to every group, with capacities equal to how much the group may still
  shrink or grow and a cost of 1 per person, so changes in group size are penalised,
- the network is balanced by repeatedly pushing one unit of flow from a surplus node to the cheapest
  deficit node, found with **SPFA** (Bellman–Ford with a queue) on a residual edge list.

Groups and edge lists are shuffled with the seed before balancing, so equally good solutions are chosen
fairly.

## API

The library is a shared library with a plain C interface ([`group-mover.h`](group-mover.h)), so it can be
called from C, C++, Python (`ctypes`) and other languages:

```c
int32_t group_mover_select_moves(const group_mover_group* groups, size_t group_count,
                                 const group_mover_move* moves, size_t move_count,
                                 uint64_t seed, int32_t* assignments);
```

Invalid input is reported with specific status codes rather than undefined behaviour, and
`group_mover_status_string()` turns them into readable messages.

## Building and testing

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
ctest --test-dir build --output-on-failure
```

The tests cover hand-written examples, randomised inputs checked against invariants, fairness of tie
breaking, and status codes. GitHub Actions runs them on Linux (GCC, plus a build with AddressSanitizer
and UndefinedBehaviorSanitizer), macOS (Clang) and Windows (MSVC).

## Command-line program

`group_mover` reads a seed, then groups (`<id> <min> <current> <max>`), then moves
(`<src> <dst1> [<dst2> ...]`), using blank lines as separators:

```
42
1 10 12 14
2 10 10 14
3 10 11 12

1 2 3
1 3
3 2

```

## Web UI

[`ui/`](ui/README.md) contains a local web interface for entering groups and moves and seeing the result
as a graph. It calls the real library through `ctypes`.

The UI, the tests and the CI pipeline were written by Claude. The library and the command-line program
(`main.cpp`) are my own work.
