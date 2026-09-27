#include "group-mover.h"

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>
#include <map>
#include <random>
#include <set>
#include <string>
#include <vector>

using std::vector;

namespace {
    // One person: the group they are in and the groups they would accept moving to
    struct move {
        int32_t src;
        vector<int32_t> dst;
    };

    // The library's inputs, flattened the way the C API expects them
    struct flat_input {
        vector<int32_t> src;
        vector<size_t> dst_counts;
        vector<int32_t> dst;
    };

    int failures = 0;

    std::string describe(const vector<move>& moves) {
        std::string text = "[";
        for (size_t i = 0; i < moves.size(); i++) {
            if (i > 0) text += ", ";
            text += std::to_string(moves[i].src) + "->{";
            for (size_t j = 0; j < moves[i].dst.size(); j++) {
                if (j > 0) text += ",";
                text += std::to_string(moves[i].dst[j]);
            }
            text += "}";
        }
        return text + "]";
    }

    std::string describe(const vector<int32_t>& values) {
        std::string text = "[";
        for (size_t i = 0; i < values.size(); i++) {
            if (i > 0) text += ", ";
            text += std::to_string(values[i]);
        }
        return text + "]";
    }

    void fail(const std::string& name, const vector<move>& moves, const std::string& reason) {
        failures++;
        const std::string shown_moves = moves.empty() ? "" : " " + describe(moves);
        std::printf("FAIL %s%s: %s\n", name.c_str(), shown_moves.c_str(), reason.c_str());
    }

    flat_input flatten(const vector<move>& moves) {
        flat_input input;
        for (const move& m : moves) {
            input.src.push_back(m.src);
            input.dst_counts.push_back(m.dst.size());
            input.dst.insert(input.dst.end(), m.dst.begin(), m.dst.end());
        }
        return input;
    }

    // A group number that appears nowhere in the input, used to pre-fill result
    // so that entries the library forgets to write can be detected
    int32_t unused_group(const vector<move>& moves) {
        std::set<int32_t> used;
        for (const move& m : moves) {
            used.insert(m.src);
            used.insert(m.dst.begin(), m.dst.end());
        }
        int32_t candidate = 123456789;
        while (used.count(candidate) > 0) candidate++;
        return candidate;
    }

    // Returns true if every group receives as many people as it sends
    bool balanced(const vector<move>& moves, const vector<int32_t>& result) {
        std::map<int32_t, int> balance;
        for (size_t i = 0; i < moves.size(); i++) {
            if (result[i] == moves[i].src) continue;
            balance[moves[i].src] += 1;
            balance[result[i]] -= 1;
        }
        for (const auto& [group, value] : balance) {
            if (value != 0) return false;
        }
        return true;
    }

    // Largest number of people that can move, found by trying every choice
    // (stay, or any one of their destinations) for every person
    size_t brute_force_best(const vector<move>& moves) {
        // Number the groups densely so the balance can be kept in a vector
        std::map<int32_t, size_t> index;
        for (const move& m : moves) {
            index.try_emplace(m.src, index.size());
            for (const int32_t d : m.dst) index.try_emplace(d, index.size());
        }
        vector<int> balance(index.size(), 0);
        size_t best = 0;

        auto search = [&](auto& self, const size_t person, const size_t moved) -> void {
            if (person == moves.size()) {
                if (moved > best && std::all_of(balance.begin(), balance.end(), [](int b) { return b == 0; })) {
                    best = moved;
                }
                return;
            }
            // The person stays
            self(self, person + 1, moved);
            // The person moves to one of their destinations
            const size_t from = index.at(moves[person].src);
            for (const int32_t d : moves[person].dst) {
                const size_t to = index.at(d);
                balance[from] += 1;
                balance[to] -= 1;
                self(self, person + 1, moved + 1);
                balance[from] -= 1;
                balance[to] += 1;
            }
        };
        search(search, 0, 0);
        return best;
    }

