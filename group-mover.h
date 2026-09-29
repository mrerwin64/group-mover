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
    GROUP_MOVER_NULL_ARGUMENT = 1,      // groups, moves, assignments, or a move's dst (with dst_count > 0) was null
    GROUP_MOVER_INVALID_GROUP = 2,      // A group's current_size is outside [min_size, max_size], or a group is listed twice
    GROUP_MOVER_OUT_OF_MEMORY = 3,
    GROUP_MOVER_INTERNAL_ERROR = 4,     // A bug in the library
    GROUP_MOVER_NO_DESTINATION = 5,     // A move has dst_count == 0
    GROUP_MOVER_SELF_MOVE = 6,          // A move lists its own source as a destination
    GROUP_MOVER_INVALID_MOVE = 7,       // A move's source or destination is not in groups
    GROUP_MOVER_NO_GROUPS = 8           // group_count == 0 while move_count > 0
};

// One person who wants to leave group src for any one of their destinations
typedef struct {
    int32_t src;            // The group the person is in
    const int32_t* dst;     // dst_count acceptable destination groups; repeats are allowed
    size_t dst_count;       // At least 1
} group_mover_move;

// A group and the range its size may end up in
typedef struct {
    int32_t id;             // Any int32_t value; each group may be listed only once
    size_t min_size;
    size_t current_size;    // Must be within [min_size, max_size]
    size_t max_size;
} group_mover_group;

// Chooses which moves to carry out so that every group keeps its current size,
// moving as many people as possible.
// Not yet implemented: letting sizes vary within [min_size, max_size] (the bounds are only validated),
// and using seed to decide between equally good choices (it is currently ignored).
//
// groups       group_count groups; every group used by a move must be listed
// moves        move_count moves, one per person
// seed         currently ignored; the result is deterministic for a given input
// assignments  output, move_count entries, written only on GROUP_MOVER_OK: the group each person ends up in,
//              i.e. one of their destinations, or their src if they stay
//
// The input arrays are only read during the call, and no pointers are kept afterwards.
// With move_count == 0 nothing is read or written and GROUP_MOVER_OK is returned, even for null pointers.
GROUP_MOVER_API int32_t group_mover_select_moves(
    const group_mover_group* groups,
    size_t group_count,
    const group_mover_move* moves,
    size_t move_count,
    uint64_t seed,
    int32_t* assignments);

// Returns a short English description of a status code ("unknown error" for unrecognised codes).
// The string is static: never null, and must not be freed.
GROUP_MOVER_API const char* group_mover_status_string(int32_t status_code);

#ifdef __cplusplus
}
#endif

#endif //GROUP_MOVER_GROUP_MOVER_H
