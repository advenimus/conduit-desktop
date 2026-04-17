/**
 * output.h — Binary protocol framing for stdout.
 *
 * Message format: [type:u32-LE][length:u32-LE][payload...]
 *
 * Message types:
 *   0x01 CONNECTED    - JSON: {"width":N,"height":N}
 *   0x02 BITMAP_UPDATE - [x:u16][y:u16][w:u16][h:u16][rgba_data...]
 *   0x03 DISCONNECTED - JSON: {"error":null} or {"error":"..."}
 *   0x04 RESIZED      - JSON: {"width":N,"height":N}
 *   0x06 CLIPBOARD_FILE_LIST  - JSON: {"files":[{"name":"...","size":N,"isDir":false},...]}
 *   0x07 CLIPBOARD_FILE_DONE  - JSON: {"fileIndex":N,"tempPath":"...","name":"...","size":N}
 *   0x08 CLIPBOARD_FILE_ERROR - JSON: {"fileIndex":N,"error":"..."}
 *   0x09 CLIPBOARD_FILE_PROGRESS - JSON: {"fileIndex":N,"bytesTransferred":N,"totalSize":N,"totalFiles":N,"direction":"download"|"upload"}
 *   0x0A CLIPBOARD_NATIVE - JSON: {} (tells Electron native clipboard is active, stop polling)
 *   0x0B CURSOR_SET   - [hotspotX:u16][hotspotY:u16][width:u16][height:u16][rgba_data...]
 *   0x0C CURSOR_NULL  - (empty) hide cursor
 *   0x0D CURSOR_DEFAULT - (empty) system default cursor
 *   0xFF ERROR        - JSON: {"message":"..."}
 */

#ifndef OUTPUT_H
#define OUTPUT_H

#include <stdint.h>
#include <stddef.h>

#define MSG_TYPE_CONNECTED     0x01
#define MSG_TYPE_BITMAP_UPDATE 0x02
#define MSG_TYPE_DISCONNECTED  0x03
#define MSG_TYPE_RESIZED       0x04
#define MSG_TYPE_CLIPBOARD_TEXT       0x05
#define MSG_TYPE_CLIPBOARD_FILE_LIST  0x06
#define MSG_TYPE_CLIPBOARD_FILE_DONE  0x07
#define MSG_TYPE_CLIPBOARD_FILE_ERROR    0x08
#define MSG_TYPE_CLIPBOARD_FILE_PROGRESS 0x09
#define MSG_TYPE_CLIPBOARD_NATIVE        0x0A
#define MSG_TYPE_CURSOR_SET              0x0B
#define MSG_TYPE_CURSOR_NULL             0x0C
#define MSG_TYPE_CURSOR_DEFAULT          0x0D
#define MSG_TYPE_ERROR                   0xFF

/**
 * Send a binary-framed message to stdout.
 * Thread-safe (uses internal mutex).
 */
void output_send(uint32_t type, const void *payload, uint32_t length);

/**
 * Send CONNECTED message with desktop dimensions.
 */
void output_send_connected(int width, int height);

/**
 * Send a BITMAP_UPDATE with dirty region + RGBA pixel data.
 */
void output_send_bitmap(uint16_t x, uint16_t y, uint16_t w, uint16_t h,
                        const uint8_t *rgba_data, size_t rgba_len);

/**
 * Send DISCONNECTED message.
 */
void output_send_disconnected(const char *error);

/**
 * Send RESIZED message.
 */
void output_send_resized(int width, int height);

/**
 * Send ERROR message.
 */
void output_send_error(const char *message);

/**
 * Send CLIPBOARD_TEXT message with UTF-8 text from the remote desktop.
 */
void output_send_clipboard_text(const char *utf8_text, int length);

/**
 * Send CLIPBOARD_FILE_LIST message with JSON file list from remote.
 */
void output_send_clipboard_file_list(const char *json, int length);

/**
 * Send CLIPBOARD_FILE_DONE message when a file download completes.
 */
void output_send_clipboard_file_done(const char *json, int length);

/**
 * Send CLIPBOARD_FILE_ERROR message on file download error.
 */
void output_send_clipboard_file_error(const char *json, int length);

/**
 * Send CLIPBOARD_FILE_PROGRESS message with transfer progress.
 */
void output_send_clipboard_file_progress(const char *json, int length);

/**
 * Send CLIPBOARD_NATIVE message to tell Electron that native clipboard
 * is active and it should stop polling. Payload is empty JSON "{}".
 */
void output_send_clipboard_native(void);

/**
 * Send CURSOR_SET message with custom cursor RGBA data.
 */
void output_send_cursor(uint16_t hotspotX, uint16_t hotspotY,
                        uint16_t width, uint16_t height,
                        const uint8_t *rgba_data, size_t rgba_len);

/**
 * Send CURSOR_NULL message (hide cursor).
 */
void output_send_cursor_null(void);

/**
 * Send CURSOR_DEFAULT message (system default cursor).
 */
void output_send_cursor_default(void);

/**
 * Initialize output (sets stdout to binary mode on Windows).
 */
void output_init(void);

#endif /* OUTPUT_H */
