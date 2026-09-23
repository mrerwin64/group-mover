#include "group-mover.h"

#include <stdexcept>
#include <vector>
#include <limits>
#include <queue>
#include <new>

static void implementation(const int32_t* src, const int32_t* dst, const size_t move_count, const size_t group_count, uint8_t* keep) {
    using std::vector, std::queue;

    // Prepare containers for graph data
    vector<vector<int>> active_vec(group_count+1, vector(group_count+1, 0));
    vector<vector<int>> dropped_vec(group_count+1, vector(group_count+1, 0));
    vector<int> balance_vec(group_count+1, 0);

    // Fill initial state of the graph
    for (size_t i = 0; i < move_count; i++) {
        const size_t source = src[i];
        const size_t destination = dst[i];
        balance_vec[source] += 1;
        balance_vec[destination] -= 1;
        active_vec[source][destination] += 1;
    }

    // Balance all nodes in the graph
    while (true) {
        // Track whether any node is unbalanced
        bool finished = true;

        // For any surplus node, find and drop the cheapest chain to a deficit node
        for (size_t surplus_node = 1; surplus_node <= group_count; surplus_node++) {
            // Skip a non-surplus node
            if (balance_vec[surplus_node] <= 0) continue;
            finished = false;

            // Prepare variables holding state for SPFA algorithm
            vector<int> cost(group_count+1, std::numeric_limits<int>::max());
            cost[surplus_node] = 0;
            vector<size_t> previous(group_count+1, 0);
            queue<size_t> next;
            next.push(surplus_node);

            // Calculate cost to all other nodes
            while (!next.empty()) {
                const size_t current_node = next.front();
                next.pop();
                // Look for forward active edges and backwards dropped edges
                for (size_t target_node = 1; target_node <= group_count; target_node++) {
                    if (active_vec[current_node][target_node] > 0) {
                        if (const int new_cost = cost[current_node] + 1; new_cost < cost[target_node]) {
                            previous[target_node] = current_node;
                            cost[target_node] = new_cost;
                            next.push(target_node);
                        }
                    }
                    if (dropped_vec[target_node][current_node] > 0) {
                        if (const int new_cost = cost[current_node] - 1; new_cost < cost[target_node]) {
                            previous[target_node] = current_node;
                            cost[target_node] = new_cost;
                            next.push(target_node);
                        }
                    }
                }
            }

            // Find cheapest to reach deficit node
            size_t deficit_node = 0;
            int lowest_cost = std::numeric_limits<int>::max();
            for (size_t target_node = 1; target_node <= group_count; target_node++) {
                if (balance_vec[target_node] < 0 && cost[target_node] < lowest_cost) {
                    lowest_cost = cost[target_node];
                    deficit_node = target_node;
                }
            }

            // Backtrack from the deficit node to the surplus node, flipping edges along the way
            size_t current_node = deficit_node;
            while (current_node != surplus_node) {
                const size_t next_node = previous[current_node];
                if (dropped_vec[current_node][next_node] > 0) {
                    dropped_vec[current_node][next_node] -= 1;
                    active_vec[current_node][next_node] += 1;
                    balance_vec[current_node] += 1;
                    balance_vec[next_node] -= 1;
                }
                else if (active_vec[next_node][current_node] > 0) {
                    active_vec[next_node][current_node] -= 1;
                    dropped_vec[next_node][current_node] += 1;
                    balance_vec[next_node] -= 1;
                    balance_vec[current_node] += 1;
                }
                else {
                    throw std::logic_error("No edge to flip on path from surplus to deficit node");
                }
                current_node = next_node;
            }
        }
        if (finished) break;
    }

    // Deliver the results
    for (size_t i = 0; i < move_count; i++) {
        const size_t source = src[i];
        const size_t destination = dst[i];
        if (active_vec[source][destination] > 0) {
            keep[i] = 1;
            active_vec[source][destination] -= 1;
        }
        else {
            keep[i] = 0;
        }
    }
}

extern "C" int32_t group_mover_select_moves(const int32_t* src, const int32_t* dst, const size_t move_count, uint8_t* keep) {
    // Instantly return if there are no moves
    if (move_count == 0) return GROUP_MOVER_OK;
    // Return error if null pointers were provided
    if (src == nullptr || dst == nullptr || keep == nullptr) return GROUP_MOVER_NULL_ARGUMENT;
    // Check for invalid groups and maximum group number
    size_t group_count = 0;
    for (size_t i = 0; i < move_count; i++) {
        if (src[i] < 1 || dst[i] < 1) return GROUP_MOVER_INVALID_GROUP;
        if (src[i] > group_count) group_count = src[i];
        if (dst[i] > group_count) group_count = dst[i];
    }
    // Call the implementation
    try {
        implementation(src, dst, move_count, group_count, keep);
    }
    catch (const std::bad_alloc&) {
        return GROUP_MOVER_OUT_OF_MEMORY;
    }
    catch (...) {
        return GROUP_MOVER_INTERNAL_ERROR;
    }
    return GROUP_MOVER_OK;
}
