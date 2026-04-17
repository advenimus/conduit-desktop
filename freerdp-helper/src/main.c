/**
 * conduit-freerdp — Headless FreeRDP client for Conduit.
 *
 * Communicates with Electron over stdin (JSON commands) and stdout (binary frames).
 * Runs the FreeRDP event loop in a separate thread while processing commands on main.
 *
 * Lifecycle:
 *   1. Read "connect" command from stdin
 *   2. Initialize FreeRDP, connect to server
 *   3. Run event loop thread (processes RDP frames, sends BITMAP_UPDATE to stdout)
 *   4. Read input commands from stdin (mouse, keyboard) and forward to FreeRDP
 *   5. On "disconnect" or stdin EOF, disconnect and exit
 */

#include "cliprdr.h"
#include "cliprdr_file.h"
#ifdef _WIN32
#include "cliprdr_win32.h"
#endif
#include "connection.h"
#include "disp.h"
#include "input.h"
#include "output.h"
#include "protocol.h"

#include <stdio.h>
#include <stdlib.h>
#include <stdbool.h>
#include <string.h>

#include <winpr/thread.h>
#include <winpr/synch.h>

#ifndef _WIN32
#include <signal.h>
#else
#include <winsock2.h>
#include <ws2tcpip.h>
#endif

/* Global state */
static freerdp *g_instance = NULL;
static volatile bool g_running = false;
static volatile bool g_connected = false;
static HANDLE g_event_thread = NULL;

/**
 * Event loop thread — processes FreeRDP events (frame updates, etc.)
 * Runs until disconnect or error.
 */
static DWORD WINAPI event_loop_thread(LPVOID arg) {
    freerdp *instance = (freerdp *)arg;
    int last_diag_gen = 0;
    int diag_check_countdown = 0; /* iterations until we check for stalled frames */

    while (g_running && g_connected) {
        if (!connection_check_events(instance)) {
            g_connected = false;
            break;
        }
        disp_check_pending();

        /* Post-resize diagnostic: detect if frames stopped arriving.
         * WaitForMultipleObjects in check_events has 100ms timeout,
         * so 20 iterations ≈ 2 seconds. */
        {
            int gen = 0, frames = 0;
            connection_get_resize_diag(&gen, &frames);
            if (gen != last_diag_gen) {
                /* New resize detected — start countdown */
                last_diag_gen = gen;
                diag_check_countdown = 20; /* ~2 seconds */
            }
            if (diag_check_countdown > 0) {
                diag_check_countdown--;
                if (diag_check_countdown == 0 && frames == 0) {
                    fprintf(stderr, "[conduit-freerdp] WARNING: No frames received 2s after resize #%d\n", gen);
                }
            }
        }
    }

    /* Send disconnected notification */
    if (g_running) {
        output_send_disconnected(NULL);
    }

    fprintf(stderr, "[conduit-freerdp] Event loop thread exiting (g_running=%d g_connected=%d)\n",
            g_running, g_connected);
    return 0;
}

/**
 * Main stdin command loop — reads and dispatches commands.
 */
