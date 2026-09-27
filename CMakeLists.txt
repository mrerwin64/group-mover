cmake_minimum_required(VERSION 3.16...4.3)
project(group_mover)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_SCAN_FOR_MODULES OFF)

if(MSVC)
    set(GROUP_MOVER_WARNINGS /W4)
else()
    set(GROUP_MOVER_WARNINGS -Wall -Wextra)
endif()

add_library(group_mover_lib SHARED group-mover.cpp group-mover.h)
target_include_directories(group_mover_lib PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})

add_executable(group_mover main.cpp)
target_link_libraries(group_mover PRIVATE group_mover_lib)

target_compile_options(group_mover_lib PRIVATE ${GROUP_MOVER_WARNINGS})
target_compile_options(group_mover PRIVATE ${GROUP_MOVER_WARNINGS})

enable_testing()

# Defined here rather than in tests/ so the executable is built next to the DLL on Windows
add_executable(group_mover_tests tests/group_mover_tests.cpp)
target_link_libraries(group_mover_tests PRIVATE group_mover_lib)
target_compile_options(group_mover_tests PRIVATE ${GROUP_MOVER_WARNINGS})

add_test(NAME examples COMMAND group_mover_tests examples)
add_test(NAME random COMMAND group_mover_tests random)