    // Runs the library and checks that the result is valid and moves as many people as possible.
    // Returns the result so callers can check for a specific answer.
    vector<int32_t> check(const std::string& name, const vector<move>& moves) {
        const flat_input input = flatten(moves);
        const int32_t sentinel = unused_group(moves);
        vector<int32_t> result(moves.size(), sentinel);

        const int32_t status = group_mover_select_moves(input.src.data(), input.dst_counts.data(), input.dst.data(),
                                                        moves.size(), result.data());
        if (status != GROUP_MOVER_OK) {
            fail(name, moves, "returned status " + std::to_string(status));
            return result;
        }

        size_t moved = 0;
        for (size_t i = 0; i < moves.size(); i++) {
            const bool stays = result[i] == moves[i].src;
            const bool allowed = stays || std::find(moves[i].dst.begin(), moves[i].dst.end(), result[i]) != moves[i].dst.end();
            if (!allowed) {
                fail(name, moves, "result[" + std::to_string(i) + "] is " + std::to_string(result[i]) +
                                  ", which is neither the source nor one of the destinations");
                return result;
            }
            if (!stays) moved++;
        }
        if (!balanced(moves, result)) {
            fail(name, moves, "result " + describe(result) + " changes group sizes");
        }
        const size_t best = brute_force_best(moves);
        if (moved != best) {
            fail(name, moves, "moved " + std::to_string(moved) + " people, best is " + std::to_string(best));
        }
        return result;
    }

    void check_exact(const std::string& name, const vector<move>& moves, const vector<int32_t>& expected) {
        const vector<int32_t> result = check(name, moves);
        if (result != expected) {
            fail(name, moves, "result " + describe(result) + ", expected " + describe(expected));
        }
    }

    // Checks that invalid input is rejected with the expected status and that result is left untouched
    void check_rejected(const std::string& name, const vector<move>& moves, const int32_t expected) {
        const flat_input input = flatten(moves);
        const int32_t sentinel = unused_group(moves);
        vector<int32_t> result(moves.size(), sentinel);

        const int32_t status = group_mover_select_moves(input.src.data(), input.dst_counts.data(), input.dst.data(),
                                                        moves.size(), result.data());
        if (status != expected) {
            fail(name, moves, "returned status " + std::to_string(status) + ", expected " + std::to_string(expected));
        }
        if (result != vector<int32_t>(moves.size(), sentinel)) {
            fail(name, moves, "result was written despite the error");
        }
    }

    void check_status(const std::string& name, const int32_t* src, const size_t* dst_counts, const int32_t* dst,
                      const size_t move_count, int32_t* result, const int32_t expected) {
        const int32_t status = group_mover_select_moves(src, dst_counts, dst, move_count, result);
        if (status != expected) {
            fail(name, {}, "returned status " + std::to_string(status) + ", expected " + std::to_string(expected));
        }
    }

    void check_status_string(const int32_t status, const char* expected) {
        const char* text = group_mover_status_string(status);
        if (text == nullptr) {
            fail("status string", {}, "status " + std::to_string(status) + " returned a null pointer");
        }
        else if (std::strcmp(text, expected) != 0) {
            fail("status string", {}, "status " + std::to_string(status) + " returned \"" + text +
                                      "\", expected \"" + expected + "\"");
        }
    }

    void run_status_strings() {
        check_status_string(GROUP_MOVER_OK, "ok");
        check_status_string(GROUP_MOVER_NULL_ARGUMENT, "null argument");
        check_status_string(GROUP_MOVER_INVALID_GROUP, "invalid group");
        check_status_string(GROUP_MOVER_OUT_OF_MEMORY, "out of memory");
        check_status_string(GROUP_MOVER_INTERNAL_ERROR, "internal error");
        check_status_string(GROUP_MOVER_NO_DESTINATION, "move with no destination");
        check_status_string(GROUP_MOVER_SELF_MOVE, "move with destination equal to source");
        check_status_string(99, "unknown error");
        check_status_string(-1, "unknown error");
    }

