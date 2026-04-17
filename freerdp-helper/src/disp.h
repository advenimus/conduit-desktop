/**
 * disp.h — RDPEDISP display control channel for dynamic resize.
 *
 * Sends monitor layout PDUs to resize the remote desktop in-session
 * without reconnecting. Thread-safe: resize requests come from the
 * stdin command thread, while the DISP channel runs on the event loop.
 */

#ifndef DISP_H
#define DISP_H

#include <freerdp/client/disp.h>

/**
 * Reset DISP module state. Call before connection_init().
 */
void disp_init(void);

/**
 * Called from cb_channel_connected when DISP DVC connects.
 * Stores the context and registers the caps callback.
 */
void disp_channel_connected(DispClientContext *disp);

/**
 * Called from cb_channel_disconnected when DISP DVC disconnects.
 * Clears the stored context.
 */
void disp_channel_disconnected(void);

/**
 * Store the initial connection layout. When the DISP channel activates,
 * a monitor layout PDU with these dimensions and scale factors will be
 * sent automatically. This triggers server-side DPI scaling on Windows
 * 10 1803+ / Server 2019+.
 */
void disp_set_initial_layout(int width, int height, int desktop_scale_factor, int device_scale_factor);

/**
 * Request a resize via RDPEDISP. Thread-safe (called from stdin thread).
 * If within the 200ms rate-limit cooldown, stores as pending resize.
 * Dimensions are clamped to 200-8192 and rounded to even.
 */
void disp_request_resize(int width, int height, int desktop_scale_factor, int device_scale_factor);

/**
 * Drain any pending rate-limited resize. Call from the event loop
 * thread after each connection_check_events() iteration.
 */
void disp_check_pending(void);

#endif /* DISP_H */
