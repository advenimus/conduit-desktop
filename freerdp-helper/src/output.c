/**
 * output.c — Binary protocol framing for the binary output pipe.
 *
 * IMPORTANT: FreeRDP's WLog system writes to stdout by default (not stderr).
 * To prevent log messages from corrupting our binary protocol, output_init()
 * saves the original stdout fd, then redirects stdout to stderr. All binary
 * protocol output uses the saved fd via g_binary_out.
 */

#include "output.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <winpr/synch.h>

#ifdef _WIN32
#include <io.h>
#include <fcntl.h>
#define dup    _dup
#define dup2   _dup2
#define fdopen _fdopen
#define STDOUT_FILENO 1
#define STDERR_FILENO 2
#else
#include <unistd.h>
#endif

static CRITICAL_SECTION output_mutex;

/** Dedicated FILE* for binary protocol output (original stdout before redirect) */
static FILE *g_binary_out = NULL;

void output_init(void) {
    InitializeCriticalSection(&output_mutex);

    /*
     * FreeRDP3's default WLog console appender writes to stdout.
     * This corrupts our binary protocol stream. Fix: save the original
     * stdout fd for our binary output, then redirect stdout → stderr
     * so all FreeRDP logging goes to stderr instead.
     */
    int saved_stdout = dup(STDOUT_FILENO);
    if (saved_stdout < 0) {
        fprintf(stderr, "[conduit-freerdp] FATAL: dup(stdout) failed\n");
        exit(1);
    }

    /* Redirect stdout to stderr — FreeRDP WLog will now write to stderr */
    dup2(STDERR_FILENO, STDOUT_FILENO);

    /* Create a FILE* from the saved stdout fd for our binary output */
    g_binary_out = fdopen(saved_stdout, "wb");
    if (!g_binary_out) {
        fprintf(stderr, "[conduit-freerdp] FATAL: fdopen(saved_stdout) failed\n");
        exit(1);
    }

#ifdef _WIN32
    _setmode(saved_stdout, _O_BINARY);
#endif

    /* Disable buffering for low-latency frame delivery */
    setvbuf(g_binary_out, NULL, _IONBF, 0);
}

void output_send(uint32_t type, const void *payload, uint32_t length) {
    if (!g_binary_out) return;

    EnterCriticalSection(&output_mutex);

    /* Write header: type (u32-LE) + length (u32-LE) */
    uint8_t header[8];
    header[0] = (uint8_t)(type & 0xFF);
    header[1] = (uint8_t)((type >> 8) & 0xFF);
    header[2] = (uint8_t)((type >> 16) & 0xFF);
    header[3] = (uint8_t)((type >> 24) & 0xFF);
    header[4] = (uint8_t)(length & 0xFF);
    header[5] = (uint8_t)((length >> 8) & 0xFF);
    header[6] = (uint8_t)((length >> 16) & 0xFF);
    header[7] = (uint8_t)((length >> 24) & 0xFF);

    fwrite(header, 1, 8, g_binary_out);

    if (payload && length > 0) {
        fwrite(payload, 1, length, g_binary_out);
    }

    fflush(g_binary_out);
    LeaveCriticalSection(&output_mutex);
}

void output_send_connected(int width, int height) {
    char json[128];
    int len = snprintf(json, sizeof(json), "{\"width\":%d,\"height\":%d}", width, height);
    output_send(MSG_TYPE_CONNECTED, json, (uint32_t)len);
}

void output_send_bitmap(uint16_t x, uint16_t y, uint16_t w, uint16_t h,
                        const uint8_t *rgba_data, size_t rgba_len) {
    if (!g_binary_out) return;

    EnterCriticalSection(&output_mutex);

    uint32_t payload_len = 8 + (uint32_t)rgba_len;

    /* Message header: [type:u32-LE][length:u32-LE] */
    uint8_t header[8];
    uint32_t type = MSG_TYPE_BITMAP_UPDATE;
    header[0] = (uint8_t)(type & 0xFF);
    header[1] = (uint8_t)((type >> 8) & 0xFF);
    header[2] = (uint8_t)((type >> 16) & 0xFF);
    header[3] = (uint8_t)((type >> 24) & 0xFF);
    header[4] = (uint8_t)(payload_len & 0xFF);
    header[5] = (uint8_t)((payload_len >> 8) & 0xFF);
    header[6] = (uint8_t)((payload_len >> 16) & 0xFF);
    header[7] = (uint8_t)((payload_len >> 24) & 0xFF);
    fwrite(header, 1, 8, g_binary_out);

    /* Payload sub-header: [x:u16-LE][y:u16-LE][w:u16-LE][h:u16-LE] */
    uint8_t sub[8];
    sub[0] = (uint8_t)(x & 0xFF);
    sub[1] = (uint8_t)((x >> 8) & 0xFF);
    sub[2] = (uint8_t)(y & 0xFF);
    sub[3] = (uint8_t)((y >> 8) & 0xFF);
    sub[4] = (uint8_t)(w & 0xFF);
    sub[5] = (uint8_t)((w >> 8) & 0xFF);
    sub[6] = (uint8_t)(h & 0xFF);
    sub[7] = (uint8_t)((h >> 8) & 0xFF);
    fwrite(sub, 1, 8, g_binary_out);

    /* RGBA pixel data — written directly from caller's buffer (zero-copy) */
    if (rgba_data && rgba_len > 0) {
        fwrite(rgba_data, 1, rgba_len, g_binary_out);
    }

    fflush(g_binary_out);
    LeaveCriticalSection(&output_mutex);
}

