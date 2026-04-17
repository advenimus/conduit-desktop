/**
 * cliprdr.h — CLIPRDR clipboard redirection channel for text sync.
 *
 * Implements MS-RDPECLIP protocol (text-only) to synchronize clipboard
 * content between local and remote desktops. Thread-safe: clipboard
 * set requests come from the stdin command thread, while CLIPRDR
 * callbacks run on the event loop.
 */

#ifndef CLIPRDR_H
#define CLIPRDR_H

#include <freerdp/client/cliprdr.h>

/**
 * Reset CLIPRDR module state. Call before connection_init().
 */
void cliprdr_init(void);

/**
 * Called from cb_channel_connected when CLIPRDR SVC connects.
 * Stores the context and registers all callbacks.
 */
void cliprdr_channel_connected(CliprdrClientContext *cliprdr);

/**
 * Called from cb_channel_disconnected when CLIPRDR SVC disconnects.
 * Clears the stored context.
 */
void cliprdr_channel_disconnected(void);

/**
 * Set local clipboard text to send to the remote desktop.
 * Thread-safe (called from stdin thread).
 * If the channel is ready, immediately announces the format list.
 */
void cliprdr_set_text(const char *text, int length);

/**
 * Announce local files to the remote desktop via FormatList.
 * Thread-safe (called from stdin thread after cliprdr_file_set_local_files).
 */
void cliprdr_announce_files(void);

#endif /* CLIPRDR_H */
