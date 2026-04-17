/**
 * cliprdr_win32.c — Native Windows clipboard integration for CLIPRDR.
 *
 * Creates a dedicated thread with a Win32 message pump and a hidden
 * HWND_MESSAGE window. Participates directly in the Windows clipboard
 * chain via AddClipboardFormatListener(), bypassing Electron entirely.
 *
 * Local → Remote: WM_CLIPBOARDUPDATE reads CF_UNICODETEXT or CF_HDROP,
 *   then calls existing cliprdr_set_text() / cliprdr_file_set_local_files()
 *   + cliprdr_announce_files().
 *
 * Remote → Local: CLIPRDR callbacks PostMessage() to this thread, which
 *   calls SetClipboardData(CF_UNICODETEXT) or SetClipboardData(CF_HDROP).
 *
 * Echo prevention: s_we_set_clipboard flag prevents our own clipboard
 *   writes from triggering WM_CLIPBOARDUPDATE re-processing.
 */

#ifdef _WIN32

#include "cliprdr_win32.h"
#include "cliprdr.h"
#include "cliprdr_file.h"
#include "output.h"

#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Custom window messages for cross-thread clipboard writes */
#define WM_CLIPRDR_SET_TEXT    (WM_APP + 1)
#define WM_CLIPRDR_SET_FILES   (WM_APP + 2)
#define WM_CLIPRDR_SHUTDOWN    (WM_APP + 3)
#define WM_CLIPRDR_CLEAR_FLAG  (WM_APP + 4)  /* Deferred s_we_set_clipboard clear */

/* ── Module state ─────────────────────────────────────────────────────── */

static HANDLE s_thread = NULL;
static HWND s_hwnd = NULL;
static volatile bool s_ready = false;
static volatile bool s_thread_running = false;

/* Reentrancy guard: set to true when WE are writing to the clipboard,
 * so WM_CLIPBOARDUPDATE ignores the change we just made. */
static volatile bool s_we_set_clipboard = false;

/* ── Data structures passed via PostMessage ──────────────────────────── */

typedef struct {
    wchar_t *text;  /* Heap-allocated UTF-16 copy */
    int len;        /* Length in WCHARs */
} ClipTextData;

typedef struct {
    wchar_t **paths;  /* Heap-allocated array of heap-allocated paths */
    int count;
} ClipFilesData;

/* ── Helper: Open clipboard with retry ───────────────────────────────── */

static bool open_clipboard_retry(HWND hwnd) {
    for (int attempt = 0; attempt < 3; attempt++) {
        if (OpenClipboard(hwnd)) return true;
        Sleep(50);
    }
    fprintf(stderr, "[conduit-freerdp] WIN32 CLIP: OpenClipboard failed after 3 attempts (err=%lu)\n",
            GetLastError());
    return false;
}

/* ── Local clipboard changed → forward to CLIPRDR ────────────────────── */

