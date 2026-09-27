#ifndef GROUP_MOVER_GROUP_MOVER_H
#define GROUP_MOVER_GROUP_MOVER_H

#include <stddef.h>
#include <stdint.h>

#if defined(_WIN32)
    #ifdef group_mover_lib_EXPORTS
        #define GROUP_MOVER_API __declspec(dllexport)
    #else
        #define GROUP_MOVER_API __declspec(dllimport)
    #endif
#else
    #define GROUP_MOVER_API __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
extern "C" {
#endif

enum {
    GROUP_MOVER_OK = 0,
    GROUP_MOVER_NULL_ARGUMENT = 1,
    GROUP_MOVER_INVALID_GROUP = 2, // Currently unused
    GROUP_MOVER_OUT_OF_MEMORY = 3,
    GROUP_MOVER_INTERNAL_ERROR = 4,
    GROUP_MOVER_NO_DESTINATION = 5,
    GROUP_MOVER_SELF_MOVE = 6
};

GROUP_MOVER_API int32_t group_mover_select_moves(
    const int32_t* src,
    const size_t* dst_counts,
    const int32_t* dst,
    size_t move_count,
    int32_t* result);

GROUP_MOVER_API const char* group_mover_status_string(int32_t status_code);

#ifdef __cplusplus
}
#endif

#endif //GROUP_MOVER_GROUP_MOVER_H