    void run_examples() {
        // One destination per person
        check_exact("cycle with extra move", {{1, {2}}, {2, {3}}, {3, {1}}, {1, {3}}}, {2, 3, 1, 1});
        check_exact("pure cycle", {{1, {2}}, {2, {3}}, {3, {4}}, {4, {1}}}, {2, 3, 4, 1});
        check_exact("swap", {{1, {2}}, {2, {1}}}, {2, 1});
        check_exact("chain", {{1, {2}}, {2, {3}}}, {1, 2});
        check("duplicate moves", {{1, {2}}, {1, {2}}, {2, {1}}});
        check("two cycles sharing a group", {{1, {2}}, {2, {1}}, {1, {3}}, {3, {1}}, {2, {3}}});
        check("overlapping paths", {{1, {2}}, {2, {3}}, {1, {4}}, {4, {5}}, {5, {3}}, {6, {2}}, {3, {1}}, {3, {6}}});

        // Several destinations per person
        check_exact("only the first destination works", {{1, {3, 2}}, {3, {1}}}, {3, 1});
        check_exact("only the last destination works", {{1, {2, 3}}, {3, {1}}}, {3, 1});
        check_exact("only a middle destination works", {{1, {2, 3, 4}}, {3, {1}}}, {3, 1});
        check_exact("no destination works", {{1, {2, 3}}, {2, {3}}}, {1, 2});
        check_exact("duplicate destinations", {{1, {2, 2}}, {2, {1}}}, {2, 1});
        check("three people who could each go anywhere", {{1, {2, 3}}, {2, {3, 1}}, {3, {1, 2}}});
        check("redirect frees a cycle", {{1, {2, 3}}, {2, {1}}, {3, {4}}, {4, {1}}, {5, {2}}});

        // Group numbering
        check_exact("group zero", {{0, {1}}, {1, {0}}, {0, {2}}}, {1, 0, 0});
        check_exact("scattered and negative groups",
                    {{1000000000, {-5}}, {-5, {7}}, {7, {1000000000}}, {7, {-5}}}, {-5, 7, 1000000000, 7});
        constexpr int32_t low = std::numeric_limits<int32_t>::min();
        constexpr int32_t high = std::numeric_limits<int32_t>::max();
        check_exact("extreme group numbers", {{low, {high}}, {high, {low}}}, {high, low});

        // Invalid input
        check_rejected("self move", {{3, {3}}}, GROUP_MOVER_SELF_MOVE);
        check_rejected("self move among other destinations", {{1, {2, 1, 3}}}, GROUP_MOVER_SELF_MOVE);
        check_rejected("self move in a later move", {{1, {2, 3}}, {2, {1}}, {4, {5, 4}}}, GROUP_MOVER_SELF_MOVE);
        check_rejected("no destinations", {{1, {2}}, {2, {}}}, GROUP_MOVER_NO_DESTINATION);

        int32_t src[] = {1};
        size_t dst_counts[] = {1};
        int32_t dst[] = {2};
        int32_t result[] = {0};
        check_status("no moves", nullptr, nullptr, nullptr, 0, nullptr, GROUP_MOVER_OK);
        check_status("null src", nullptr, dst_counts, dst, 1, result, GROUP_MOVER_NULL_ARGUMENT);
        check_status("null dst_counts", src, nullptr, dst, 1, result, GROUP_MOVER_NULL_ARGUMENT);
        check_status("null dst", src, dst_counts, nullptr, 1, result, GROUP_MOVER_NULL_ARGUMENT);
        check_status("null result", src, dst_counts, dst, 1, nullptr, GROUP_MOVER_NULL_ARGUMENT);
    }

    // Compares the library against brute force on many small random inputs,
    // with groups numbered from 1, from 0, and scattered over the whole int32_t range
    void run_random() {
        std::mt19937 rng(12345);
        std::uniform_int_distribution<int32_t> any_group(std::numeric_limits<int32_t>::min(),
                                                         std::numeric_limits<int32_t>::max());
        for (int numbering = 0; numbering < 3; numbering++) {
            for (int test = 0; test < 400; test++) {
                const int group_count = std::uniform_int_distribution(2, 6)(rng);
                const int move_count = std::uniform_int_distribution(0, 8)(rng);

                vector<int32_t> groups;
                for (int g = 0; g < group_count; g++) {
                    if (numbering == 0) groups.push_back(g + 1);
                    else if (numbering == 1) groups.push_back(g);
                    else groups.push_back(any_group(rng));
                }

                vector<move> moves;
                std::uniform_int_distribution<size_t> pick(0, groups.size() - 1);
                for (int i = 0; i < move_count; i++) {
                    move m{groups[pick(rng)], {}};
                    const int dst_count = std::uniform_int_distribution(1, 3)(rng);
                    while (static_cast<int>(m.dst.size()) < dst_count) {
                        // Destinations may repeat, but never equal the source
                        const int32_t d = groups[pick(rng)];
                        if (d != m.src) m.dst.push_back(d);
                    }
                    moves.push_back(m);
                }
                check("random", moves);
            }
        }
    }
}

int main(int argc, char** argv) {
    if (argc != 2) {
        std::printf("usage: %s examples|random|status_strings\n", argv[0]);
        return 2;
    }
    if (std::strcmp(argv[1], "examples") == 0) run_examples();
    else if (std::strcmp(argv[1], "random") == 0) run_random();
    else if (std::strcmp(argv[1], "status_strings") == 0) run_status_strings();
    else {
        std::printf("unknown test set: %s\n", argv[1]);
        return 2;
    }

    if (failures > 0) {
        std::printf("%d check(s) failed\n", failures);
        return 1;
    }
    std::printf("all checks passed\n");
    return 0;
}