void output_send_disconnected(const char *error) {
    char json[1024];
    int len;
    if (error) {
        len = snprintf(json, sizeof(json), "{\"error\":\"%s\"}", error);
    } else {
        len = snprintf(json, sizeof(json), "{\"error\":null}");
    }
    output_send(MSG_TYPE_DISCONNECTED, json, (uint32_t)len);
}

void output_send_resized(int width, int height) {
    char json[128];
    int len = snprintf(json, sizeof(json), "{\"width\":%d,\"height\":%d}", width, height);
    output_send(MSG_TYPE_RESIZED, json, (uint32_t)len);
}

void output_send_clipboard_text(const char *utf8_text, int length) {
    if (!utf8_text || length <= 0) return;
    output_send(MSG_TYPE_CLIPBOARD_TEXT, utf8_text, (uint32_t)length);
}

void output_send_clipboard_file_list(const char *json, int length) {
    if (!json || length <= 0) return;
    output_send(MSG_TYPE_CLIPBOARD_FILE_LIST, json, (uint32_t)length);
}

void output_send_clipboard_file_done(const char *json, int length) {
    if (!json || length <= 0) return;
    output_send(MSG_TYPE_CLIPBOARD_FILE_DONE, json, (uint32_t)length);
}

void output_send_clipboard_file_error(const char *json, int length) {
    if (!json || length <= 0) return;
    output_send(MSG_TYPE_CLIPBOARD_FILE_ERROR, json, (uint32_t)length);
}

void output_send_clipboard_file_progress(const char *json, int length) {
    if (!json || length <= 0) return;
    output_send(MSG_TYPE_CLIPBOARD_FILE_PROGRESS, json, (uint32_t)length);
}

void output_send_clipboard_native(void) {
    output_send(MSG_TYPE_CLIPBOARD_NATIVE, "{}", 2);
}

void output_send_cursor(uint16_t hotspotX, uint16_t hotspotY,
                        uint16_t width, uint16_t height,
                        const uint8_t *rgba_data, size_t rgba_len) {
    if (!g_binary_out || !rgba_data || rgba_len == 0) return;

    EnterCriticalSection(&output_mutex);

    uint32_t payload_len = 8 + (uint32_t)rgba_len;

    /* Message header: [type:u32-LE][length:u32-LE] */
    uint8_t header[8];
    uint32_t type = MSG_TYPE_CURSOR_SET;
    header[0] = (uint8_t)(type & 0xFF);
    header[1] = (uint8_t)((type >> 8) & 0xFF);
    header[2] = (uint8_t)((type >> 16) & 0xFF);
    header[3] = (uint8_t)((type >> 24) & 0xFF);
    header[4] = (uint8_t)(payload_len & 0xFF);
    header[5] = (uint8_t)((payload_len >> 8) & 0xFF);
    header[6] = (uint8_t)((payload_len >> 16) & 0xFF);
    header[7] = (uint8_t)((payload_len >> 24) & 0xFF);
    fwrite(header, 1, 8, g_binary_out);

    /* Payload sub-header: [hotspotX:u16-LE][hotspotY:u16-LE][width:u16-LE][height:u16-LE] */
    uint8_t sub[8];
    sub[0] = (uint8_t)(hotspotX & 0xFF);
    sub[1] = (uint8_t)((hotspotX >> 8) & 0xFF);
    sub[2] = (uint8_t)(hotspotY & 0xFF);
    sub[3] = (uint8_t)((hotspotY >> 8) & 0xFF);
    sub[4] = (uint8_t)(width & 0xFF);
    sub[5] = (uint8_t)((width >> 8) & 0xFF);
    sub[6] = (uint8_t)(height & 0xFF);
    sub[7] = (uint8_t)((height >> 8) & 0xFF);
    fwrite(sub, 1, 8, g_binary_out);

    /* RGBA pixel data */
    fwrite(rgba_data, 1, rgba_len, g_binary_out);

    fflush(g_binary_out);
    LeaveCriticalSection(&output_mutex);
}

void output_send_cursor_null(void) {
    output_send(MSG_TYPE_CURSOR_NULL, NULL, 0);
}

void output_send_cursor_default(void) {
    output_send(MSG_TYPE_CURSOR_DEFAULT, NULL, 0);
}

void output_send_error(const char *message) {
    char json[2048];
    int len = snprintf(json, sizeof(json), "{\"message\":\"%s\"}", message ? message : "Unknown error");
    output_send(MSG_TYPE_ERROR, json, (uint32_t)len);
}
