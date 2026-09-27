#include "group-mover.h"

#include <unordered_map>
#include <stdexcept>
#include <vector>
#include <limits>
#include <queue>
#include <new>

namespace {
    using std::vector, std::queue, std::unordered_map;

    constexpr size_t no_node = std::numeric_limits<size_t>::max();
    constexpr size_t no_edge = std::numeric_limits<size_t>::max();

    struct edge {
        size_t destination;
        int capacity;
        int cost;
    };

    struct flow_network {
        vector<edge> edges;
        vector<vector<size_t>> outgoing;
        vector<int> balance;

        size_t add_node() {
            outgoing.emplace_back();
            balance.push_back(0);
            return balance.size() - 1;
        }

        size_t add_edge(const size_t src, const size_t dst, const int cap, const int cost) {
            outgoing[src].push_back(edges.size());
            edges.push_back({.destination = dst, .capacity = cap, .cost = cost});
            outgoing[dst].push_back(edges.size());
            edges.push_back({.destination = src, .capacity = 0, .cost = -cost});
            return edges.size() - 2;
        }

        void push_flow(const size_t edge_id) {
            if (edges[edge_id].capacity <= 0) {
                throw std::logic_error("Attempted to push flow along an edge with capacity <= 0");
            }
            edges[edge_id].capacity -= 1;
            edges[edge_id ^ 1].capacity += 1;
        }
    };

    struct spfa_result {
        vector<int> cost;
        vector<size_t> prev_edge;

        explicit spfa_result(const size_t node_count):
            cost(node_count, std::numeric_limits<int>::max()),
            prev_edge(node_count, no_edge) {}
    };

    spfa_result spfa(const flow_network& network, const size_t source) {
        const size_t node_count = network.balance.size();
        spfa_result result(node_count);
        result.cost[source] = 0;
        vector<bool> in_queue(node_count, false);
        in_queue[source] = true;
        queue<size_t> next;
        next.push(source);

        while (!next.empty()) {
            const size_t current_node = next.front();
            in_queue[current_node] = false;
            next.pop();
            // Check all outgoing edges with capacity > 0 for creating a cheaper path to a node
            for (const size_t current_edge: network.outgoing[current_node]) {
                if (network.edges[current_edge].capacity == 0) continue;

                const int new_cost = result.cost[current_node] + network.edges[current_edge].cost;
                const size_t target_node = network.edges[current_edge].destination;
                if (new_cost < result.cost[target_node]) {
                    result.prev_edge[target_node] = current_edge;
                    result.cost[target_node] = new_cost;
                    if (!in_queue[target_node]) {
                        in_queue[target_node] = true;
                        next.push(target_node);
                    }
                }
            }
        }
        return result;
    }

    void balance_network(flow_network& network) {
        const size_t node_count = network.balance.size();
        bool finished = false;
        while (!finished) {
            finished = true; // Assume the network is balanced until a surplus node is found

            // For any surplus node, find and drop the cheapest chain to a deficit node
            for (size_t surplus_node = 0; surplus_node < node_count; surplus_node++) {
                // Skip a non-surplus node
                if (network.balance[surplus_node] <= 0) continue;
                finished = false; // Mark that there are still unbalanced nodes

                // Use the SPFA algorithm on the current version of the network
                spfa_result result = spfa(network, surplus_node);

                // Find cheapest deficit node to reach from the surplus node
                size_t deficit_node = no_node;
                int lowest_cost = std::numeric_limits<int>::max();
                for (size_t target_node = 0; target_node < node_count; target_node++) {
                    if (network.balance[target_node] < 0 && result.cost[target_node] < lowest_cost) {
                        lowest_cost = result.cost[target_node];
                        deficit_node = target_node;
                    }
                }
                if (deficit_node == no_node) throw std::logic_error("No deficit node found to pair with surplus node");

                // Backtrack from the deficit node to the surplus node, pushing flow along the way
                size_t current_node = deficit_node;
                while (current_node != surplus_node) {
                    const size_t current_edge = result.prev_edge[current_node];
                    network.push_flow(current_edge);
                    current_node = network.edges[current_edge ^ 1].destination;
                }
                network.balance[surplus_node] -= 1;
                network.balance[deficit_node] += 1;
            }
        }
    }

