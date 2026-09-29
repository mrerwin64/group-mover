"""ctypes binding for the group-mover C API (../group-mover.h).

The structs and function signatures below mirror the header exactly; if the header changes,
update them here too (test_binding.py checks them against the real library).
"""

import ctypes
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

UI_DIR = Path(__file__).resolve().parent
ROOT_DIR = UI_DIR.parent
BUILD_DIR = UI_DIR / "build"
LIB_DIR = BUILD_DIR / "lib"
SOURCES = [ROOT_DIR / "group-mover.cpp", ROOT_DIR / "group-mover.h", UI_DIR / "CMakeLists.txt"]

INT32_MIN = -(2 ** 31)
INT32_MAX = 2 ** 31 - 1
UINT64_MAX = 2 ** 64 - 1
SIZE_MAX = 2 ** (8 * ctypes.sizeof(ctypes.c_size_t)) - 1

# Status codes, in the header's order
STATUS_NAMES = {
    0: "GROUP_MOVER_OK",
    1: "GROUP_MOVER_NULL_ARGUMENT",
    2: "GROUP_MOVER_INVALID_GROUP",
    3: "GROUP_MOVER_OUT_OF_MEMORY",
    4: "GROUP_MOVER_INTERNAL_ERROR",
    5: "GROUP_MOVER_NO_DESTINATION",
    6: "GROUP_MOVER_SELF_MOVE",
    7: "GROUP_MOVER_INVALID_MOVE",
    8: "GROUP_MOVER_NO_GROUPS",
}
OK = 0


class Move(ctypes.Structure):
    _fields_ = [
        ("src", ctypes.c_int32),
        ("dst", ctypes.POINTER(ctypes.c_int32)),
        ("dst_count", ctypes.c_size_t),
    ]


class Group(ctypes.Structure):
    _fields_ = [
        ("id", ctypes.c_int32),
        ("min_size", ctypes.c_size_t),
        ("current_size", ctypes.c_size_t),
        ("max_size", ctypes.c_size_t),
    ]


def library_file_name():
    if sys.platform == "win32":
        return "group_mover_lib.dll"
    if sys.platform == "darwin":
        return "group_mover_lib.dylib"
    return "group_mover_lib.so"


def default_library_path():
    return LIB_DIR / library_file_name()


class BuildError(RuntimeError):
    def __init__(self, message, log=""):
        super().__init__(message)
        self.log = log


def _clion_toolchain():
    """Directories of CLion's bundled cmake, ninja and MinGW, if CLion is installed (Windows only)."""
    if sys.platform != "win32":
        return None
    candidates = []
    local = os.environ.get("LOCALAPPDATA")
    if local:
        candidates += sorted(Path(local, "Programs").glob("CLion*"), reverse=True)
    for base in (os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)")):
        if base:
            candidates += sorted(Path(base, "JetBrains").glob("CLion*"), reverse=True)
    for clion in candidates:
        cmake = clion / "bin" / "cmake" / "win" / "x64" / "bin"
        ninja = clion / "bin" / "ninja" / "win" / "x64"
        mingw = clion / "bin" / "mingw" / "bin"
        if (cmake / "cmake.exe").exists() and (ninja / "ninja.exe").exists() and (mingw / "g++.exe").exists():
            return {"cmake": cmake, "ninja": ninja, "mingw": mingw}
    return None


def needs_build(lib_path=None):
    lib_path = Path(lib_path) if lib_path else default_library_path()
    if not lib_path.exists():
        return True
    built = lib_path.stat().st_mtime
    return any(source.exists() and source.stat().st_mtime > built for source in SOURCES)


def build_library(log=print):
    """Configure (first time only) and build ui/build/lib/group_mover_lib.*; returns the library path and the log."""
    lines = []

    def run(cmd, env=None):
        lines.append("$ " + " ".join(str(c) for c in cmd))
        log(lines[-1])
        proc = subprocess.run([str(c) for c in cmd], capture_output=True, text=True, env=env)
        output = (proc.stdout + proc.stderr).strip()
        if output:
            lines.append(output)
            log(output)
        return proc.returncode == 0

    env = os.environ.copy()
    cmake = shutil.which("cmake")
    clion = _clion_toolchain()
    if cmake is None and clion is not None:
        cmake = str(clion["cmake"] / "cmake.exe")
    if cmake is None:
        raise BuildError("CMake was not found on PATH; install it or build ui/ yourself (see ui/README.md)")

    configured = (BUILD_DIR / "CMakeCache.txt").exists()
    if not configured:
        ok = run([cmake, "-S", UI_DIR, "-B", BUILD_DIR, "-DCMAKE_BUILD_TYPE=Release"], env)
        if not ok and clion is not None:
            # Fall back to CLion's bundled MinGW + Ninja (needs a fresh build directory)
            shutil.rmtree(BUILD_DIR, ignore_errors=True)
            env["PATH"] = os.pathsep.join([str(clion["mingw"]), str(clion["ninja"]), env.get("PATH", "")])
            ok = run([cmake, "-S", UI_DIR, "-B", BUILD_DIR, "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release",
                      "-DCMAKE_CXX_COMPILER=" + str(clion["mingw"] / "g++.exe")], env)
        if not ok:
            raise BuildError("CMake configure failed", "\n".join(lines))
    elif clion is not None:
        # A Ninja build directory configured with CLion's tools needs them on PATH again
        env["PATH"] = os.pathsep.join([str(clion["mingw"]), str(clion["ninja"]), env.get("PATH", "")])

    if not run([cmake, "--build", BUILD_DIR, "--config", "Release"], env):
        raise BuildError("Build failed", "\n".join(lines))
    lib_path = default_library_path()
    if not lib_path.exists():
        raise BuildError(f"Build finished but {lib_path} does not exist", "\n".join(lines))
    # The linker may not update the timestamp when nothing changed; mark the library as up to date
    os.utime(lib_path)
    return lib_path, "\n".join(lines)


