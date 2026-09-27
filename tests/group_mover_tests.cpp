#include "group-mover.h"

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>
#include <map>
#include <random>
#include <string>
#include <vector>

using std::vector;

namespace {
    struct move {
        int32_t src;
        int32_t dst;
    };

    int failures = 0;

    std::string describe(const vector<move>& moves) {
        std::string text = "[";
        for (size_t i = 0; i < moves.size(); i++) {
            if (i > 0) text += ", ";
            text += std::to_string(moves[i].src) + "->" + std::to_string(moves[i].dst);
        }
        return text + "]";
    }

    void fail(const std::string& name, const vector<move>& moves, const std::string& reason) {
        failures++;
        std::printf("FAIL %s %s: %s\n", name.c_str(), describe(moves).c_str(), reason.c_str());
    }

    // Returns true if every group receives as many kept moves as it sends
    bool balanced(const vector<move>& moves, const vector<uint8_t>& keep) {
        std::map<int32_t, int> balance;
        for (size_t i = 0; i < moves.size(); i++) {
            if (!keep[i]) continue;
            balance[moves[i].src] += 1;
            balance[moves[i].dst] -= 1;
        }
        for (const auto& [group, value] : balance) {
            if (value != 0) return false;
        }
        return true;
    }

    // Largest number of moves that can be kept, found by trying every subset
    size_t brute_force_best(const vector<move>& moves) {
        const size_t move_count = moves.size();
        size_t best = 0;
        vector<uint8_t> keep(move_count);
        for (uint32_t mask = 0; mask < (1u << move_count); mask++) {
            size_t kept = 0;
            for (size_t i = 0; i < move_count; i++) {
                keep[i] = (mask >> i) & 1u;
                kept += keep[i];
            }
            if (kept > best && balanced(moves, keep)) best = kept;
        }
        return best;
    }

    // Runs the library and checks that the result is valid and keeps as many moves as possible.
    // Returns the result so callers can check for a specific answer.
    vector<uint8_t> check(const std::string& name, const vector<move>& moves) {
        vector<int32_t> src, dst;
        for (const move& m : moves) {
            src.push_back(m.src);
            dst.push_back(m.dst);
        }
        // Fill with a value the library never writes, to catch entries it forgets to set
        vector<uint8_t> keep(moves.size(), 7);

        const int32_t status = group_mover_select_moves(src.data(), dst.data(), moves.size(), keep.data());
        if (status != GROUP_MOVER_OK) {
            fail(name, moves, "returned status " + std::to_string(status));
            return keep;
        }

        size_t kept = 0;
        for (const uint8_t value : keep) {
            if (value > 1) {
                fail(name, moves, "keep contains " + std::to_string(value));
                return keep;
            }
            kept += value;
        }
        if (!balanced(moves, keep)) {
            fail(name, moves, "kept moves change group sizes");
        }
        const size_t best = brute_force_best(moves);
        if (kept != best) {
            fail(name, moves, "kept " + std::to_string(kept) + " moves, best is " + std::to_string(best));
        }
        return keep;
    }

    void check_exact(const std::string& name, const vector<move>& moves, const vector<uint8_t>& expected) {
        if (check(name, moves) != expected) fail(name, moves, "unexpected choice of moves");
    }

    void check_status(const std::string& name, const int32_t* src, const int32_t* dst, size_t move_count,
                      uint8_t* keep, int32_t expected) {
        const int32_t status = group_mover_select_moves(src, dst, move_count, keep);
        if (status != expected) {
            fail(name, {}, "returned status " + std::to_string(status) + ", expected " + std::to_string(expected));
        }
    }

    void run_examples() {
        check_exact("cycle with extra move", {{1, 2}, {2, 3}, {3, 1}, {1, 3}}, {1, 1, 1, 0});
        check_exact("pure cycle", {{1, 2}, {2, 3}, {3, 4}, {4, 1}}, {1, 1, 1, 1});
        check_exact("swap", {{1, 2}, {2, 1}}, {1, 1});
        check_exact("chain", {{1, 2}, {2, 3}}, {0, 0});
        check_exact("self move", {{3, 3}}, {1});
        check_exact("self move next to chain", {{1, 2}, {3, 3}}, {0, 1});
        check("duplicate moves", {{1, 2}, {1, 2}, {2, 1}});
        check("two cycles sharing a group", {{1, 2}, {2, 1}, {1, 3}, {3, 1}, {2, 3}});
        check("overlapping paths",{{1, 2}, {2, 3}, {1, 4}, {4, 5}, {5, 3}, {6, 2}, {3, 1}, {3, 6}});

        check_exact("group zero", {{0, 1}, {1, 0}, {0, 2}}, {1, 1, 0});
        check_exact("scattered and negative groups",
                    {{1000000000, -5}, {-5, 7}, {7, 1000000000}, {7, -5}}, {1, 1, 1, 0});
        constexpr int32_t low = std::numeric_limits<int32_t>::min();
        constexpr int32_t high = std::numeric_limits<int32_t>::max();
        check_exact("extreme group numbers", {{low, high}, {high, low}}, {1, 1});

        int32_t src[] = {1};
        int32_t dst[] = {2};
        uint8_t keep[] = {0};
        check_status("no moves", nullptr, nullptr, 0, nullptr, GROUP_MOVER_OK);
        check_status("null src", nullptr, dst, 1, keep, GROUP_MOVER_NULL_ARGUMENT);
        check_status("null dst", src, nullptr, 1, keep, GROUP_MOVER_NULL_ARGUMENT);
        check_status("null keep", src, dst, 1, nullptr, GROUP_MOVER_NULL_ARGUMENT);
    }

    // Compares the library against brute force on many small random inputs,
    // with groups numbered from 1, from 0, and scattered over the whole int32_t range
    void run_random() {
        std::mt19937 rng(12345);
        std::uniform_int_distribution<int32_t> any_group(std::numeric_limits<int32_t>::min(),
                                                         std::numeric_limits<int32_t>::max());
        for (int numbering = 0; numbering < 3; numbering++) {
            for (int test = 0; test < 400; test++) {
                const int group_count = std::uniform_int_distribution(1, 6)(rng);
                const int move_count = std::uniform_int_distribution(0, 12)(rng);

                vector<int32_t> groups;
                for (int g = 0; g < group_count; g++) {
                    if (numbering == 0) groups.push_back(g + 1);
                    else if (numbering == 1) groups.push_back(g);
                    else groups.push_back(any_group(rng));
                }

                vector<move> moves;
                std::uniform_int_distribution<size_t> pick(0, groups.size() - 1);
                for (int i = 0; i < move_count; i++) {
                    moves.push_back({groups[pick(rng)], groups[pick(rng)]});
                }
                check("random", moves);
            }
        }
    }
}

int main(int argc, char** argv) {
    if (argc != 2) {
        std::printf("usage: %s examples|random\n", argv[0]);
        return 2;
    }
    if (std::strcmp(argv[1], "examples") == 0) run_examples();
    else if (std::strcmp(argv[1], "random") == 0) run_random();
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
