/**
 * cliprdr_win32.h — Native Windows clipboard integration for CLIPRDR.
 *
 * On Windows, creates a hidden HWND that participates directly in the
 * clipboard chain via Win32 APIs, bypassing Electron's clipboard polling.
 * This avoids persistent bugs with Electron's clipboard abstraction on
 * Windows (text/uri-list misreporting, lazy clipboard, format switching).
 *
 * macOS continues to use the Electron-based clipboard flow unchanged.
 *
 * Threading model:
 *   Thread 1 (stdin): Ignores CMD_CLIPBOARD_SET when native active
 *   Thread 2 (FreeRDP event loop): CLIPRDR callbacks PostMessage to Thread 3
 *   Thread 3 (Win32 clipboard): Message pump, all clipboard API calls here
 */

#ifndef CLIPRDR_WIN32_H
#define CLIPRDR_WIN32_H

#ifdef _WIN32

#include <stdbool.h>
#include <stdint.h>

/**
 * Create the clipboard thread and hidden HWND.
 * Call once at startup (before connection).
 */
void cliprdr_win32_init(void);

/**
 * Destroy the hidden window, join the clipboard thread.
 * Call at shutdown.
 */
void cliprdr_win32_cleanup(void);

/**
 * Enable/disable clipboard monitoring after CLIPRDR channel connects/disconnects.
 */
void cliprdr_win32_set_ready(bool ready);

/**
 * Place UTF-16 text on the native Windows clipboard.
 * Called from CLIPRDR callback thread; posts to clipboard thread.
 * @param wstr  UTF-16LE text (not null-terminated)
 * @param len   Length in WCHARs (not bytes)
 */
void cliprdr_win32_set_text(const wchar_t *wstr, int len);

/**
 * Place file paths on the native Windows clipboard as CF_HDROP.
 * Called after remote→local file download completes.
 * @param paths  Array of wide-char file paths
 * @param count  Number of paths
 */
void cliprdr_win32_set_files(const wchar_t **paths, int count);

/**
 * Returns true if native clipboard mode is active (thread running + ready).
 */
bool cliprdr_win32_is_active(void);

#endif /* _WIN32 */
#endif /* CLIPRDR_WIN32_H */