static void on_local_clipboard_changed(void) {
    if (!s_ready) return;

    /* Check what formats are available */
    bool has_hdrop = IsClipboardFormatAvailable(CF_HDROP) != 0;
    bool has_text = IsClipboardFormatAvailable(CF_UNICODETEXT) != 0;

    if (!has_hdrop && !has_text) return;

    if (!open_clipboard_retry(s_hwnd)) return;

    if (has_hdrop) {
        /* Read file paths from CF_HDROP */
        HANDLE hData = GetClipboardData(CF_HDROP);
        if (hData) {
            HDROP hDrop = (HDROP)hData;
            UINT fileCount = DragQueryFileW(hDrop, 0xFFFFFFFF, NULL, 0);

            if (fileCount > 0 && fileCount <= 256) {
                /* Build JSON array for cliprdr_file_set_local_files */
                /* Format: [{"path":"...","name":"...","size":N,"isDirectory":false},...] */
                size_t json_cap = 256 + fileCount * 1024;
                char *json = (char *)malloc(json_cap);
                if (json) {
                    size_t pos = 0;
                    json[pos++] = '[';

                    for (UINT i = 0; i < fileCount; i++) {
                        wchar_t wpath[MAX_PATH];
                        UINT len = DragQueryFileW(hDrop, i, wpath, MAX_PATH);
                        if (len == 0) continue;

                        /* Convert path to UTF-8 */
                        int utf8_len = WideCharToMultiByte(CP_UTF8, 0, wpath, (int)len, NULL, 0, NULL, NULL);
                        if (utf8_len <= 0) continue;
                        char *utf8_path = (char *)malloc((size_t)utf8_len + 1);
                        if (!utf8_path) continue;
                        WideCharToMultiByte(CP_UTF8, 0, wpath, (int)len, utf8_path, utf8_len, NULL, NULL);
                        utf8_path[utf8_len] = '\0';

                        /* Get file info */
                        WIN32_FILE_ATTRIBUTE_DATA fad;
                        bool is_dir = false;
                        UINT64 file_size = 0;
                        if (GetFileAttributesExW(wpath, GetFileExInfoStandard, &fad)) {
                            is_dir = (fad.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
                            file_size = ((UINT64)fad.nFileSizeHigh << 32) | fad.nFileSizeLow;
                        }

                        /* Extract filename from path */
                        const char *name = strrchr(utf8_path, '\\');
                        if (!name) name = strrchr(utf8_path, '/');
                        name = name ? name + 1 : utf8_path;

                        /* Escape backslashes in path for JSON */
                        size_t escaped_cap = (size_t)utf8_len * 2 + 1;
                        char *escaped_path = (char *)malloc(escaped_cap);
                        if (escaped_path) {
                            size_t ep = 0;
                            for (int j = 0; j < utf8_len && ep < escaped_cap - 2; j++) {
                                if (utf8_path[j] == '\\' || utf8_path[j] == '"') {
                                    escaped_path[ep++] = '\\';
                                }
                                escaped_path[ep++] = utf8_path[j];
                            }
                            escaped_path[ep] = '\0';

                            if (i > 0) json[pos++] = ',';
                            int written = snprintf(json + pos, json_cap - pos,
                                "{\"path\":\"%s\",\"name\":\"%s\",\"size\":%llu,\"isDirectory\":%s}",
                                escaped_path, name,
                                (unsigned long long)file_size,
                                is_dir ? "true" : "false");
                            if (written > 0) pos += (size_t)written;
                            free(escaped_path);
                        }

                        free(utf8_path);
                    }

                    json[pos++] = ']';
                    json[pos] = '\0';

                    CloseClipboard();

                    fprintf(stderr, "[conduit-freerdp] WIN32 CLIP: Local clipboard has %u files\n", fileCount);
                    cliprdr_file_set_local_files(json);
                    cliprdr_announce_files();
                    free(json);
                    return;
                }
            }
        }
    }

    if (has_text) {
        HANDLE hData = GetClipboardData(CF_UNICODETEXT);
        if (hData) {
            const wchar_t *wtext = (const wchar_t *)GlobalLock(hData);
            if (wtext) {
                int wlen = (int)wcslen(wtext);
                if (wlen > 0) {
                    /* Convert to UTF-8 for cliprdr_set_text */
                    int utf8_len = WideCharToMultiByte(CP_UTF8, 0, wtext, wlen, NULL, 0, NULL, NULL);
                    if (utf8_len > 0) {
                        char *utf8 = (char *)malloc((size_t)utf8_len + 1);
                        if (utf8) {
                            WideCharToMultiByte(CP_UTF8, 0, wtext, wlen, utf8, utf8_len, NULL, NULL);
                            utf8[utf8_len] = '\0';

                            GlobalUnlock(hData);
                            CloseClipboard();

                            fprintf(stderr, "[conduit-freerdp] WIN32 CLIP: Local clipboard text (%d chars)\n", utf8_len);

                            /* Clear any staged files — switching to text mode */
                            cliprdr_file_clear_local_files();
                            cliprdr_set_text(utf8, utf8_len);
                            free(utf8);
                            return;
                        }
                    }
                }
                GlobalUnlock(hData);
            }
        }
    }

    CloseClipboard();
}

/* ── Window procedure ─────────────────────────────────────────────────── */

static LRESULT CALLBACK clipboard_wndproc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    switch (msg) {
        case WM_CLIPBOARDUPDATE:
            if (s_we_set_clipboard) {
                /* Ignore — this is our own clipboard write echoing back */
                return 0;
            }
            on_local_clipboard_changed();
            return 0;

        case WM_CLIPRDR_SET_TEXT: {
            ClipTextData *data = (ClipTextData *)lParam;
            if (data && data->text && data->len > 0) {
                s_we_set_clipboard = true;

                if (open_clipboard_retry(hwnd)) {
                    EmptyClipboard();

                    /* Allocate global memory for CF_UNICODETEXT (include null terminator) */
                    size_t byte_len = ((size_t)data->len + 1) * sizeof(wchar_t);
                    HGLOBAL hMem = GlobalAlloc(GMEM_MOVEABLE, byte_len);
                    if (hMem) {
                        wchar_t *dest = (wchar_t *)GlobalLock(hMem);
                        if (dest) {
                            memcpy(dest, data->text, (size_t)data->len * sizeof(wchar_t));
                            dest[data->len] = L'\0';
                            GlobalUnlock(hMem);

                            if (!SetClipboardData(CF_UNICODETEXT, hMem)) {
                                fprintf(stderr, "[conduit-freerdp] WIN32 CLIP: SetClipboardData(text) failed: %lu\n",
                                        GetLastError());
                                GlobalFree(hMem);
                            } else {
                                fprintf(stderr, "[conduit-freerdp] WIN32 CLIP: Placed %d chars on native clipboard\n",
                                        data->len);
                            }
                        } else {
                            GlobalFree(hMem);
                        }
                    }
                    CloseClipboard();
                }

                /* Defer flag clear: WM_CLIPBOARDUPDATE is a posted message that
                 * arrives AFTER this handler returns. Post our clear AFTER it so
                 * the flag is still true when WM_CLIPBOARDUPDATE is dispatched. */
                PostMessageW(hwnd, WM_CLIPRDR_CLEAR_FLAG, 0, 0);
            }

            /* Free the posted data */
            if (data) {
                free(data->text);
                free(data);
            }
            return 0;
        }

        case WM_CLIPRDR_SET_FILES: {
            ClipFilesData *data = (ClipFilesData *)lParam;
            if (data && data->paths && data->count > 0) {
                s_we_set_clipboard = true;

                if (open_clipboard_retry(hwnd)) {
                    EmptyClipboard();

                    /* Calculate total size for DROPFILES struct */
                    size_t total_chars = 0;
                    for (int i = 0; i < data->count; i++) {
                        total_chars += wcslen(data->paths[i]) + 1; /* path + null */
                    }
                    total_chars += 1; /* Double null terminator */

                    size_t drop_size = sizeof(DROPFILES) + total_chars * sizeof(wchar_t);
                    HGLOBAL hMem = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, drop_size);
                    if (hMem) {
                        DROPFILES *df = (DROPFILES *)GlobalLock(hMem);
                        if (df) {
                            df->pFiles = sizeof(DROPFILES);
                            df->fWide = TRUE;  /* Unicode paths */

                            wchar_t *dest = (wchar_t *)((BYTE *)df + sizeof(DROPFILES));
                            for (int i = 0; i < data->count; i++) {
                                size_t len = wcslen(data->paths[i]);
                                memcpy(dest, data->paths[i], len * sizeof(wchar_t));
                                /* Normalize forward slashes to backslashes for Explorer */
                                wchar_t *start = dest;
                                for (size_t j = 0; j < len; j++) {
                                    if (start[j] == L'/') start[j] = L'\\';
                                }
                                dest += len;
                                *dest++ = L'\0';
                            }
                            *dest = L'\0'; /* Double null terminator */

                            GlobalUnlock(hMem);

                            if (!SetClipboardData(CF_HDROP, hMem)) {
                                fprintf(stderr, "[conduit-freerdp] WIN32 CLIP: SetClipboardData(CF_HDROP) failed: %lu\n",
                                        GetLastError());
                                GlobalFree(hMem);
                            } else {
                                fprintf(stderr, "[conduit-freerdp] WIN32 CLIP: Placed %d files on native clipboard\n",
                                        data->count);
                            }
                        } else {
                            GlobalFree(hMem);
                        }
                    }
                    CloseClipboard();
                }

                /* Defer flag clear — see WM_CLIPRDR_SET_TEXT comment */
                PostMessageW(hwnd, WM_CLIPRDR_CLEAR_FLAG, 0, 0);
            }

            /* Free the posted data */
            if (data) {
                if (data->paths) {
                    for (int i = 0; i < data->count; i++) {
                        free(data->paths[i]);
                    }
                    free(data->paths);
                }
                free(data);
            }
            return 0;
        }

        case WM_CLIPRDR_CLEAR_FLAG:
            s_we_set_clipboard = false;
            return 0;

        case WM_CLIPRDR_SHUTDOWN:
            PostQuitMessage(0);
            return 0;

        default:
            return DefWindowProcW(hwnd, msg, wParam, lParam);
    }
}

