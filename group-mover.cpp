#include "group-mover.h"

#include <stdexcept>
#include <vector>
#include <limits>
#include <queue>
#include <new>

namespace {
    using std::vector, std::queue;

    struct flow_network {
        vector<vector<int>> active;
        vector<vector<int>> dropped;
        vector<int> balance;

        explicit flow_network(const size_t node_count):
            active(node_count, vector(node_count, 0)),
            dropped(node_count, vector(node_count, 0)),
            balance(node_count, 0) {}
    };

    struct spfa_result {
        vector<int> cost;
        vector<size_t> prev;

        explicit spfa_result(const size_t node_count):
            cost(node_count, std::numeric_limits<int>::max()),
            prev(node_count, 0) {}
    };

    spfa_result spfa(const flow_network& network, const size_t source) {
        const size_t node_count = network.balance.size();
        spfa_result result(node_count);
        result.cost[source] = 0;
        queue<size_t> next;
        next.push(source);

        while (!next.empty()) {
            const size_t current_node = next.front();
            next.pop();
            // Look for forward active edges and backwards dropped edges
            for (size_t target_node = 1; target_node < node_count; target_node++) {
                if (network.active[current_node][target_node] > 0) {
                    if (const int new_cost = result.cost[current_node] + 1; new_cost < result.cost[target_node]) {
                        result.prev[target_node] = current_node;
                        result.cost[target_node] = new_cost;
                        next.push(target_node);
                    }
                }
                if (network.dropped[target_node][current_node] > 0) {
                    if (const int new_cost = result.cost[current_node] - 1; new_cost < result.cost[target_node]) {
                        result.prev[target_node] = current_node;
                        result.cost[target_node] = new_cost;
                        next.push(target_node);
                    }
                }
            }
        }
        return result;
    }

    void implementation(const int32_t* src, const int32_t* dst, const size_t move_count, const size_t group_count, uint8_t* keep) {
        // Create the network
        flow_network network(group_count + 1);
        for (size_t i = 0; i < move_count; i++) {
            const size_t source = src[i];
            const size_t destination = dst[i];
            network.balance[source] += 1;
            network.balance[destination] -= 1;
            network.active[source][destination] += 1;
        }

        // Balance all nodes in the network
        bool finished = false;
        while (!finished) {
            finished = true; // Assume the network is balanced until a surplus node is found

            // For any surplus node, find and drop the cheapest chain to a deficit node
            for (size_t surplus_node = 1; surplus_node <= group_count; surplus_node++) {
                // Skip a non-surplus node
                if (network.balance[surplus_node] <= 0) continue;
                finished = false; // Mark that there are still unbalanced nodes

                // Use the SPFA algorithm on the current version of the network
                spfa_result result = spfa(network, surplus_node);

                // Find cheapest deficit node to reach from the surplus node
                size_t deficit_node = 0;
                int lowest_cost = std::numeric_limits<int>::max();
                for (size_t target_node = 1; target_node <= group_count; target_node++) {
                    if (network.balance[target_node] < 0 && result.cost[target_node] < lowest_cost) {
                        lowest_cost = result.cost[target_node];
                        deficit_node = target_node;
                    }
                }

                // Backtrack from the deficit node to the surplus node, flipping edges along the way
                size_t current_node = deficit_node;
                while (current_node != surplus_node) {
                    const size_t next_node = result.prev[current_node];
                    if (network.dropped[current_node][next_node] > 0) {
                        network.dropped[current_node][next_node] -= 1;
                        network.active[current_node][next_node] += 1;
                        network.balance[current_node] += 1;
                        network.balance[next_node] -= 1;
                    }
                    else if (network.active[next_node][current_node] > 0) {
                        network.active[next_node][current_node] -= 1;
                        network.dropped[next_node][current_node] += 1;
                        network.balance[next_node] -= 1;
                        network.balance[current_node] += 1;
                    }
                    else {
                        throw std::logic_error("No edge to flip on path from surplus to deficit node");
                    }
                    current_node = next_node;
                }
            }
        }

        // Write the results into keep
        for (size_t i = 0; i < move_count; i++) {
            const size_t source = src[i];
            const size_t destination = dst[i];
            if (network.active[source][destination] > 0) {
                keep[i] = 1;
                network.active[source][destination] -= 1;
            }
            else {
                keep[i] = 0;
            }
        }
    }
}

extern "C" int32_t group_mover_select_moves(const int32_t* src, const int32_t* dst, const size_t move_count, uint8_t* keep) {
    // Instantly return if there are no moves
    if (move_count == 0) return GROUP_MOVER_OK;
    // Return error if null pointers were provided
    if (src == nullptr || dst == nullptr || keep == nullptr) return GROUP_MOVER_NULL_ARGUMENT;
    // Check for invalid groups and update maximum group number
    size_t group_count = 0;
    for (size_t i = 0; i < move_count; i++) {
        if (src[i] < 1 || dst[i] < 1) return GROUP_MOVER_INVALID_GROUP;
        if (static_cast<size_t>(src[i]) > group_count) group_count = src[i];
        if (static_cast<size_t>(dst[i]) > group_count) group_count = dst[i];
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
