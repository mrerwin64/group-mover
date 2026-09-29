#include "group-mover.h"

#include <iostream>
#include <sstream>
#include <cstdint>
#include <vector>
#include <string>

using std::vector;

int main() {
    // Get list of groups
    std::string line;
    vector<group_mover_group> groups;
    std::cout << "Input groups in separate lines as \"<id> <min_size> <current_size> <max_size>\"; ";
    std::cout << "input blank line to proceed" << std::endl;
    while (std::getline(std::cin, line)) {
        std::istringstream iss(line);
        // Detect blank line and break
        iss >> std::ws;
        if (iss.eof()) break;
        // Read the values from the line, checking for failure
        int32_t id;
        size_t min_size;
        size_t current_size;
        size_t max_size;
        if (!(iss >> id >> min_size >> current_size >> max_size)) {
            std::cerr << "Incorrect input, group not accepted - try again" << "\n";
            std::cerr << "Rejected line: " << line << std::endl;
            continue;
        }
        // Check for unexpected trailing characters
        iss >> std::ws;
        if (!iss.eof()) {
            std::cerr << "Unexpected trailing characters - try again" << "\n";
            std::cerr << "Rejected line: " << line << std::endl;
            continue;
        }
        // Check if current_size is not between min_size and max_size
        if (current_size < min_size || current_size > max_size) {
            std::cerr << "current_size is not between min_size and max_size" << "\n";
            std::cerr << "Rejected line: " << line << std::endl;
            continue;
        }
        // Add the group to the vector if everything went well
        groups.push_back({id, min_size, current_size, max_size});
    }

    // Read sources and their destinations
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

    // Write the moves vector once source and destination vectors stop changing (no reallocations)
    vector<group_mover_move> moves;
    for (size_t i = 0; i < src_vec.size(); i++) {
        moves.push_back({src_vec[i], dst_vec_vec[i].data(), dst_vec_vec[i].size()});
    }

    // Call the function and check error string if one occurred
    vector<int32_t> assignments(moves.size());
    const int32_t status_code = group_mover_select_moves(groups.data(),
        groups.size(),
        moves.data(),
        moves.size(),
        0,
        assignments.data());
    if (status_code != GROUP_MOVER_OK) {
        const char* status_str = group_mover_status_string(status_code);
        std::cerr << "An error occurred: " << status_str << std::endl;
        return 1;
    }

    // Print the results
    unsigned int stayed_count = 0;
    unsigned int moved_count = 0;
    for (size_t i = 0; i < assignments.size(); i++) {
        if (moves[i].src == assignments[i]) {
            stayed_count += 1;
            std::cout << moves[i].src << " stays" << "\n";
        }
        else {
            moved_count += 1;
            std::cout << moves[i].src << " -> " << assignments[i] << "\n";
        }
    }
    std::cout << "\n" << "In total:" << "\n";
    std::cout << moved_count << " moved" << "\n";
    std::cout << stayed_count << " stayed" << std::endl;

    return 0;
}