/* ── Clipboard thread ─────────────────────────────────────────────────── */

static DWORD WINAPI clipboard_thread_proc(LPVOID arg) {
    (void)arg;

    /* Register window class */
    WNDCLASSEXW wc;
    memset(&wc, 0, sizeof(wc));
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = clipboard_wndproc;
    wc.hInstance = GetModuleHandleW(NULL);
    wc.lpszClassName = L"ConduitClipboardHelper";

    if (!RegisterClassExW(&wc)) {
        fprintf(stderr, "[conduit-freerdp] WIN32 CLIP: RegisterClassEx failed: %lu\n", GetLastError());
        return 1;
    }

    /* Create hidden message-only window */
    s_hwnd = CreateWindowExW(
        0, L"ConduitClipboardHelper", L"",
        0, 0, 0, 0, 0,
        HWND_MESSAGE,  /* Message-only window — no visible UI */
        NULL, GetModuleHandleW(NULL), NULL
    );

    if (!s_hwnd) {
        fprintf(stderr, "[conduit-freerdp] WIN32 CLIP: CreateWindowEx failed: %lu\n", GetLastError());
        UnregisterClassW(L"ConduitClipboardHelper", GetModuleHandleW(NULL));
        return 1;
    }

    /* Register for clipboard change notifications */
    if (!AddClipboardFormatListener(s_hwnd)) {
        fprintf(stderr, "[conduit-freerdp] WIN32 CLIP: AddClipboardFormatListener failed: %lu\n", GetLastError());
        DestroyWindow(s_hwnd);
        s_hwnd = NULL;
        UnregisterClassW(L"ConduitClipboardHelper", GetModuleHandleW(NULL));
        return 1;
    }

    s_thread_running = true;
    fprintf(stderr, "[conduit-freerdp] WIN32 CLIP: Clipboard thread started, HWND=%p\n", (void *)s_hwnd);

    /* Send notification to Electron that native clipboard is active */
    output_send_clipboard_native();

    /* Message pump */
    MSG msg;
    while (GetMessageW(&msg, NULL, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    /* Cleanup */
    RemoveClipboardFormatListener(s_hwnd);
    DestroyWindow(s_hwnd);
    s_hwnd = NULL;
    UnregisterClassW(L"ConduitClipboardHelper", GetModuleHandleW(NULL));

    s_thread_running = false;
    fprintf(stderr, "[conduit-freerdp] WIN32 CLIP: Clipboard thread exiting\n");
    return 0;
}

/* ── Public API ──────────────────────────────────────────────────────── */

void cliprdr_win32_init(void) {
    if (s_thread) return; /* Already initialized */

    s_ready = false;
    s_we_set_clipboard = false;

    s_thread = CreateThread(NULL, 0, clipboard_thread_proc, NULL, 0, NULL);
    if (!s_thread) {
        fprintf(stderr, "[conduit-freerdp] WIN32 CLIP: Failed to create clipboard thread: %lu\n",
                GetLastError());
    }
}

void cliprdr_win32_cleanup(void) {
    s_ready = false;

    if (s_hwnd) {
        PostMessageW(s_hwnd, WM_CLIPRDR_SHUTDOWN, 0, 0);
    }

    if (s_thread) {
        WaitForSingleObject(s_thread, 3000);
        CloseHandle(s_thread);
        s_thread = NULL;
    }
}

void cliprdr_win32_set_ready(bool ready) {
    s_ready = ready;
    fprintf(stderr, "[conduit-freerdp] WIN32 CLIP: Ready = %s\n", ready ? "true" : "false");
}

void cliprdr_win32_set_text(const wchar_t *wstr, int len) {
    if (!s_hwnd || !wstr || len <= 0) return;

    /* Heap-allocate a copy to pass via PostMessage */
    ClipTextData *data = (ClipTextData *)malloc(sizeof(ClipTextData));
    if (!data) return;

    data->text = (wchar_t *)malloc(((size_t)len + 1) * sizeof(wchar_t));
    if (!data->text) {
        free(data);
        return;
    }
    memcpy(data->text, wstr, (size_t)len * sizeof(wchar_t));
    data->text[len] = L'\0';
    data->len = len;

    if (!PostMessageW(s_hwnd, WM_CLIPRDR_SET_TEXT, 0, (LPARAM)data)) {
        free(data->text);
        free(data);
        fprintf(stderr, "[conduit-freerdp] WIN32 CLIP: PostMessage(SET_TEXT) failed\n");
    }
}

void cliprdr_win32_set_files(const wchar_t **paths, int count) {
    if (!s_hwnd || !paths || count <= 0) return;

    ClipFilesData *data = (ClipFilesData *)malloc(sizeof(ClipFilesData));
    if (!data) return;

    data->paths = (wchar_t **)malloc((size_t)count * sizeof(wchar_t *));
    if (!data->paths) {
        free(data);
        return;
    }
    data->count = count;

    for (int i = 0; i < count; i++) {
        size_t len = wcslen(paths[i]);
        data->paths[i] = (wchar_t *)malloc((len + 1) * sizeof(wchar_t));
        if (data->paths[i]) {
            memcpy(data->paths[i], paths[i], (len + 1) * sizeof(wchar_t));
        } else {
            /* Cleanup on allocation failure */
            for (int j = 0; j < i; j++) free(data->paths[j]);
            free(data->paths);
            free(data);
            return;
        }
    }

    if (!PostMessageW(s_hwnd, WM_CLIPRDR_SET_FILES, 0, (LPARAM)data)) {
        for (int i = 0; i < count; i++) free(data->paths[i]);
        free(data->paths);
        free(data);
        fprintf(stderr, "[conduit-freerdp] WIN32 CLIP: PostMessage(SET_FILES) failed\n");
    }
}

bool cliprdr_win32_is_active(void) {
    return s_thread_running && s_hwnd != NULL;
}

#endif /* _WIN32 */
