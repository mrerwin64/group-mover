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
    GROUP_MOVER_INTERNAL_ERROR = 4
};

GROUP_MOVER_API int32_t group_mover_select_moves(
    const int32_t* src,
    const int32_t* dst,
    size_t move_count,
    uint8_t* keep);

#ifdef __cplusplus
}
#endif

#endif //GROUP_MOVER_GROUP_MOVER_H
