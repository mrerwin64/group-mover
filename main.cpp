#include <iostream>
#include <sstream>
#include <vector>
#include <limits>

using std::vector;

int main() {
    int group_count;
    std::cout << "Groups are numbered 1..N, how many groups are there? " << std::flush;
    std::cin >> group_count;
    std::cin.ignore(std::numeric_limits<std::streamsize>::max(), '\n');

    vector<vector<int>> total(group_count+1, vector(group_count+1, 0));
    vector<vector<int>> dropped(group_count+1, vector(group_count+1, 0));

    std::cout << "Input desired moves in separate lines as \"<src> <dst>\"; input empty line to proceed" << std::endl;
    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty() or line == "\r") break;
        std::istringstream iss(line);
        int src, dst;
        iss >> src >> dst;
        total[src][dst] += 1;
    }

    return 0;
}
