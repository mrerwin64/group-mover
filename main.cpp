#include <iostream>
#include <sstream>
#include <vector>
#include <limits>
#include <queue>

using std::vector, std::queue;

int main() {
    // Prepare containers for graph data
    int group_count;
    std::cout << "Groups are numbered 1..N, how many groups are there? " << std::flush;
    std::cin >> group_count;
    std::cin.ignore(std::numeric_limits<std::streamsize>::max(), '\n');

    vector<vector<int>> active(group_count+1, vector(group_count+1, 0));
    vector<vector<int>> dropped(group_count+1, vector(group_count+1, 0));
    vector<int> balance(group_count+1, 0);

    // Fill initial state of the graph
    std::cout << "Input desired moves in separate lines as \"<src> <dst>\"; input empty line to proceed" << std::endl;
    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty() or line == "\r") break;
        std::istringstream iss(line);
        int src, dst;
        iss >> src >> dst;
        balance[src] += 1;
        balance[dst] -= 1;
        active[src][dst] += 1;
    }

    // Balance all nodes in the graph
    while (true) {
        // Track whether any node is unbalanced
        bool finished = true;

        // For any surplus node, find and drop the cheapest chain to a deficit node
        for (size_t surplus_node = 1; surplus_node <= group_count; surplus_node++) {
            // Skip a non-surplus node
            if (balance[surplus_node] <= 0) continue;
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
                    if (active[current_node][target_node] > 0) {
                        if (const int new_cost = cost[current_node] + 1; new_cost < cost[target_node]) {
                            previous[target_node] = current_node;
                            cost[target_node] = new_cost;
                            next.push(target_node);
                        }
                        if (dropped[target_node][current_node] > 0) {
                            if (const int new_cost = cost[current_node] - 1; new_cost < cost[target_node]) {
                                previous[target_node] = current_node;
                                cost[target_node] = new_cost;
                                next.push(target_node);
                            }
                        }
                    }
                }
            }

            // Find cheapest to reach deficit node
            size_t deficit_node = 0;
            int lowest_cost = std::numeric_limits<int>::max();
            for (size_t target_node = 1; target_node <= group_count; target_node++) {
                if (balance[target_node] < 0 && cost[target_node] < lowest_cost) {
                    lowest_cost = cost[target_node];
                    deficit_node = target_node;
                }
            }
        }
        if (finished) break;
    }

    return 0;
}
