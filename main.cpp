#include "group-mover.h"

#include <iostream>
#include <sstream>
#include <cstdint>
#include <vector>

using std::vector;

int main() {
    // Get list of moves
    std::string line;
    vector<int32_t> src_vec;
    vector<int32_t> dst_vec;
    std::cout << "Input desired moves in separate lines as \"<src> <dst>\"; input empty line to proceed" << std::endl;
    while (std::getline(std::cin, line)) {
        if (line.empty() or line == "\r") break;
        std::istringstream iss(line);
        int src, dst;
        iss >> src >> dst;
        src_vec.push_back(src);
        dst_vec.push_back(dst);
    }

    // Call the function selecting moves to keep and drop
    vector<uint8_t> kept_vec(src_vec.size());
    const int32_t status = group_mover_select_moves(src_vec.data(), dst_vec.data(), src_vec.size(), kept_vec.data());
    if (status != GROUP_MOVER_OK) {
        std::cerr << "An error occurred" << std::endl;
        return 1;
    }

    // Print the results
    unsigned int kept_moves = 0;
    unsigned int dropped_moves = 0;
    for (size_t i = 0; i < kept_vec.size(); i++) {
        std::cout << src_vec[i] << " -> " << dst_vec[i] << ": ";
        if (kept_vec[i] == 1) {
            std::cout << "kept" << "\n";
            kept_moves += 1;
        }
        else {
            std::cout << "dropped" << "\n";
            dropped_moves += 1;
        }
    }
    std::cout << "\n" << "In total:" << "\n";
    std::cout << kept_moves << " moves kept" << "\n";
    std::cout << dropped_moves << " moves dropped" << std::endl;

    return 0;
}
