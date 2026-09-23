#include <iostream>
#include <sstream>
#include <vector>
#include <limits>
#include <queue>

using std::vector, std::queue;

int main() {
    // Prepare containers for graph data
    unsigned int group_count;
    std::cout << "Groups are numbered 1..N, how many groups are there? " << std::flush;
    std::cin >> group_count;
    std::cin.ignore(std::numeric_limits<std::streamsize>::max(), '\n');

    vector<vector<int>> active_vec(group_count+1, vector(group_count+1, 0));
    vector<vector<int>> dropped_vec(group_count+1, vector(group_count+1, 0));
    vector<int> balance_vec(group_count+1, 0);

    // Fill initial state of the graph
    std::cout << "Input desired moves in separate lines as \"<src> <dst>\"; input empty line to proceed" << std::endl;
    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty() or line == "\r") break;
        std::istringstream iss(line);
        int src, dst;
        iss >> src >> dst;
        balance_vec[src] += 1;
        balance_vec[dst] -= 1;
        active_vec[src][dst] += 1;
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
                    std::cerr << "An error occurred when removing impossible moves" << std::endl;
                    return 1;
                }
                current_node = next_node;
            }
        }
        if (finished) break;
    }

    // Deliver the results
    unsigned int remaining_moves = 0;
    unsigned int dropped_moves = 0;
    for (size_t src_group = 1; src_group <= group_count; src_group++) {
        for (size_t dst_group = 1; dst_group <= group_count; dst_group++) {
            const unsigned int remaining = active_vec[src_group][dst_group];
            const unsigned int dropped = dropped_vec[src_group][dst_group];
            remaining_moves += remaining;
            dropped_moves += dropped;
            if (remaining + dropped > 0) {
                std::cout << src_group << " -> " << dst_group << ": ";
                std::cout << remaining << " remaining, ";
                std::cout << dropped << " dropped" << "\n";
            }
        }
    }
    std::cout << "\n" << "In total:" << "\n";
    std::cout << remaining_moves << " moves remaining" << "\n";
    std::cout << dropped_moves << " moves dropped" << "\n";

    return 0;
}