    void select_moves(const int32_t* src, const size_t* dst_counts, const int32_t* dst, const size_t move_count, int32_t* result) {
        // Create the flow network, as well as group_id -> node_id and move_id -> edge_id maps
        flow_network network;
        unordered_map<int32_t, size_t> group_map;
        vector<size_t> move_map;
        move_map.reserve(move_count);

        size_t dst_pos = 0;
        for (size_t i = 0; i < move_count; i++) { // Iterate over source groups (and at the same time moves)
            // Get source node's mapped id, or create the node and map it
            size_t source;
            if (const auto it = group_map.find(src[i]); it != group_map.end()) {
                source = it->second;
            }
            else {
                source = network.add_node();
                group_map.emplace(src[i], source);
            }

            // Create the person node
            const size_t person = network.add_node();
            // Create an edge from source to person and map it to the i'th move
            move_map.push_back(network.add_edge(source, person, 1, 1));

            for (size_t j = 0; j < dst_counts[i]; j++) { // Run loop once for each possible destination
                // Get destination node's mapped id, or create the node and map it
                size_t destination;
                if (const auto it = group_map.find(dst[dst_pos]); it != group_map.end()) {
                    destination = it->second;
                }
                else {
                    destination = network.add_node();
                    group_map.emplace(dst[dst_pos], destination);
                }
                // Create an edge from person to destination and immediately push flow along it (drop it)
                const size_t dst_edge = network.add_edge(person, destination, 1, 1);
                network.push_flow(dst_edge);
                // Iterate over destination array
                dst_pos++;
            }
            const size_t kept_edge = network.edges.size() - 2; // The normal edge
            // Push flow along twin of last normal edge to undrop it - arbitrary but convenient
            network.push_flow(kept_edge ^ 1);

            // Set balances for source and destination node - person nodes always have balance = 0
            network.balance[source] += 1;
            network.balance[network.edges[kept_edge].destination] -= 1;
        }

        // Balance all nodes in the network
        balance_network(network);

        // Write the results into result
        dst_pos = 0;
        for (size_t i = 0; i < move_count; i++) {
            const size_t person_edge = move_map[i];

            // Put source node in result if the move was completely dropped - the person remains there
            if (network.edges[person_edge].capacity == 0) {
                result[i] = src[i];
                dst_pos += dst_counts[i];
                continue;
            }

            const size_t person_node = network.edges[person_edge].destination;
            for (size_t destination_edge: network.outgoing[person_node]) {
                // Skip twin edges completely
                if (destination_edge % 2 == 1) continue;

                // Check if the edge is undropped
                if (network.edges[destination_edge].capacity == 1) result[i] = dst[dst_pos];

                dst_pos++; // Increment the dst position only if a non-twin edge was considered
            }
        }
    }
}

extern "C" int32_t group_mover_select_moves(const int32_t* src, const size_t* dst_counts, const int32_t* dst, const size_t move_count, int32_t* result) {
    // Instantly return if there are no moves
    if (move_count == 0) return GROUP_MOVER_OK;
    // Return error if null pointers were provided
    if (src == nullptr || dst_counts == nullptr || dst == nullptr || result == nullptr) return GROUP_MOVER_NULL_ARGUMENT;
    // Check for self-moves or moves with no destination
    size_t dst_pos = 0;
    for (size_t i = 0; i < move_count; i++) {
        if (dst_counts[i] == 0) return GROUP_MOVER_NO_DESTINATION;
        for (size_t j = 0; j < dst_counts[i]; j++) {
            if (src[i] == dst[dst_pos]) return GROUP_MOVER_SELF_MOVE;
            dst_pos++;
        }
    }
    // Call the implementation
    try {
        select_moves(src, dst_counts, dst, move_count, result);
    }
    catch (const std::bad_alloc&) {
        return GROUP_MOVER_OUT_OF_MEMORY;
    }
    catch (...) {
        return GROUP_MOVER_INTERNAL_ERROR;
    }
    return GROUP_MOVER_OK;
}

extern "C" const char* group_mover_status_string(const int32_t status_code) {
    switch (status_code) {
        case GROUP_MOVER_OK: return "ok";
        case GROUP_MOVER_NULL_ARGUMENT: return "null argument";
        case GROUP_MOVER_INVALID_GROUP: return "invalid group";
        case GROUP_MOVER_OUT_OF_MEMORY: return "out of memory";
        case GROUP_MOVER_INTERNAL_ERROR: return "internal error";
        case GROUP_MOVER_NO_DESTINATION: return "move with no destination";
        case GROUP_MOVER_SELF_MOVE: return "move with destination equal to source";
        default: return "unknown error";
    }
}
