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

    // How good a result is: people moved (more is better), then total growth of groups (less is better)
    struct score {
        size_t moved;
        size_t growth;
    };

    constexpr uint64_t test_seed = 12345;

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

    // Groups as "id:min/current/max"
    std::string describe(const vector<group_mover_group>& groups) {
        std::string text = "groups [";
        for (size_t i = 0; i < groups.size(); i++) {
            if (i > 0) text += ", ";
            text += std::to_string(groups[i].id) + ":" + std::to_string(groups[i].min_size) + "/" +
                    std::to_string(groups[i].current_size) + "/" + std::to_string(groups[i].max_size);
        }
        return text + "]";
    }

    void fail(const std::string& name, const vector<move>& moves, const std::string& reason) {
        failures++;
        const std::string shown_moves = moves.empty() ? "" : " " + describe(moves);
        std::printf("FAIL %s%s: %s\n", name.c_str(), shown_moves.c_str(), reason.c_str());
    }

    // Every group used by the moves, with bounds that keep its size fixed.
    // The current size is the number of people leaving it, the smallest size consistent with the moves.
    vector<group_mover_group> rigid_groups(const vector<move>& moves) {
        std::map<int32_t, size_t> sizes;
        for (const move& m : moves) {
            sizes[m.src] += 1;
            for (const int32_t d : m.dst) sizes.try_emplace(d, 0);
        }
        vector<group_mover_group> groups;
        for (const auto& [id, size] : sizes) groups.push_back({id, size, size, size});
        return groups;
    }

    // The moves as the C API expects them. They point into moves, which must outlive the result.
    vector<group_mover_move> api_moves(const vector<move>& moves) {
        vector<group_mover_move> result;
        for (const move& m : moves) result.push_back({m.src, m.dst.data(), m.dst.size()});
        return result;
    }

    int32_t run(const vector<group_mover_group>& groups, const vector<move>& moves, vector<int32_t>& assignments) {
        const vector<group_mover_move> c_moves = api_moves(moves);
        return group_mover_select_moves(groups.data(), groups.size(), c_moves.data(), c_moves.size(),
                                        test_seed, assignments.data());
    }

    // A group number that appears nowhere in the input, used to pre-fill assignments
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

    // Final size change of each group (indexed like groups) if every person i moves to assignments[i]
    vector<long long> size_changes(const vector<group_mover_group>& groups, const vector<move>& moves,
                                   const vector<int32_t>& assignments) {
        std::map<int32_t, size_t> index;
        for (size_t g = 0; g < groups.size(); g++) index[groups[g].id] = g;
        vector<long long> change(groups.size(), 0);
        for (size_t i = 0; i < moves.size(); i++) {
            if (assignments[i] == moves[i].src) continue;
            change[index.at(moves[i].src)] -= 1;
            change[index.at(assignments[i])] += 1;
        }
        return change;
    }

    bool within_bounds(const group_mover_group& group, const long long change) {
        const long long final_size = static_cast<long long>(group.current_size) + change;
        return final_size >= static_cast<long long>(group.min_size) &&
               final_size <= static_cast<long long>(group.max_size);
    }

    // Best possible score, found by trying every choice (stay, or any one of their destinations)
    // for every person and keeping only results where every group ends within its bounds
    score brute_force_best(const vector<group_mover_group>& groups, const vector<move>& moves) {
        std::map<int32_t, size_t> index;
        for (size_t g = 0; g < groups.size(); g++) index[groups[g].id] = g;
        vector<long long> change(groups.size(), 0);
        score best{0, 0};
        bool found = false;

        auto search = [&](auto& self, const size_t person, const size_t moved) -> void {
            if (person == moves.size()) {
                size_t growth = 0;
                for (size_t g = 0; g < groups.size(); g++) {
                    if (!within_bounds(groups[g], change[g])) return;
                    if (change[g] > 0) growth += static_cast<size_t>(change[g]);
                }
                if (!found || moved > best.moved || (moved == best.moved && growth < best.growth)) {
                    best = {moved, growth};
                    found = true;
                }
                return;
            }
            // The person stays
            self(self, person + 1, moved);
            // The person moves to one of their destinations
            const size_t from = index.at(moves[person].src);
            for (const int32_t d : moves[person].dst) {
                const size_t to = index.at(d);
                change[from] -= 1;
                change[to] += 1;
                self(self, person + 1, moved + 1);
                change[from] += 1;
                change[to] -= 1;
            }
        };
        search(search, 0, 0);
        return best;
    }

    // Runs the library and checks that the result is valid, keeps every group within its bounds,
    // moves as many people as possible while changing sizes as little as possible, and is the same
    // when run again with the same seed. Returns the result so callers can check for a specific answer.
    vector<int32_t> check(const std::string& name, const vector<move>& moves, const vector<group_mover_group>& groups) {
        vector<int32_t> assignments(moves.size(), unused_group(moves));
        const int32_t status = run(groups, moves, assignments);
        if (status != GROUP_MOVER_OK) {
            fail(name, moves, describe(groups) + " returned status " + std::to_string(status));
            return assignments;
        }

        size_t moved = 0;
        for (size_t i = 0; i < moves.size(); i++) {
            const bool stays = assignments[i] == moves[i].src;
            const bool allowed = stays || std::find(moves[i].dst.begin(), moves[i].dst.end(), assignments[i]) != moves[i].dst.end();
            if (!allowed) {
                fail(name, moves, "assignments[" + std::to_string(i) + "] is " + std::to_string(assignments[i]) +
                                  ", which is neither the source nor one of the destinations");
                return assignments;
            }
            if (!stays) moved++;
        }

        const vector<long long> change = size_changes(groups, moves, assignments);
        size_t growth = 0;
        for (size_t g = 0; g < groups.size(); g++) {
            if (!within_bounds(groups[g], change[g])) {
                fail(name, moves, describe(groups) + " result " + describe(assignments) + " puts group " +
                                  std::to_string(groups[g].id) + " outside its bounds");
                return assignments;
            }
            if (change[g] > 0) growth += static_cast<size_t>(change[g]);
        }

        const score best = brute_force_best(groups, moves);
        if (moved != best.moved) {
            fail(name, moves, describe(groups) + " moved " + std::to_string(moved) + " people, best is " +
                              std::to_string(best.moved));
        }
        else if (growth != best.growth) {
            fail(name, moves, describe(groups) + " changed sizes by " + std::to_string(growth) +
                              ", least possible is " + std::to_string(best.growth));
        }

        vector<int32_t> again(moves.size(), unused_group(moves));
        if (run(groups, moves, again) != GROUP_MOVER_OK || again != assignments) {
            fail(name, moves, "a second run with the same seed gave a different result");
        }
        return assignments;
    }

    vector<int32_t> check(const std::string& name, const vector<move>& moves) {
        return check(name, moves, rigid_groups(moves));
    }

    void check_exact(const std::string& name, const vector<move>& moves, const vector<group_mover_group>& groups,
                     const vector<int32_t>& expected) {
        const vector<int32_t> assignments = check(name, moves, groups);
        if (assignments != expected) {
            fail(name, moves, "result " + describe(assignments) + ", expected " + describe(expected));
        }
    }

    void check_exact(const std::string& name, const vector<move>& moves, const vector<int32_t>& expected) {
        check_exact(name, moves, rigid_groups(moves), expected);
    }

    // Checks that invalid input is rejected with the expected status and that assignments is left untouched
    void check_rejected(const std::string& name, const vector<move>& moves, const vector<group_mover_group>& groups,
                        const int32_t expected) {
        const int32_t sentinel = unused_group(moves);
        vector<int32_t> assignments(moves.size(), sentinel);
        const int32_t status = run(groups, moves, assignments);
        if (status != expected) {
            fail(name, moves, "returned status " + std::to_string(status) + ", expected " + std::to_string(expected));
        }
        if (assignments != vector<int32_t>(moves.size(), sentinel)) {
            fail(name, moves, "assignments was written despite the error");
        }
    }

    void check_rejected(const std::string& name, const vector<move>& moves, const int32_t expected) {
        check_rejected(name, moves, rigid_groups(moves), expected);
    }

    void check_status(const std::string& name, const group_mover_group* groups, const size_t group_count,
                      const group_mover_move* moves, const size_t move_count, int32_t* assignments,
                      const int32_t expected) {
        const int32_t status = group_mover_select_moves(groups, group_count, moves, move_count, test_seed, assignments);
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
        check_status_string(GROUP_MOVER_INVALID_MOVE, "invalid move");
        check_status_string(GROUP_MOVER_NO_GROUPS, "no groups");
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

        // Group list
        check_exact("groups listed in a different order than they are used",
                    {{1, {2}}, {2, {3}}, {3, {1}}},
                    {{3, 1, 1, 1}, {1, 1, 1, 1}, {2, 1, 1, 1}},
                    {2, 3, 1});
        check_exact("groups not used by any move",
                    {{1, {2}}, {2, {1}}},
                    {{7, 4, 4, 4}, {1, 1, 1, 1}, {8, 0, 0, 0}, {2, 1, 1, 1}},
                    {2, 1});

        // Slack: group sizes may change within their bounds
        check_exact("slack lets a lone move happen", {{1, {2}}},
                    {{1, 9, 10, 10}, {2, 10, 10, 11}}, {2});
        check_exact("slack in the wrong directions does not help", {{1, {2}}},
                    {{1, 10, 10, 11}, {2, 9, 10, 10}}, {1});
        check_exact("slack at both ends of a chain", {{1, {2}}, {2, {3}}},
                    {{1, 0, 1, 1}, {2, 1, 1, 1}, {3, 0, 0, 1}}, {2, 3});
        check("slack is limited by the bounds", {{1, {2}}, {1, {2}}, {1, {2}}},
              {{1, 1, 3, 3}, {2, 0, 0, 2}});
        check_exact("redirect preferred over slack", {{1, {2, 3}}, {3, {1}}},
                    {{1, 1, 1, 1}, {2, 0, 0, 1}, {3, 0, 1, 1}}, {3, 1});
        check_exact("slack not used when nothing needs it", {{1, {2}}, {2, {1}}},
                    {{1, 0, 1, 2}, {2, 0, 1, 2}}, {2, 1});

        // Invalid moves
        check_rejected("self move", {{3, {3}}}, GROUP_MOVER_SELF_MOVE);
        check_rejected("self move among other destinations", {{1, {2, 1, 3}}}, GROUP_MOVER_SELF_MOVE);
        check_rejected("self move in a later move", {{1, {2, 3}}, {2, {1}}, {4, {5, 4}}}, GROUP_MOVER_SELF_MOVE);
        check_rejected("no destinations", {{1, {2}}, {2, {}}}, GROUP_MOVER_NO_DESTINATION);
        check_rejected("source not in groups", {{1, {2}}, {2, {1}}}, {{2, 1, 1, 1}}, GROUP_MOVER_INVALID_MOVE);
        check_rejected("destination not in groups", {{1, {2, 3}}, {2, {1}}},
                       {{1, 1, 1, 1}, {2, 1, 1, 1}}, GROUP_MOVER_INVALID_MOVE);
        check_rejected("no groups", {{1, {2}}, {2, {1}}}, {}, GROUP_MOVER_NO_GROUPS);

        // Invalid groups
        check_rejected("current size below minimum", {{1, {2}}, {2, {1}}},
                       {{1, 2, 1, 3}, {2, 1, 1, 1}}, GROUP_MOVER_INVALID_GROUP);
        check_rejected("current size above maximum", {{1, {2}}, {2, {1}}},
                       {{1, 1, 1, 1}, {2, 0, 2, 1}}, GROUP_MOVER_INVALID_GROUP);
        check_rejected("group listed twice", {{1, {2}}, {2, {1}}},
                       {{1, 1, 1, 1}, {2, 1, 1, 1}, {1, 1, 1, 1}}, GROUP_MOVER_INVALID_GROUP);
        constexpr size_t int32_limit = std::numeric_limits<int32_t>::max();
        check_exact("maximum size at the limit", {{1, {2}}, {2, {1}}},
                    {{1, 1, 1, int32_limit}, {2, 1, 1, 1}}, {2, 1});
        check_rejected("maximum size above the limit", {{1, {2}}, {2, {1}}},
                       {{1, 1, 1, int32_limit + 1}, {2, 1, 1, 1}}, GROUP_MOVER_INVALID_GROUP);

        // Null pointers
        const int32_t dst[] = {2};
        group_mover_group groups[] = {{1, 1, 1, 1}, {2, 0, 0, 0}};
        group_mover_group invalid_groups[] = {{1, 2, 1, 1}};
        group_mover_move moves[] = {{1, dst, 1}};
        group_mover_move null_dst_moves[] = {{1, nullptr, 1}};
        int32_t assignments[] = {0};
        check_status("no moves", nullptr, 0, nullptr, 0, nullptr, GROUP_MOVER_OK);
        check_status("no moves, invalid groups ignored", invalid_groups, 1, nullptr, 0, nullptr, GROUP_MOVER_OK);
        check_status("null groups", nullptr, 2, moves, 1, assignments, GROUP_MOVER_NULL_ARGUMENT);
        check_status("null moves", groups, 2, nullptr, 1, assignments, GROUP_MOVER_NULL_ARGUMENT);
        check_status("null assignments", groups, 2, moves, 1, nullptr, GROUP_MOVER_NULL_ARGUMENT);
        check_status("null destinations", groups, 2, null_dst_moves, 1, assignments, GROUP_MOVER_NULL_ARGUMENT);
    }

    // Compares the library against brute force on many small random inputs,
    // with groups numbered from 1, from 0, and scattered over the whole int32_t range,
    // listed in a random order, and every other input allowing group sizes to change
    void run_random() {
        std::mt19937 rng(12345);
        std::uniform_int_distribution<int32_t> any_group(std::numeric_limits<int32_t>::min(),
                                                         std::numeric_limits<int32_t>::max());
        std::uniform_int_distribution<size_t> slack(0, 2);
        for (int numbering = 0; numbering < 3; numbering++) {
            for (int test = 0; test < 800; test++) {
                const int group_count = std::uniform_int_distribution(2, 6)(rng);
                const int move_count = std::uniform_int_distribution(0, 8)(rng);

                vector<int32_t> ids;
                for (int g = 0; g < group_count; g++) {
                    if (numbering == 0) ids.push_back(g + 1);
                    else if (numbering == 1) ids.push_back(g);
                    else ids.push_back(any_group(rng));
                }

                vector<move> moves;
                std::uniform_int_distribution<size_t> pick(0, ids.size() - 1);
                for (int i = 0; i < move_count; i++) {
                    move m{ids[pick(rng)], {}};
                    const int dst_count = std::uniform_int_distribution(1, 3)(rng);
                    while (static_cast<int>(m.dst.size()) < dst_count) {
                        // Destinations may repeat, but never equal the source
                        const int32_t d = ids[pick(rng)];
                        if (d != m.src) m.dst.push_back(d);
                    }
                    moves.push_back(m);
                }

                vector<group_mover_group> groups = rigid_groups(moves);
                if (test % 2 == 1) {
                    // Let each group grow and shrink by up to 2, with some extra people who don't want to move
                    for (group_mover_group& group : groups) {
                        group.current_size += slack(rng);
                        const size_t shrink = std::min(slack(rng), group.current_size);
                        group.min_size = group.current_size - shrink;
                        group.max_size = group.current_size + slack(rng);
                    }
                }
                std::shuffle(groups.begin(), groups.end(), rng);
                check("random", moves, groups);
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
