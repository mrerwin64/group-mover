#include "group-mover.h"

#include <unordered_map>
#include <unordered_set>
#include <stdexcept>
#include <vector>
#include <limits>
#include <queue>
#include <span>
#include <new>

namespace {
    using std::vector, std::queue, std::unordered_map, std::span, std::unordered_set;

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

    void select_moves(span<const group_mover_group> groups, span<const group_mover_move> moves, [[maybe_unused]] const uint64_t seed, span<int32_t> assignments) {
        // Create the flow network, as well as group_id -> node_id and move_id -> edge_id maps
        flow_network network;
        unordered_map<int32_t, size_t> group_map;
        group_map.reserve(groups.size());
        vector<size_t> move_map;
        move_map.reserve(moves.size());

        // Create the slack node
        const size_t slack_node = network.add_node();
        // Create group nodes and edges to the slack node
        for (const group_mover_group& current_group: groups) {
            const size_t group_node = network.add_node();
            group_map.emplace(current_group.id, group_node);
            // Add edge which allows the group to shrink
            const size_t max_shrink = current_group.current_size - current_group.min_size;
            network.add_edge(group_node, slack_node, static_cast<int>(max_shrink), 1);
            // Add edge which allows the group to grow
            const size_t max_grow = current_group.max_size - current_group.current_size;
            network.add_edge(slack_node, group_node, static_cast<int>(max_grow), 1);
        }

        // Create move (person) nodes and edges connecting them to source and destination nodes
        for (const group_mover_move& current_move: moves) {
            const size_t move_node = network.add_node();
            const size_t src_node = group_map.at(current_move.src);
            // Create source -> move edge and save it in the move map
            const size_t source_edge = network.add_edge(src_node, move_node, 1, 2);
            move_map.push_back(source_edge);
            // Create move -> destination edges, dropping all but the first one
            bool first = true;
            size_t first_edge = no_edge;
            for (const int32_t dst_node: span(current_move.dst, current_move.dst_count)) {
                const size_t new_edge = network.add_edge(move_node, group_map.at(dst_node), 1, 2);
                if (first) {
                    first_edge = new_edge;
                    first = false;
                }
                else {
                    network.push_flow(new_edge);
                }
            }
            // Set balances for source and destination nodes
            network.balance[src_node] += 1;
            network.balance[network.edges[first_edge].destination] -= 1;
        }

        // Balance all nodes in the network
        balance_network(network);

        // Write each person's final group into assignments
        for (size_t i = 0; i < assignments.size(); i++) {
            const size_t person_edge = move_map[i];

            // Put the source group in assignments if the move was completely dropped - the person remains there
            if (network.edges[person_edge].capacity == 0) {
                assignments[i] = moves[i].src;
                continue;
            }

            // Check where the person ended up otherwise
            const size_t person_node = network.edges[person_edge].destination;
            for (const size_t destination_edge: network.outgoing[person_node]) {
                // Completely ignore twin edges (odd indexes)
                if (destination_edge % 2 == 1) continue;
                // For normal edges, check if they are active
                if (network.edges[destination_edge].capacity == 1) {
                    const size_t destination_node = network.edges[destination_edge].destination;
                    // Since group nodes are created after the single slack node and in order,
                    // their indexes in the network are higher by exactly one than in the input array
                    assignments[i] = groups[destination_node - 1].id;
                }
            }
        }
    }
}

extern "C" int32_t group_mover_select_moves(const group_mover_group* groups, const size_t group_count,
    const group_mover_move* moves, const size_t move_count,
    const uint64_t seed, int32_t* assignments) try {
    // Instantly return if there are no moves
    if (move_count == 0) return GROUP_MOVER_OK;
    // Return an error if there are no groups (but there are moves)
    if (group_count == 0) return GROUP_MOVER_NO_GROUPS;
    // Return an error if null pointers were provided as an argument
    if (groups == nullptr || moves == nullptr || assignments == nullptr) return GROUP_MOVER_NULL_ARGUMENT;
    // Create a list of valid group ids and check for groups with too little or too many members, or too large max_size
    unordered_set<int32_t> group_ids;
    for (size_t i = 0; i < group_count; i++) {
        const auto& [group_id, min_size, current_size, max_size] = groups[i];
        if (current_size < min_size || current_size > max_size) {
            return GROUP_MOVER_INVALID_GROUP;
        }
        if (max_size > std::numeric_limits<int32_t>::max()) return GROUP_MOVER_INVALID_GROUP;
        if (!group_ids.insert(group_id).second) return GROUP_MOVER_INVALID_GROUP;
    }
    // Check if each move has at least one destination, no destination == source, and doesn't reference invalid groups
    for (size_t i = 0; i < move_count; i++) {
        const auto& [src, dst_arr, dst_count] = moves[i];
        if (!group_ids.contains(src)) return GROUP_MOVER_INVALID_MOVE;
        if (dst_count == 0) return GROUP_MOVER_NO_DESTINATION;
        if (dst_arr == nullptr) return GROUP_MOVER_NULL_ARGUMENT;
        for (size_t j = 0; j < dst_count; j++) {
            const int32_t dst = dst_arr[j];
            if (dst == src) return GROUP_MOVER_SELF_MOVE;
            if (!group_ids.contains(dst)) return GROUP_MOVER_INVALID_MOVE;
        }
    }
    // Call the implementation using std::span
    select_moves({groups, group_count}, {moves, move_count}, seed, {assignments, move_count});
    return GROUP_MOVER_OK;
}
catch (const std::bad_alloc&) {
    return GROUP_MOVER_OUT_OF_MEMORY;
}
catch (...) {
    return GROUP_MOVER_INTERNAL_ERROR;
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
        case GROUP_MOVER_INVALID_MOVE: return "invalid move";
        case GROUP_MOVER_NO_GROUPS: return "no groups";
        default: return "unknown error";
    }
}
