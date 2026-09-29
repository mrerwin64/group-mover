# Standalone build of the group-mover library for the UI.
# It compiles ../group-mover.cpp without touching the main project's CMakeLists.txt,
# and produces a self-contained shared library that Python can load with ctypes:
#   cmake -S ui -B ui/build && cmake --build ui/build --config Release
# (server.py runs these two commands for you when the library is missing or out of date.)
cmake_minimum_required(VERSION 3.16...4.3)
project(group_mover_ui LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_SCAN_FOR_MODULES OFF)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release)
endif()

get_filename_component(GROUP_MOVER_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/.." ABSOLUTE)

# Keeping the target name makes CMake define group_mover_lib_EXPORTS, which the header uses for dllexport
add_library(group_mover_lib SHARED "${GROUP_MOVER_ROOT}/group-mover.cpp" "${GROUP_MOVER_ROOT}/group-mover.h")
target_include_directories(group_mover_lib PRIVATE "${GROUP_MOVER_ROOT}")

# Same file name on every platform (no "lib" prefix), in one directory for every configuration ($<0:> stops
# multi-config generators such as Visual Studio from appending /Release)
set_target_properties(group_mover_lib PROPERTIES
    PREFIX ""
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/lib$<0:>"
    LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/lib$<0:>"
    ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/lib$<0:>")

# Link the C++ runtime statically, so the library loads without the compiler's runtime DLLs on PATH.
# MinGW's winpthread can't always be linked statically (-static fails with some toolchains, e.g. CLion's),
# so its DLL is copied next to the library instead.
if(MINGW)
    target_link_options(group_mover_lib PRIVATE -static-libgcc -static-libstdc++)
    get_filename_component(GROUP_MOVER_MINGW_BIN "${CMAKE_CXX_COMPILER}" DIRECTORY)
    if(EXISTS "${GROUP_MOVER_MINGW_BIN}/libwinpthread-1.dll")
        add_custom_command(TARGET group_mover_lib POST_BUILD
            COMMAND "${CMAKE_COMMAND}" -E copy_if_different
                "${GROUP_MOVER_MINGW_BIN}/libwinpthread-1.dll" "$<TARGET_FILE_DIR:group_mover_lib>")
    endif()
elseif(MSVC)
    set_property(TARGET group_mover_lib PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

if(MSVC)
    target_compile_options(group_mover_lib PRIVATE /W4)
else()
    target_compile_options(group_mover_lib PRIVATE -Wall -Wextra)
endif()
