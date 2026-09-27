cmake_minimum_required(VERSION 3.16...4.3)
project(group_mover)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_SCAN_FOR_MODULES OFF)

add_library(group_mover_lib SHARED group-mover.cpp group-mover.h)

add_executable(group_mover main.cpp)
target_link_libraries(group_mover PRIVATE group_mover_lib)

target_compile_options(group_mover_lib PRIVATE -Wall -Wextra)
target_compile_options(group_mover PRIVATE -Wall -Wextra)