#include "group-mover.h"

#include <iostream>
#include <sstream>
#include <cstdint>
#include <vector>
#include <string>

using std::vector;

int main() {
    // Get list of moves
    std::string line;
    vector<int32_t> src_vec;
    vector<int32_t> dst_vec;
    std::cout << "Input desired moves in separate lines as \"<src> <dst>\"; input blank line to proceed" << std::endl;
    while (std::getline(std::cin, line)) {
        std::istringstream iss(line);
        // Detect blank line and break
        iss >> std::ws;
        if (iss.eof()) break;
        // Read and save what remains, checking for failure
        int32_t src, dst;
        if (!(iss >> src >> dst)) {
            std::cerr << "Incorrect input, move not accepted - try again" << "\n";
            std::cerr << "Rejected line: " << line << std::endl;
            continue;
        }
        // Check for any trailing characters and reject the input
        iss >> std::ws;
        if (!iss.eof()) {
            std::cerr << "Unexpected trailing characters - try again" << "\n";
            std::cerr << "Rejected line: " << line << std::endl;
            continue;
        }
        src_vec.push_back(src);
        dst_vec.push_back(dst);
    }

    // Call the function selecting moves to keep and drop
    vector<uint8_t> kept_vec(src_vec.size());
    const int32_t status_code = group_mover_select_moves(src_vec.data(), dst_vec.data(), src_vec.size(), kept_vec.data());
    if (status_code != GROUP_MOVER_OK) {
        const char* status_str = group_mover_status_string(status_code);
        std::cerr << "An error occurred: " << status_str << std::endl;
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
