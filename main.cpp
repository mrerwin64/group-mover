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
    vector<vector<int32_t>> dst_vec_vec;
    std::cout << "Input desired moves in separate lines as \"<src> <dst1> (<dst2> <dst3> ...)\"; ";
    std::cout << "input blank line to proceed" << std::endl;
    while (std::getline(std::cin, line)) {
        std::istringstream iss(line);
        // Detect blank line and break
        iss >> std::ws;
        if (iss.eof()) break;
        // Read the source, checking for failure
        int32_t src;
        if (!(iss >> src)) {
            std::cerr << "Incorrect input, move not accepted - try again" << "\n";
            std::cerr << "Rejected line: " << line << std::endl;
            continue;
        }
        // Repeatedly read destinations, checking for failure
        vector<int32_t> dst_vec;
        while (!(iss >> std::ws).eof()) {
            int32_t dst;
            if (!(iss >> dst)) {
                dst_vec.clear(); // Make the later check reject this line
                break;
            }
            dst_vec.push_back(dst);
        }
        // Check for empty destinations vector
        if (!dst_vec.empty()) {
            src_vec.push_back(src);
            dst_vec_vec.push_back(dst_vec);
        }
        else {
            std::cerr << "Incorrect input, move not accepted - try again" << "\n";
            std::cerr << "Rejected line: " << line << std::endl;
        }
    }

    // Prepare parameters for the library function
    vector<int32_t> dst_vec;
    vector<size_t> dst_counts;
    for (const vector<int32_t>& destinations: dst_vec_vec) {
        dst_vec.insert(dst_vec.end(), destinations.begin(), destinations.end());
        dst_counts.push_back(destinations.size());
    }
    vector<int32_t> result_vec(src_vec.size());
    // Call the function and check error string if one occurred
    const int32_t status_code = group_mover_select_moves(
        src_vec.data(),
        dst_counts.data(),
        dst_vec.data(),
        src_vec.size(),
        result_vec.data());
    if (status_code != GROUP_MOVER_OK) {
        const char* status_str = group_mover_status_string(status_code);
        std::cerr << "An error occurred: " << status_str << std::endl;
        return 1;
    }

    // Print the results
    unsigned int stayed_count = 0;
    unsigned int moved_count = 0;
    for (size_t i = 0; i < src_vec.size(); i++) {
        if (src_vec[i] == result_vec[i]) {
            stayed_count += 1;
            std::cout << src_vec[i] << " stays" << "\n";
        }
        else {
            moved_count += 1;
            std::cout << src_vec[i] << " -> " << result_vec[i] << "\n";
        }
    }
    std::cout << "\n" << "In total:" << "\n";
    std::cout << moved_count << " moved" << "\n";
    std::cout << stayed_count << " stayed" << std::endl;

    return 0;
}
