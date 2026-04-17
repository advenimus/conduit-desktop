/**
 * connection.h — FreeRDP connection management.
 *
 * Handles connect/disconnect, GDI initialization, and EndPaint callback
 * for frame capture.
 */

#ifndef CONNECTION_H
#define CONNECTION_H

#include <freerdp/freerdp.h>
#include <stdbool.h>
#include "protocol.h"

/**
 * Initialize a FreeRDP instance with the given configuration.
 * Sets up callbacks (PreConnect, PostConnect, EndPaint, PostDisconnect).
 * Returns the freerdp instance, or NULL on failure.
 */
freerdp *connection_init(const ConnectConfig *config);

/**
 * Connect to the RDP server (blocking).
 * Returns true on success.
 */
bool connection_connect(freerdp *instance);

/**
 * Run one iteration of the event loop.
 * Returns true to continue, false to stop (disconnect or error).
 */
bool connection_check_events(freerdp *instance);

/**
 * Disconnect and free the FreeRDP instance.
 */
void connection_free(freerdp *instance);

/**
 * Get post-resize frame diagnostic info.
 * Returns the number of EndPaint frames received since the last resize.
 * resize_gen is incremented on each resize (0 = no resize yet).
 */
void connection_get_resize_diag(int *resize_gen, int *post_resize_frames);

#endif /* CONNECTION_H */
