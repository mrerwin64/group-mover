cmake_minimum_required(VERSION 4.3)
project(group_mover)

set(CMAKE_CXX_STANDARD 17)

add_library(group_mover_lib SHARED group-mover.cpp group-mover.h)

add_executable(group_mover main.cpp)
target_link_libraries(group_mover PRIVATE group_mover_lib)