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

// Status codes returned by group_mover_select_moves
enum {
    GROUP_MOVER_OK = 0,
    GROUP_MOVER_NULL_ARGUMENT = 1,      // A pointer was null while move_count > 0
    GROUP_MOVER_INVALID_GROUP = 2,      // Reserved, currently unused
    GROUP_MOVER_OUT_OF_MEMORY = 3,
    GROUP_MOVER_INTERNAL_ERROR = 4,     // A bug in the library
    GROUP_MOVER_NO_DESTINATION = 5,     // Some dst_counts[i] is 0
    GROUP_MOVER_SELF_MOVE = 6           // Some move lists its own source as a destination
};

// Chooses which moves to carry out so that every group ends with the same size it started with,
// moving as many people as possible. Each move is one person who wants to leave group src[i]
// for any one of their destinations.
//
// src         move_count group numbers: the group each person is in
// dst_counts  move_count counts: how many destinations each person accepts (each at least 1)
// dst         all destinations, move by move: move 0's dst_counts[0] entries, then move 1's, ...
//             A destination may not equal its move's source; repeated destinations are allowed.
// move_count  number of moves (people)
// result      move_count entries, written only on GROUP_MOVER_OK: the group each person ends up in,
//             i.e. one of their destinations, or src[i] if they stay
//
// Group numbers can be any int32_t values. The result is deterministic for a given input.
// With move_count == 0 nothing is read or written and GROUP_MOVER_OK is returned, even for null pointers.
GROUP_MOVER_API int32_t group_mover_select_moves(
    const int32_t* src,
    const size_t* dst_counts,
    const int32_t* dst,
    size_t move_count,
    int32_t* result);

// Returns a short English description of a status code ("unknown error" for unrecognised codes).
// The string is static: never null, and must not be freed.
GROUP_MOVER_API const char* group_mover_status_string(int32_t status_code);

#ifdef __cplusplus
}
#endif

#endif //GROUP_MOVER_GROUP_MOVER_H