_load_counter = 0
_load_lock = threading.Lock()


class Library:
    """A loaded copy of the shared library.

    On Windows a loaded DLL cannot be overwritten, so by default a private copy is loaded; this lets the UI
    rebuild the library while the server is running and load the new version next to the old one.
    """

    def __init__(self, path, copy=True):
        global _load_counter
        self.path = Path(path).resolve()
        load_path = self.path
        if copy:
            with _load_lock:
                _load_counter += 1
                counter = _load_counter
            loaded_root = BUILD_DIR / "loaded"
            loaded_root.mkdir(parents=True, exist_ok=True)
            # Old copies stay locked while loaded (Windows); remove the ones that aren't
            for old in loaded_root.iterdir():
                shutil.rmtree(old, ignore_errors=True)
            loaded_dir = loaded_root / f"{os.getpid()}-{counter}"
            loaded_dir.mkdir()
            # Copy the library together with any DLLs next to it (MinGW's libwinpthread-1.dll)
            for sibling in self.path.parent.glob("*.dll"):
                if sibling != self.path:
                    shutil.copy2(sibling, loaded_dir / sibling.name)
            load_path = loaded_dir / self.path.name
            shutil.copy2(self.path, load_path)
        self.load_path = load_path
        self.loaded_at = time.time()
        self.built_at = self.path.stat().st_mtime
        self._lib = ctypes.CDLL(str(load_path))

        self._select = self._lib.group_mover_select_moves
        self._select.argtypes = [
            ctypes.POINTER(Group), ctypes.c_size_t,
            ctypes.POINTER(Move), ctypes.c_size_t,
            ctypes.c_uint64,
            ctypes.POINTER(ctypes.c_int32),
        ]
        self._select.restype = ctypes.c_int32

        self._status_string = self._lib.group_mover_status_string
        self._status_string.argtypes = [ctypes.c_int32]
        self._status_string.restype = ctypes.c_char_p

    def status_string(self, code):
        return self._status_string(code).decode("utf-8", "replace")

    def prepare(self, groups, moves):
        """Converts the input once, so it can be run with many seeds (see Prepared.run)."""
        return Prepared(self, groups, moves)

    def select_moves(self, groups, moves, seed):
        return self.prepare(groups, moves).run(seed)


def _check_int(value, low, high, what):
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{what} must be an integer, got {value!r}")
    if not low <= value <= high:
        raise ValueError(f"{what} must be within [{low}, {high}], got {value}")
    return value


class Prepared:
    """C arrays built from Python data; ctypes silently truncates out-of-range integers, so check them first."""

    def __init__(self, library, groups, moves):
        self.library = library
        self.group_count = len(groups)
        self.move_count = len(moves)
        # Zero-length arrays still give non-null pointers; the API is the one deciding what is valid
        self.groups = (Group * self.group_count)()
        for i, g in enumerate(groups):
            self.groups[i] = Group(
                _check_int(g["id"], INT32_MIN, INT32_MAX, f"groups[{i}].id"),
                _check_int(g["min_size"], 0, SIZE_MAX, f"groups[{i}].min_size"),
                _check_int(g["current_size"], 0, SIZE_MAX, f"groups[{i}].current_size"),
                _check_int(g["max_size"], 0, SIZE_MAX, f"groups[{i}].max_size"),
            )
        self.moves = (Move * self.move_count)()
        self._dst_arrays = []  # Keeps every dst array alive for as long as the Move array points at it
        for i, m in enumerate(moves):
            dst = list(m["dst"])
            array = (ctypes.c_int32 * len(dst))(
                *(_check_int(d, INT32_MIN, INT32_MAX, f"moves[{i}].dst[{j}]") for j, d in enumerate(dst)))
            self._dst_arrays.append(array)
            self.moves[i] = Move(_check_int(m["src"], INT32_MIN, INT32_MAX, f"moves[{i}].src"),
                                 ctypes.cast(array, ctypes.POINTER(ctypes.c_int32)), len(dst))
        self.assignments = (ctypes.c_int32 * self.move_count)()

    def run(self, seed):
        """Returns (status, assignments); assignments is None unless status == OK."""
        _check_int(seed, 0, UINT64_MAX, "seed")
        # Fill with a marker so a library that writes nothing is noticed
        for i in range(self.move_count):
            self.assignments[i] = INT32_MIN
        status = self.library._select(self.groups, self.group_count, self.moves, self.move_count,
                                      seed, self.assignments)
        if status != OK:
            return status, None
        return status, list(self.assignments)


def load(path=None, build=True, log=print):
    """Loads the library, building it first if needed (only for the default path)."""
    if path is not None:
        return Library(path)
    if build and needs_build():
        build_library(log)
    lib_path = default_library_path()
    if not lib_path.exists():
        raise BuildError(f"{lib_path} does not exist; run server.py without --no-build")
    return Library(lib_path)
