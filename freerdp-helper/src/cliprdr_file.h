/**
 * cliprdr_file.h — CLIPRDR file clipboard extension for file transfer.
 *
 * Implements the file stream clipboard protocol (MS-RDPECLIP) for
 * bidirectional file transfer between local and remote desktops.
 * Handles FileGroupDescriptorW format negotiation, FileContentsRequest/
 * Response PDUs, and clipboard data locking.
 *
 * Thread safety: set_local_files() and request_download() are called from
 * the stdin command thread, while CLIPRDR callbacks run on the event loop.
 * All shared state is protected by a critical section.
 */

#ifndef CLIPRDR_FILE_H
#define CLIPRDR_FILE_H

#include <freerdp/client/cliprdr.h>
#include <stdbool.h>

/**
 * Initialize file clipboard module. Call before connection.
 */
void cliprdr_file_init(void);

/**
 * Cleanup file clipboard module. Free all state.
 */
void cliprdr_file_cleanup(void);

/**
 * Called when CLIPRDR SVC connects. Registers file-related callbacks.
 */
void cliprdr_file_channel_connected(CliprdrClientContext *cliprdr);

/**
 * Called when CLIPRDR SVC disconnects.
 */
void cliprdr_file_channel_disconnected(void);

/**
 * Returns capability flags to OR into generalFlags during MonitorReady.
 * Returns CB_STREAM_FILECLIP_ENABLED | CB_FILECLIP_NO_FILE_PATHS |
 *         CB_CAN_LOCK_CLIPDATA | CB_HUGE_FILE_SUPPORT_ENABLED
 */
UINT32 cliprdr_file_get_capability_flags(void);

/* ── Remote → Local ────────────────────────────────────────────────── */

/**
 * Called when server's FormatList contains FileGroupDescriptorW.
 * Stores format ID and requests FGD data from server.
 */
void cliprdr_file_server_has_files(CliprdrClientContext *cliprdr, UINT32 fgd_format_id);

/**
 * Called when FormatDataResponse contains FileGroupDescriptorW data.
 * Parses FILEDESCRIPTORW array and notifies Electron via stdout.
 */
void cliprdr_file_handle_fgd_response(const BYTE *data, UINT32 len);

/**
 * Called from stdin thread. Downloads remote files to temp_dir.
 * Thread-safe.
 */
void cliprdr_file_request_download(const char *temp_dir);

/* ── Local → Remote ────────────────────────────────────────────────── */

/**
 * Called from stdin thread. Sets local files to offer to remote.
 * json is a JSON array: [{"path":"...","name":"...","size":N,"isDirectory":false},...]
 * Thread-safe.
 */
void cliprdr_file_set_local_files(const char *json);

/**
 * Returns true if local files are staged for transfer.
 */
bool cliprdr_file_has_local_files(void);

/**
 * Clear staged local files. Call when clipboard switches to text mode.
 * Thread-safe.
 */
void cliprdr_file_clear_local_files(void);

/**
 * Returns the dynamically registered format ID for FileGroupDescriptorW.
 * Returns 0 if not yet known.
 */
UINT32 cliprdr_file_get_fgd_format_id(void);

/**
 * Set the format ID used when announcing FileGroupDescriptorW.
 * Called from cliprdr.c when we send a FormatList with FGD.
 */
void cliprdr_file_set_fgd_format_id(UINT32 format_id);

/**
 * Handle FormatDataRequest for FileGroupDescriptorW format.
 * Serializes local file descriptors and sends response.
 * Must be called with the cliprdr context.
 */
UINT cliprdr_file_handle_fgd_request(CliprdrClientContext *cliprdr);

#endif /* CLIPRDR_FILE_H */
