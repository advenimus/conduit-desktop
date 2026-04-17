cmake_minimum_required(VERSION 3.16)
project(conduit-freerdp C)

set(CMAKE_C_STANDARD 11)

add_executable(conduit-freerdp
    src/main.c
    src/cliprdr.c
    src/cliprdr_file.c
    src/connection.c
    src/disp.c
    src/input.c
    src/output.c
    src/pointer.c
    src/protocol.c
    src/cjson/cJSON.c
)

if(WIN32)
    # Windows: FreeRDP provides CMake config files when installed
    find_package(FreeRDP 3 REQUIRED)
    find_package(WinPR 3 REQUIRED)
    find_package(FreeRDP-Client 3 REQUIRED)

    # Add Windows-only native clipboard source
    target_sources(conduit-freerdp PRIVATE src/cliprdr_win32.c)

    target_include_directories(conduit-freerdp PRIVATE
        ${FreeRDP_INCLUDE_DIR}
        ${FreeRDP-Client_INCLUDE_DIR}
        ${WinPR_INCLUDE_DIR}
        src/
    )

    target_link_libraries(conduit-freerdp PRIVATE
        freerdp
        freerdp-client
        winpr
        ws2_32
        crypt32
        ole32
        shell32
    )

    target_compile_options(conduit-freerdp PRIVATE /W3 /D_CRT_SECURE_NO_WARNINGS)
    target_compile_definitions(conduit-freerdp PRIVATE _WIN32_WINNT=0x0601)
else()
    # macOS / Linux: use pkg-config with locally-built deps
    set(DEPS_PREFIX "${CMAKE_SOURCE_DIR}/deps/install")
    # Check multiple possible lib dirs (GNUInstallDirs may use lib64 or lib/x86_64-linux-gnu)
    set(_PKG_DIRS "")
    foreach(_subdir lib lib64 "lib/x86_64-linux-gnu")
        if(EXISTS "${DEPS_PREFIX}/${_subdir}/pkgconfig")
            set(_PKG_DIRS "${DEPS_PREFIX}/${_subdir}/pkgconfig:${_PKG_DIRS}")
        endif()
    endforeach()
    if(_PKG_DIRS)
        set(ENV{PKG_CONFIG_PATH} "${_PKG_DIRS}$ENV{PKG_CONFIG_PATH}")
        message(STATUS "Using local deps: ${DEPS_PREFIX}")
    else()
        message(WARNING "Local deps not found at ${DEPS_PREFIX} - run build-freerdp.sh first")
    endif()

    find_package(PkgConfig REQUIRED)
    # FreeRDP 3.x uses different pkg-config names depending on version:
    # older builds use freerdp3/winpr3, newer builds use freerdp0/winpr0
    pkg_check_modules(FREERDP freerdp3)
    if(NOT FREERDP_FOUND)
        pkg_check_modules(FREERDP REQUIRED freerdp0)
    endif()
    pkg_check_modules(FREERDP_CLIENT freerdp-client3)
    if(NOT FREERDP_CLIENT_FOUND)
        pkg_check_modules(FREERDP_CLIENT REQUIRED freerdp-client0)
    endif()
    pkg_check_modules(WINPR winpr3)
    if(NOT WINPR_FOUND)
        pkg_check_modules(WINPR REQUIRED winpr0)
    endif()

    target_include_directories(conduit-freerdp PRIVATE
        ${FREERDP_INCLUDE_DIRS}
        ${FREERDP_CLIENT_INCLUDE_DIRS}
        ${WINPR_INCLUDE_DIRS}
        src/
    )

    target_link_directories(conduit-freerdp PRIVATE
        ${FREERDP_LIBRARY_DIRS}
        ${FREERDP_CLIENT_LIBRARY_DIRS}
        ${WINPR_LIBRARY_DIRS}
    )

    target_link_libraries(conduit-freerdp PRIVATE
        ${FREERDP_LIBRARIES}
        ${FREERDP_CLIENT_LIBRARIES}
        ${WINPR_LIBRARIES}
    )

    target_compile_options(conduit-freerdp PRIVATE -Wall -Wextra -Wno-unused-parameter)
endif()