static void command_loop(void) {
    Command cmd;

    while (g_running) {
        if (!protocol_read_command(&cmd)) {
            /* EOF on stdin — parent process died */
            fprintf(stderr, "[conduit-freerdp] stdin EOF, shutting down\n");
            g_running = false;
            break;
        }

        switch (cmd.type) {
            case CMD_CONNECT: {
                if (g_connected) {
                    output_send_error("Already connected");
                    protocol_free_command(&cmd);
                    break;
                }

                fprintf(stderr, "[conduit-freerdp] Connecting to %s:%d (%dx%d)\n",
                        cmd.data.connect.host ? cmd.data.connect.host : "?",
                        cmd.data.connect.port,
                        cmd.data.connect.width,
                        cmd.data.connect.height);

                disp_init();
                cliprdr_init();
                cliprdr_file_init();
                g_instance = connection_init(&cmd.data.connect);
                if (!g_instance) {
                    output_send_error("Failed to initialize FreeRDP");
                    protocol_free_command(&cmd);
                    break;
                }

                if (!connection_connect(g_instance)) {
                    connection_free(g_instance);
                    g_instance = NULL;
                    protocol_free_command(&cmd);
                    break;
                }

                /* Store initial layout so DISP channel sends a monitor layout
                 * PDU with scale factors when it activates. This triggers
                 * server-side DPI scaling on Windows 10 1803+/Server 2019+. */
                disp_set_initial_layout(cmd.data.connect.width,
                                        cmd.data.connect.height,
                                        cmd.data.connect.desktop_scale_factor,
                                        cmd.data.connect.device_scale_factor);

                g_connected = true;

                /* Start event loop in background thread */
                g_event_thread = CreateThread(NULL, 0, event_loop_thread, g_instance, 0, NULL);
                if (!g_event_thread) {
                    fprintf(stderr, "[conduit-freerdp] Failed to create event thread\n");
                    output_send_error("Failed to create event thread");
                    connection_free(g_instance);
                    g_instance = NULL;
                    g_connected = false;
                }

                protocol_free_command(&cmd);
                break;
            }

            case CMD_DISCONNECT:
                fprintf(stderr, "[conduit-freerdp] Disconnect requested\n");
                g_running = false;
                break;

            case CMD_MOUSE_MOVE:
                if (g_connected && g_instance) {
                    input_mouse_move(g_instance,
                                     cmd.data.mouse_move.x,
                                     cmd.data.mouse_move.y);
                }
                break;

            case CMD_MOUSE_BUTTON_DOWN:
                if (g_connected && g_instance) {
                    input_mouse_button_down(g_instance,
                                            cmd.data.mouse_button.x,
                                            cmd.data.mouse_button.y,
                                            cmd.data.mouse_button.button);
                }
                break;

            case CMD_MOUSE_BUTTON_UP:
                if (g_connected && g_instance) {
                    input_mouse_button_up(g_instance,
                                          cmd.data.mouse_button.x,
                                          cmd.data.mouse_button.y,
                                          cmd.data.mouse_button.button);
                }
                break;

            case CMD_MOUSE_SCROLL:
                if (g_connected && g_instance) {
                    input_mouse_scroll(g_instance,
                                       cmd.data.mouse_scroll.x,
                                       cmd.data.mouse_scroll.y,
                                       cmd.data.mouse_scroll.delta,
                                       cmd.data.mouse_scroll.vertical);
                }
                break;

            case CMD_KEY_DOWN:
                if (g_connected && g_instance) {
                    input_key_down(g_instance,
                                   cmd.data.key.scancode,
                                   cmd.data.key.extended);
                }
                break;

            case CMD_KEY_UP:
                if (g_connected && g_instance) {
                    input_key_up(g_instance,
                                 cmd.data.key.scancode,
                                 cmd.data.key.extended);
                }
                break;

            case CMD_RESIZE:
                if (g_connected && g_instance) {
                    disp_request_resize(cmd.data.resize.width, cmd.data.resize.height,
                                        cmd.data.resize.desktop_scale_factor,
                                        cmd.data.resize.device_scale_factor);
                }
                break;

            case CMD_CLIPBOARD_SET:
                if (g_connected && g_instance) {
#ifdef _WIN32
                    /* Native clipboard detects local changes directly — skip stdin commands */
                    if (!cliprdr_win32_is_active())
#endif
                    cliprdr_set_text(cmd.data.clipboard_set.text,
                                     cmd.data.clipboard_set.length);
                }
                protocol_free_command(&cmd);
                break;

            case CMD_CLIPBOARD_SET_FILES:
                if (g_connected && g_instance) {
#ifdef _WIN32
                    if (!cliprdr_win32_is_active())
#endif
                    {
                        cliprdr_file_set_local_files(cmd.data.clipboard_set_files.json);
                        cliprdr_announce_files();
                    }
                }
                protocol_free_command(&cmd);
                break;

            case CMD_CLIPBOARD_REQUEST_FILES:
                if (g_connected && g_instance) {
                    cliprdr_file_request_download(cmd.data.clipboard_request_files.temp_dir);
                }
                protocol_free_command(&cmd);
                break;

            case CMD_UNKNOWN:
                fprintf(stderr, "[conduit-freerdp] Unknown command\n");
                break;
        }
    }
}

#ifdef _WIN32
static BOOL WINAPI console_ctrl_handler(DWORD ctrl_type) {
    if (ctrl_type == CTRL_C_EVENT || ctrl_type == CTRL_CLOSE_EVENT) {
        g_running = false;
        return TRUE;
    }
    return FALSE;
}
#else
static void signal_handler(int sig) {
    (void)sig;
    g_running = false;
}
#endif

int main(int argc, char *argv[]) {
    (void)argc;
    (void)argv;

    /* Initialize WinSock early — FreeRDP's freerdp_tcp_is_hostname_resolvable()
     * calls getaddrinfo() before freerdp_tcp_connect() calls WSAStartup().
     * Without this, getaddrinfo() fails on Windows even for IP addresses. */
#ifdef _WIN32
    {
        WSADATA wsaData;
        WSAStartup(MAKEWORD(2, 2), &wsaData);
    }
#endif

    /* Set up signal handling */
#ifdef _WIN32
    SetConsoleCtrlHandler(console_ctrl_handler, TRUE);
#else
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);
    signal(SIGPIPE, SIG_IGN); /* Ignore broken pipe (parent died) */
#endif

    /* Initialize output (binary mode on Windows) */
    output_init();

#ifdef _WIN32
    /* Start native clipboard thread (creates hidden HWND for clipboard chain) */
    cliprdr_win32_init();
#endif

    /* Initialize input mutex before any commands are processed */
    input_init();

    fprintf(stderr, "[conduit-freerdp] Ready, waiting for commands on stdin\n");

    g_running = true;

    /* Main command loop — blocks on stdin */
    command_loop();

    /* Cleanup */
    g_connected = false;

    if (g_instance) {
        /* Wait for event thread to finish */
        if (g_event_thread) {
            WaitForSingleObject(g_event_thread, INFINITE);
            CloseHandle(g_event_thread);
            g_event_thread = NULL;
        }

        connection_free(g_instance);
        g_instance = NULL;
    }

#ifdef _WIN32
    cliprdr_win32_cleanup();
#endif

    fprintf(stderr, "[conduit-freerdp] Exiting\n");
    return 0;
}
