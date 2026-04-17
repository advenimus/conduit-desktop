/**
 * cliprdr_file.c — CLIPRDR file clipboard extension implementation.
 *
 * Handles MS-RDPECLIP file stream protocol for bidirectional file transfer.
 *
 * Remote → Local flow:
 *   1. Server sends FormatList with FileGroupDescriptorW
 *   2. We request FGD data → receive FILEDESCRIPTORW array
 *   3. Notify Electron of available files
 *   4. On download request: fetch file contents in 256KB chunks → write to temp dir
 *
 * Local → Remote flow:
 *   1. Electron sends file paths via stdin
 *   2. We build FILEDESCRIPTORW array, announce FGD format
 *   3. Server requests FGD data → we serialize and respond
 *   4. Server requests file contents → we read from disk and respond
 */

#include "cliprdr_file.h"
#include "output.h"
#include "cjson/cJSON.h"
#ifdef _WIN32
#include "cliprdr_win32.h"
#endif

#include <freerdp/channels/cliprdr.h>
#include <freerdp/utils/cliprdr_utils.h>
#include <winpr/synch.h>
#include <winpr/string.h>
#include <winpr/shell.h>
#include <winpr/file.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <sys/stat.h>

#ifdef _WIN32
#define fseeko _fseeki64
#else
#include <sys/types.h>
#include <unistd.h>
#endif

/* ── Constants ──────────────────────────────────────────────────────── */

#define FILE_CONTENTS_CHUNK_SIZE  (256 * 1024)  /* 256 KB per request */
#define MAX_LOCAL_FILES           256
#define MAX_STREAM_ID             0x7FFFFFFF

#ifndef FILE_ATTRIBUTE_DIRECTORY
#define FILE_ATTRIBUTE_DIRECTORY  0x00000010
#endif
#ifndef FILE_ATTRIBUTE_NORMAL
#define FILE_ATTRIBUTE_NORMAL     0x00000080
#endif

/* ── Local file entry (for local → remote) ──────────────────────────── */

typedef struct {
    char *path;      /* Full local path */
    char *name;      /* Display name (may include relative path for dirs) */
    UINT64 size;
    bool is_directory;
    UINT64 bytes_served;  /* Track upload progress (local→remote) */
} LocalFileEntry;

/* ── Download tracking (for remote → local) ─────────────────────────── */

typedef struct {
    int file_index;
    UINT32 stream_id;
    UINT64 total_size;
    UINT64 bytes_received;
    FILE *fp;
    char *temp_path;
    bool size_received;
    bool complete;
} DownloadEntry;

/* ── Module state — protected by mutex ──────────────────────────────── */

static CRITICAL_SECTION s_mutex;
static bool s_mutex_inited = false;
static CliprdrClientContext *s_cliprdr = NULL;

/* FileGroupDescriptorW format tracking */
static UINT32 s_fgd_format_id = 0;
static bool s_pending_fgd_request = false;

/* Remote → Local: server's file list */
static FILEDESCRIPTORW *s_server_descriptors = NULL;
static UINT32 s_server_file_count = 0;

/* Remote → Local: download state */
static DownloadEntry *s_downloads = NULL;
static int s_download_count = 0;
static int s_download_current = 0;
static bool s_downloading = false;
static char *s_download_temp_dir = NULL;
static UINT32 s_next_stream_id = 1;

/* Local → Remote: local files */
static LocalFileEntry *s_local_files = NULL;
static int s_local_file_count = 0;
static FILEDESCRIPTORW *s_local_descriptors = NULL;

/* Clipboard locking — server locks OUR data */
static UINT32 s_server_lock_id = 0;
static bool s_server_has_lock = false;

/* Clipboard locking — WE lock the SERVER's data (for remote→local download) */
static UINT32 s_our_lock_id = 0;
static bool s_our_lock_active = false;
static UINT32 s_next_lock_id = 100; /* Avoid collision with server's IDs */

/* ── Helpers ────────────────────────────────────────────────────────── */

static void free_local_files(void) {
    if (s_local_files) {
        for (int i = 0; i < s_local_file_count; i++) {
            free(s_local_files[i].path);
            free(s_local_files[i].name);
        }
        free(s_local_files);
        s_local_files = NULL;
    }
    s_local_file_count = 0;
    if (s_local_descriptors) {
        free(s_local_descriptors);
        s_local_descriptors = NULL;
    }
}

static void free_server_files(void) {
    if (s_server_descriptors) {
        free(s_server_descriptors);
        s_server_descriptors = NULL;
    }
    s_server_file_count = 0;
}

static void free_downloads(void) {
    if (s_downloads) {
        for (int i = 0; i < s_download_count; i++) {
            if (s_downloads[i].fp) {
                fclose(s_downloads[i].fp);
                s_downloads[i].fp = NULL;
            }
            free(s_downloads[i].temp_path);
        }
        free(s_downloads);
        s_downloads = NULL;
    }
    s_download_count = 0;
    s_download_current = 0;
    s_downloading = false;
    free(s_download_temp_dir);
    s_download_temp_dir = NULL;
}

/**
 * Convert backslashes to forward slashes (for macOS/Linux paths).
 * Modifies string in place.
 */
static void normalize_path_separators(char *path) {
#ifndef _WIN32
    for (char *p = path; *p; p++) {
        if (*p == '\\') *p = '/';
    }
#endif
}

/**
 * Sanitize a filename from the remote server to prevent path traversal.
 * Strips leading slashes, replaces ".." path components with "_".
 * Modifies string in place.
 */
static void sanitize_filename(char *name) {
    if (!name) return;

    /* Strip leading slashes */
    char *src = name;
    while (*src == '/' || *src == '\\') src++;
    if (src != name) memmove(name, src, strlen(src) + 1);

    /* Replace ".." components with "_" */
    char *p = name;
    while (*p) {
        /* Check for ".." at start or after separator */
        bool at_start = (p == name);
        bool after_sep = (p > name && (*(p - 1) == '/' || *(p - 1) == '\\'));
        if ((at_start || after_sep) && p[0] == '.' && p[1] == '.') {
            char next = p[2];
            if (next == '\0' || next == '/' || next == '\\') {
                p[0] = '_';
                p[1] = '_';
            }
        }
        p++;
    }
}

/**
 * Create parent directories for a file path.
 */
static void ensure_parent_dirs(const char *filepath) {
    char *dir = strdup(filepath);
    if (!dir) return;

    /* Find last separator */
    char *sep = strrchr(dir, '/');
#ifdef _WIN32
    char *sep2 = strrchr(dir, '\\');
    if (sep2 > sep) sep = sep2;
#endif

    if (sep && sep != dir) {
        *sep = '\0';
#ifdef _WIN32
        CreateDirectoryA(dir, NULL);
#else
        /* Recursive mkdir -p */
        for (char *p = dir + 1; *p; p++) {
            if (*p == '/') {
                *p = '\0';
                mkdir(dir, 0755);
                *p = '/';
            }
        }
        mkdir(dir, 0755);
#endif
    }
    free(dir);
}

/**
 * Convert FILEDESCRIPTORW filename to UTF-8.
 * Caller must free the returned string.
 */
static char *descriptor_name_to_utf8(const FILEDESCRIPTORW *desc) {
    size_t utf8_len = 0;
    char *utf8 = ConvertWCharNToUtf8Alloc(desc->cFileName, 260, &utf8_len);
    return utf8;
}

/**
 * Send a ClientLockClipboardData to lock the server's clipboard data.
 * This MUST be done before FileContentsRequests when CB_CAN_LOCK_CLIPDATA is advertised.
 * Must be called WITHOUT mutex held (sends PDU).
 */
static void lock_server_clipboard(CliprdrClientContext *cliprdr, UINT32 lock_id) {
    CLIPRDR_LOCK_CLIPBOARD_DATA lockData;
    memset(&lockData, 0, sizeof(lockData));
    lockData.clipDataId = lock_id;

    fprintf(stderr, "[conduit-freerdp] CLIPRDR FILE: Locking server clipboard (id=%u)\n", lock_id);
    UINT ret = cliprdr->ClientLockClipboardData(cliprdr, &lockData);
    if (ret != CHANNEL_RC_OK) {
        fprintf(stderr, "[conduit-freerdp] CLIPRDR FILE: Lock failed: 0x%08X\n", ret);
    }
}

/**
 * Send a ClientUnlockClipboardData to release the server's clipboard data.
 * Must be called WITHOUT mutex held.
 */
static void unlock_server_clipboard(CliprdrClientContext *cliprdr, UINT32 lock_id) {
    CLIPRDR_UNLOCK_CLIPBOARD_DATA unlockData;
    memset(&unlockData, 0, sizeof(unlockData));
    unlockData.clipDataId = lock_id;

    fprintf(stderr, "[conduit-freerdp] CLIPRDR FILE: Unlocking server clipboard (id=%u)\n", lock_id);
    UINT ret = cliprdr->ClientUnlockClipboardData(cliprdr, &unlockData);
    if (ret != CHANNEL_RC_OK) {
        fprintf(stderr, "[conduit-freerdp] CLIPRDR FILE: Unlock failed: 0x%08X\n", ret);
    }
}

/**
 * Send a FileContentsRequest and track it.
 * Must be called with mutex held.
 */
static UINT send_file_contents_request(int file_index, UINT32 dwFlags,
                                        UINT64 offset, UINT32 cbRequested) {
    if (!s_cliprdr) return ERROR_INTERNAL_ERROR;

    UINT32 stream_id = s_next_stream_id++;
    if (s_next_stream_id > MAX_STREAM_ID) s_next_stream_id = 1;

    CLIPRDR_FILE_CONTENTS_REQUEST request;
    memset(&request, 0, sizeof(request));
    request.streamId = stream_id;
    request.listIndex = (UINT32)file_index;
    request.dwFlags = dwFlags;
    request.nPositionLow = (UINT32)(offset & 0xFFFFFFFF);
    request.nPositionHigh = (UINT32)(offset >> 32);
    request.cbRequested = cbRequested;
    request.haveClipDataId = s_our_lock_active;
    request.clipDataId = s_our_lock_id;

    /* Track in download entry */
    if (file_index < s_download_count) {
        s_downloads[file_index].stream_id = stream_id;
    }

    UINT ret = s_cliprdr->ClientFileContentsRequest(s_cliprdr, &request);
    if (ret != CHANNEL_RC_OK) {
        fprintf(stderr, "[conduit-freerdp] CLIPRDR FILE: FileContentsRequest failed: 0x%08X "
                "(streamId=%u file=%d flags=0x%X)\n", ret, stream_id, file_index, dwFlags);
    }
    return ret;
}

/**
 * Initiate download of the next file in the queue.
 * Must be called with mutex held.
 */
static void start_next_download(void) {
    while (s_download_current < s_download_count) {
        DownloadEntry *entry = &s_downloads[s_download_current];
        if (entry->complete) {
            s_download_current++;
            continue;
        }

        /* Skip directories — just create them */
        if (s_download_current < (int)s_server_file_count) {
            FILEDESCRIPTORW *desc = &s_server_descriptors[s_download_current];
            if (desc->dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
                ensure_parent_dirs(entry->temp_path);
#ifdef _WIN32
                CreateDirectoryA(entry->temp_path, NULL);
#else
                mkdir(entry->temp_path, 0755);
#endif
                entry->complete = true;

                /* Notify Electron */
                char *name = descriptor_name_to_utf8(desc);
                if (name) normalize_path_separators(name);

                cJSON *jobj = cJSON_CreateObject();
                cJSON_AddNumberToObject(jobj, "fileIndex", entry->file_index);
                cJSON_AddStringToObject(jobj, "tempPath", entry->temp_path);
                cJSON_AddStringToObject(jobj, "name", name ? name : "");
                cJSON_AddNumberToObject(jobj, "size", 0);
                char *json = cJSON_PrintUnformatted(jobj);
                cJSON_Delete(jobj);
                free(name);
                if (json) {
                    output_send_clipboard_file_done(json, (int)strlen(json));
                    free(json);
                }

                s_download_current++;
                continue;
            }
        }

        /* Request file size first */
        if (!entry->size_received) {
            fprintf(stderr, "[conduit-freerdp] CLIPRDR FILE: Requesting size for file %d\n",
                    entry->file_index);
            UINT ret = send_file_contents_request(entry->file_index, FILECONTENTS_SIZE, 0, 8);
            if (ret != CHANNEL_RC_OK) {
                fprintf(stderr, "[conduit-freerdp] CLIPRDR FILE: Size request failed: 0x%08X\n", ret);
                entry->complete = true;
                char json[512];
                snprintf(json, sizeof(json),
                    "{\"fileIndex\":%d,\"error\":\"Size request failed\"}", entry->file_index);
                output_send_clipboard_file_error(json, (int)strlen(json));
                s_download_current++;
                continue;
            }
            return; /* Wait for response */
        }

        /* Request first chunk */
        UINT32 chunk = (UINT32)(entry->total_size - entry->bytes_received);
        if (chunk > FILE_CONTENTS_CHUNK_SIZE) chunk = FILE_CONTENTS_CHUNK_SIZE;

        fprintf(stderr, "[conduit-freerdp] CLIPRDR FILE: Requesting range for file %d, offset=%llu, size=%u\n",
                entry->file_index, (unsigned long long)entry->bytes_received, chunk);
        UINT ret = send_file_contents_request(entry->file_index, FILECONTENTS_RANGE,
                                               entry->bytes_received, chunk);
        if (ret != CHANNEL_RC_OK) {
            fprintf(stderr, "[conduit-freerdp] CLIPRDR FILE: Range request failed: 0x%08X\n", ret);
        }
        return; /* Wait for response */
    }

    /* All files complete — place on native clipboard (Windows) and unlock */
    s_downloading = false;
    fprintf(stderr, "[conduit-freerdp] CLIPRDR FILE: All %d files downloaded\n", s_download_count);

#ifdef _WIN32
    if (cliprdr_win32_is_active() && s_download_count > 0 && s_downloads && s_download_temp_dir) {
        /* Build wide-char path array for CF_HDROP placement.
         * Only include ROOT-LEVEL items (direct children of temp dir).
         * Nested files inside directories are excluded — Explorer copies
         * directory contents automatically when pasting a folder. */
        const wchar_t **wpaths = (const wchar_t **)malloc((size_t)s_download_count * sizeof(wchar_t *));
        wchar_t **wpaths_alloc = NULL; /* For cleanup */
        int valid_count = 0;

        /* Track root-level names we've already added (dedup) */
        char **seen_roots = (char **)calloc((size_t)s_download_count, sizeof(char *));
        int seen_count = 0;

        size_t temp_dir_len = strlen(s_download_temp_dir);

        if (wpaths && seen_roots) {
            wpaths_alloc = (wchar_t **)malloc((size_t)s_download_count * sizeof(wchar_t *));
            if (wpaths_alloc) {
                for (int i = 0; i < s_download_count; i++) {
                    if (!s_downloads[i].temp_path || !s_downloads[i].complete) continue;

                    const char *path = s_downloads[i].temp_path;

                    /* Compute relative path from temp dir */
                    if (strlen(path) <= temp_dir_len + 1) continue;
                    const char *rel = path + temp_dir_len + 1; /* skip "tempdir\" */

                    /* Extract first path component (the root-level item) */
                    const char *sep = strchr(rel, '\\');
                    if (!sep) sep = strchr(rel, '/');
                    size_t root_len = sep ? (size_t)(sep - rel) : strlen(rel);

                    /* Check if we already added this root-level item */
                    bool already_seen = false;
                    for (int j = 0; j < seen_count; j++) {
                        if (strlen(seen_roots[j]) == root_len &&
                            strncmp(seen_roots[j], rel, root_len) == 0) {
                            already_seen = true;
                            break;
                        }
                    }
                    if (already_seen) continue;

                    /* Record this root name */
                    seen_roots[seen_count] = (char *)malloc(root_len + 1);
                    if (seen_roots[seen_count]) {
                        memcpy(seen_roots[seen_count], rel, root_len);
                        seen_roots[seen_count][root_len] = '\0';
                        seen_count++;
                    }

                    /* Build the full path to the root-level item */
                    size_t root_path_len = temp_dir_len + 1 + root_len + 1;
                    char *root_path = (char *)malloc(root_path_len);
                    if (!root_path) continue;
                    snprintf(root_path, root_path_len, "%s\\%s",
                             s_download_temp_dir, seen_roots[seen_count - 1]);

                    int wlen = MultiByteToWideChar(CP_UTF8, 0, root_path, -1, NULL, 0);
                    if (wlen > 0) {
                        wchar_t *wpath = (wchar_t *)malloc((size_t)wlen * sizeof(wchar_t));
                        if (wpath) {
                            MultiByteToWideChar(CP_UTF8, 0, root_path, -1, wpath, wlen);
                            wpaths[valid_count] = wpath;
                            wpaths_alloc[valid_count] = wpath;
                            valid_count++;
                        }
                    }
                    free(root_path);
                }

                if (valid_count > 0) {
                    fprintf(stderr, "[conduit-freerdp] CLIPRDR FILE: Placing %d root items on native clipboard\n",
                            valid_count);
                    cliprdr_win32_set_files(wpaths, valid_count);
                }

                for (int i = 0; i < valid_count; i++) {
                    free(wpaths_alloc[i]);
                }
                free(wpaths_alloc);
            }
            free((void *)wpaths);
        }

        /* Free seen_roots */
        if (seen_roots) {
            for (int i = 0; i < seen_count; i++) {
                free(seen_roots[i]);
            }
            free(seen_roots);
        }
    }
#endif

    if (s_our_lock_active && s_cliprdr) {
        UINT32 lock_id = s_our_lock_id;
        s_our_lock_active = false;
        CliprdrClientContext *ctx = s_cliprdr;
        /* Unlock outside mutex to avoid deadlock */
        LeaveCriticalSection(&s_mutex);
        unlock_server_clipboard(ctx, lock_id);
        EnterCriticalSection(&s_mutex);
    }
}

/* ── CLIPRDR File Callbacks ─────────────────────────────────────────── */

/**
 * Server requests local file data (local → remote).
 */
static UINT cb_server_file_contents_request(CliprdrClientContext *cliprdr,
    const CLIPRDR_FILE_CONTENTS_REQUEST *request) {

    CLIPRDR_FILE_CONTENTS_RESPONSE response;
    memset(&response, 0, sizeof(response));
    response.streamId = request->streamId;

    EnterCriticalSection(&s_mutex);

    if ((int)request->listIndex >= s_local_file_count || !s_local_files) {
        LeaveCriticalSection(&s_mutex);
        fprintf(stderr, "[conduit-freerdp] CLIPRDR FILE: Invalid listIndex %u (have %d files)\n",
                request->listIndex, s_local_file_count);
        response.common.msgFlags = CB_RESPONSE_FAIL;
        return cliprdr->ClientFileContentsResponse(cliprdr, &response);
    }

    LocalFileEntry *entry = &s_local_files[request->listIndex];
    const char *path = entry->path;

    if (request->dwFlags & FILECONTENTS_SIZE) {
        /* Return 8-byte file size */
        struct stat st;
        if (stat(path, &st) != 0) {
            LeaveCriticalSection(&s_mutex);
            fprintf(stderr, "[conduit-freerdp] CLIPRDR FILE: stat() failed for %s\n", path);
            response.common.msgFlags = CB_RESPONSE_FAIL;
            return cliprdr->ClientFileContentsResponse(cliprdr, &response);
        }

        UINT64 size = (UINT64)st.st_size;
        response.common.msgFlags = CB_RESPONSE_OK;
        response.common.dataLen = 8;
        response.cbRequested = 8;
        response.requestedData = (const BYTE *)&size;

        LeaveCriticalSection(&s_mutex);
        fprintf(stderr, "[conduit-freerdp] CLIPRDR FILE: Sending size %llu for file %u\n",
                (unsigned long long)size, request->listIndex);
        return cliprdr->ClientFileContentsResponse(cliprdr, &response);
    }

    if (request->dwFlags & FILECONTENTS_RANGE) {
        UINT64 offset = ((UINT64)request->nPositionHigh << 32) | request->nPositionLow;
        UINT32 requested = request->cbRequested;

        FILE *fp = fopen(path, "rb");
        if (!fp) {
            LeaveCriticalSection(&s_mutex);
            fprintf(stderr, "[conduit-freerdp] CLIPRDR FILE: fopen() failed for %s\n", path);
            response.common.msgFlags = CB_RESPONSE_FAIL;
            return cliprdr->ClientFileContentsResponse(cliprdr, &response);
        }

        LeaveCriticalSection(&s_mutex);

        if (fseeko(fp, (off_t)offset, SEEK_SET) != 0) {
            fclose(fp);
            response.common.msgFlags = CB_RESPONSE_FAIL;
            return cliprdr->ClientFileContentsResponse(cliprdr, &response);
        }

        BYTE *buf = (BYTE *)malloc(requested);
        if (!buf) {
            fclose(fp);
            response.common.msgFlags = CB_RESPONSE_FAIL;
            return cliprdr->ClientFileContentsResponse(cliprdr, &response);
        }

        size_t bytes_read = fread(buf, 1, requested, fp);
        fclose(fp);

        response.common.msgFlags = CB_RESPONSE_OK;
        response.common.dataLen = (UINT32)bytes_read;
        response.cbRequested = (UINT32)bytes_read;
        response.requestedData = buf;

        /* Track upload progress */
        EnterCriticalSection(&s_mutex);
        s_local_files[request->listIndex].bytes_served += bytes_read;
        UINT64 served = s_local_files[request->listIndex].bytes_served;
        UINT64 fsize = s_local_files[request->listIndex].size;
        int fcount = s_local_file_count;
        LeaveCriticalSection(&s_mutex);

        {
            char pjson[256];
            snprintf(pjson, sizeof(pjson),
                "{\"fileIndex\":%u,\"bytesTransferred\":%llu,\"totalSize\":%llu,"
                "\"totalFiles\":%d,\"direction\":\"upload\"}",
                request->listIndex,
                (unsigned long long)served,
                (unsigned long long)fsize,
                fcount);
            output_send_clipboard_file_progress(pjson, (int)strlen(pjson));
        }

        UINT ret = cliprdr->ClientFileContentsResponse(cliprdr, &response);
        free(buf);
        return ret;
    }

    LeaveCriticalSection(&s_mutex);
    response.common.msgFlags = CB_RESPONSE_FAIL;
    return cliprdr->ClientFileContentsResponse(cliprdr, &response);
}

/**
 * Server sends file data to us (remote → local download).
 */
static UINT cb_server_file_contents_response(CliprdrClientContext *cliprdr,
    const CLIPRDR_FILE_CONTENTS_RESPONSE *response) {
    (void)cliprdr;

    EnterCriticalSection(&s_mutex);

    if (!s_downloading || !s_downloads) {
        LeaveCriticalSection(&s_mutex);
        return CHANNEL_RC_OK;
    }

    /* Find the download entry matching this streamId */
    DownloadEntry *entry = NULL;
    for (int i = 0; i < s_download_count; i++) {
        if (s_downloads[i].stream_id == response->streamId) {
            entry = &s_downloads[i];
            break;
        }
    }

    if (!entry) {
        LeaveCriticalSection(&s_mutex);
        fprintf(stderr, "[conduit-freerdp] CLIPRDR FILE: Unknown streamId %u\n", response->streamId);
        return CHANNEL_RC_OK;
    }

    if (response->common.msgFlags != CB_RESPONSE_OK) {
        fprintf(stderr, "[conduit-freerdp] CLIPRDR FILE: Server returned FAIL for file %d\n",
                entry->file_index);
        entry->complete = true;
        char json[512];
        snprintf(json, sizeof(json),
            "{\"fileIndex\":%d,\"error\":\"Server returned failure\"}", entry->file_index);
        output_send_clipboard_file_error(json, (int)strlen(json));
        s_download_current++;
        start_next_download();
        LeaveCriticalSection(&s_mutex);
        return CHANNEL_RC_OK;
    }

    if (!entry->size_received) {
        /* This is a SIZE response.
         * NOTE: response->cbRequested is the actual data length (excludes the
         * 4-byte streamId that is included in common.dataLen). Always use
         * cbRequested when reading from requestedData. */
        if (response->requestedData && response->cbRequested >= 4) {
            if (response->cbRequested >= 8) {
                memcpy(&entry->total_size, response->requestedData, sizeof(UINT64));
            } else {
                UINT32 tmp = 0;
                memcpy(&tmp, response->requestedData, sizeof(UINT32));
                entry->total_size = tmp;
            }
        } else {
            entry->total_size = 0;
        }
        entry->size_received = true;

        fprintf(stderr, "[conduit-freerdp] CLIPRDR FILE: File %d size = %llu\n",
                entry->file_index, (unsigned long long)entry->total_size);

        /* Handle zero-byte files */
        if (entry->total_size == 0) {
            ensure_parent_dirs(entry->temp_path);
            FILE *fp = fopen(entry->temp_path, "wb");
            if (fp) fclose(fp);
            entry->complete = true;

            char *name = NULL;
            if (entry->file_index < (int)s_server_file_count) {
                name = descriptor_name_to_utf8(&s_server_descriptors[entry->file_index]);
                if (name) normalize_path_separators(name);
            }
            cJSON *jobj = cJSON_CreateObject();
            cJSON_AddNumberToObject(jobj, "fileIndex", entry->file_index);
            cJSON_AddStringToObject(jobj, "tempPath", entry->temp_path);
            cJSON_AddStringToObject(jobj, "name", name ? name : "");
            cJSON_AddNumberToObject(jobj, "size", 0);
            char *json = cJSON_PrintUnformatted(jobj);
            cJSON_Delete(jobj);
            free(name);
            if (json) {
                output_send_clipboard_file_done(json, (int)strlen(json));
                free(json);
            }

            s_download_current++;
            start_next_download();
            LeaveCriticalSection(&s_mutex);
            return CHANNEL_RC_OK;
        }

        /* Open temp file and request first chunk */
        ensure_parent_dirs(entry->temp_path);
        entry->fp = fopen(entry->temp_path, "wb");
        if (!entry->fp) {
            fprintf(stderr, "[conduit-freerdp] CLIPRDR FILE: Cannot open %s for writing\n",
                    entry->temp_path);
            entry->complete = true;
            char json[512];
            snprintf(json, sizeof(json),
                "{\"fileIndex\":%d,\"error\":\"Cannot open temp file\"}", entry->file_index);
            output_send_clipboard_file_error(json, (int)strlen(json));
            s_download_current++;
        }

        start_next_download();
        LeaveCriticalSection(&s_mutex);
        return CHANNEL_RC_OK;
    }

    /* RANGE response — write data to temp file.
     * IMPORTANT: Use cbRequested (actual data length), NOT common.dataLen
     * which includes the 4-byte streamId prefix. Using dataLen would write
     * 4 garbage bytes per chunk and corrupt file offsets. */
    if (response->requestedData && response->cbRequested > 0 && entry->fp) {
        size_t written = fwrite(response->requestedData, 1,
                                response->cbRequested, entry->fp);
        entry->bytes_received += written;

        /* Emit progress (every chunk) */
        {
            char pjson[256];
            snprintf(pjson, sizeof(pjson),
                "{\"fileIndex\":%d,\"bytesTransferred\":%llu,\"totalSize\":%llu,"
                "\"totalFiles\":%d,\"direction\":\"download\"}",
                entry->file_index,
                (unsigned long long)entry->bytes_received,
                (unsigned long long)entry->total_size,
                s_download_count);
            output_send_clipboard_file_progress(pjson, (int)strlen(pjson));
        }

        if (entry->bytes_received >= entry->total_size) {
            /* File complete — flush and close with error checking */
            if (fflush(entry->fp) != 0) {
                fprintf(stderr, "[conduit-freerdp] CLIPRDR FILE: fflush failed for file %d: %s\n",
                        entry->file_index, strerror(errno));
            }
            if (fclose(entry->fp) != 0) {
                fprintf(stderr, "[conduit-freerdp] CLIPRDR FILE: fclose failed for file %d: %s\n",
                        entry->file_index, strerror(errno));
            }
            entry->fp = NULL;
            entry->complete = true;

            char *name = NULL;
            if (entry->file_index < (int)s_server_file_count) {
                name = descriptor_name_to_utf8(&s_server_descriptors[entry->file_index]);
                if (name) normalize_path_separators(name);
            }

            fprintf(stderr, "[conduit-freerdp] CLIPRDR FILE: File %d complete (%llu bytes) → %s\n",
                    entry->file_index, (unsigned long long)entry->bytes_received, entry->temp_path);

            cJSON *jobj = cJSON_CreateObject();
            cJSON_AddNumberToObject(jobj, "fileIndex", entry->file_index);
            cJSON_AddStringToObject(jobj, "tempPath", entry->temp_path);
            cJSON_AddStringToObject(jobj, "name", name ? name : "");
            cJSON_AddNumberToObject(jobj, "size", (double)entry->total_size);
            char *json = cJSON_PrintUnformatted(jobj);
            cJSON_Delete(jobj);
            free(name);
            if (json) {
                output_send_clipboard_file_done(json, (int)strlen(json));
                free(json);
            }

            s_download_current++;
            start_next_download();
            LeaveCriticalSection(&s_mutex);
            return CHANNEL_RC_OK;
        }

        /* Request next chunk */
        UINT64 remaining = entry->total_size - entry->bytes_received;
        UINT32 chunk = (UINT32)(remaining > FILE_CONTENTS_CHUNK_SIZE ?
                                FILE_CONTENTS_CHUNK_SIZE : remaining);
        send_file_contents_request(entry->file_index, FILECONTENTS_RANGE,
                                    entry->bytes_received, chunk);
    }

    LeaveCriticalSection(&s_mutex);
    return CHANNEL_RC_OK;
}

/**
 * Server locks clipboard data during multi-file transfer.
 */
static UINT cb_server_lock_clipboard_data(CliprdrClientContext *cliprdr,
    const CLIPRDR_LOCK_CLIPBOARD_DATA *lockData) {
    (void)cliprdr;
    EnterCriticalSection(&s_mutex);
    s_server_lock_id = lockData->clipDataId;
    s_server_has_lock = true;
    LeaveCriticalSection(&s_mutex);
    fprintf(stderr, "[conduit-freerdp] CLIPRDR FILE: Server locked our data (id=%u)\n", lockData->clipDataId);
    return CHANNEL_RC_OK;
}

/**
 * Server unlocks clipboard data.
 */
static UINT cb_server_unlock_clipboard_data(CliprdrClientContext *cliprdr,
    const CLIPRDR_UNLOCK_CLIPBOARD_DATA *unlockData) {
    (void)cliprdr;
    EnterCriticalSection(&s_mutex);
    if (s_server_lock_id == unlockData->clipDataId) {
        s_server_has_lock = false;
    }
    LeaveCriticalSection(&s_mutex);
    fprintf(stderr, "[conduit-freerdp] CLIPRDR FILE: Server unlocked our data (id=%u)\n", unlockData->clipDataId);
    return CHANNEL_RC_OK;
}

/* ── Public API ─────────────────────────────────────────────────────── */

void cliprdr_file_init(void) {
    if (!s_mutex_inited) {
        InitializeCriticalSection(&s_mutex);
        s_mutex_inited = true;
    }
    EnterCriticalSection(&s_mutex);
    s_cliprdr = NULL;
    s_fgd_format_id = 0;
    s_pending_fgd_request = false;
    free_server_files();
    free_downloads();
    free_local_files();
    s_server_has_lock = false;
    s_server_lock_id = 0;
    s_our_lock_active = false;
    s_our_lock_id = 0;
    s_next_lock_id = 100;
    s_next_stream_id = 1;
    LeaveCriticalSection(&s_mutex);
}

void cliprdr_file_cleanup(void) {
    if (!s_mutex_inited) return;
    EnterCriticalSection(&s_mutex);
    free_server_files();
    free_downloads();
    free_local_files();
    s_cliprdr = NULL;
    LeaveCriticalSection(&s_mutex);
}

void cliprdr_file_channel_connected(CliprdrClientContext *cliprdr) {
    EnterCriticalSection(&s_mutex);
    s_cliprdr = cliprdr;

    cliprdr->ServerFileContentsRequest = cb_server_file_contents_request;
    cliprdr->ServerFileContentsResponse = cb_server_file_contents_response;
    cliprdr->ServerLockClipboardData = cb_server_lock_clipboard_data;
    cliprdr->ServerUnlockClipboardData = cb_server_unlock_clipboard_data;

    LeaveCriticalSection(&s_mutex);
    fprintf(stderr, "[conduit-freerdp] CLIPRDR FILE: Channel connected, callbacks registered\n");
}

void cliprdr_file_channel_disconnected(void) {
    EnterCriticalSection(&s_mutex);
    s_cliprdr = NULL;
    s_our_lock_active = false;
    free_downloads();
    LeaveCriticalSection(&s_mutex);
    fprintf(stderr, "[conduit-freerdp] CLIPRDR FILE: Channel disconnected\n");
}

UINT32 cliprdr_file_get_capability_flags(void) {
    return CB_STREAM_FILECLIP_ENABLED
         | CB_FILECLIP_NO_FILE_PATHS
         | CB_CAN_LOCK_CLIPDATA
         | CB_HUGE_FILE_SUPPORT_ENABLED;
}

void cliprdr_file_server_has_files(CliprdrClientContext *cliprdr, UINT32 fgd_format_id) {
    EnterCriticalSection(&s_mutex);
    s_fgd_format_id = fgd_format_id;
    s_pending_fgd_request = true;

    /* Unlock any previous lock on the server's data */
    UINT32 old_lock_id = s_our_lock_id;
    bool had_lock = s_our_lock_active;

    /* Cancel any in-progress download */
    free_downloads();
    free_server_files();

    /* Assign a new lock ID for this clipboard data */
    s_our_lock_id = s_next_lock_id++;
    s_our_lock_active = true;
    UINT32 new_lock_id = s_our_lock_id;

    LeaveCriticalSection(&s_mutex);

    /* Unlock previous server data if we had a lock */
    if (had_lock) {
        unlock_server_clipboard(cliprdr, old_lock_id);
    }

    /* Lock the server's new clipboard data */
    lock_server_clipboard(cliprdr, new_lock_id);

    /* Request the FileGroupDescriptorW data */
    CLIPRDR_FORMAT_DATA_REQUEST request;
    memset(&request, 0, sizeof(request));
    request.requestedFormatId = fgd_format_id;

    fprintf(stderr, "[conduit-freerdp] CLIPRDR FILE: Requesting FGD data (format=%u)\n", fgd_format_id);
    UINT ret = cliprdr->ClientFormatDataRequest(cliprdr, &request);
    if (ret != CHANNEL_RC_OK) {
        fprintf(stderr, "[conduit-freerdp] CLIPRDR FILE: FGD request failed: 0x%08X\n", ret);
        EnterCriticalSection(&s_mutex);
        s_pending_fgd_request = false;
        LeaveCriticalSection(&s_mutex);
    }
}

void cliprdr_file_handle_fgd_response(const BYTE *data, UINT32 len) {
    EnterCriticalSection(&s_mutex);
    s_pending_fgd_request = false;

    free_server_files();

    FILEDESCRIPTORW *descriptors = NULL;
    UINT32 count = 0;
    UINT result = cliprdr_parse_file_list(data, len, &descriptors, &count);

    if (result != CHANNEL_RC_OK || !descriptors || count == 0) {
        fprintf(stderr, "[conduit-freerdp] CLIPRDR FILE: Failed to parse FGD (%u bytes)\n", len);
        if (descriptors) free(descriptors);
        LeaveCriticalSection(&s_mutex);
        return;
    }

    s_server_descriptors = descriptors;
    s_server_file_count = count;

    fprintf(stderr, "[conduit-freerdp] CLIPRDR FILE: Parsed %u file descriptors\n", count);

    /* Build JSON file list for Electron */
    cJSON *root = cJSON_CreateObject();
    cJSON *files_arr = cJSON_CreateArray();

    for (UINT32 i = 0; i < count; i++) {
        char *name = descriptor_name_to_utf8(&descriptors[i]);
        if (!name) continue;
        normalize_path_separators(name);

        UINT64 size = ((UINT64)descriptors[i].nFileSizeHigh << 32) | descriptors[i].nFileSizeLow;
        bool is_dir = (descriptors[i].dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;

        cJSON *file = cJSON_CreateObject();
        cJSON_AddStringToObject(file, "name", name);
        cJSON_AddNumberToObject(file, "size", (double)size);
        cJSON_AddBoolToObject(file, "isDir", is_dir);
        cJSON_AddItemToArray(files_arr, file);

        fprintf(stderr, "[conduit-freerdp] CLIPRDR FILE:   [%u] %s (%llu bytes%s)\n",
                i, name, (unsigned long long)size, is_dir ? ", dir" : "");
        free(name);
    }

    cJSON_AddItemToObject(root, "files", files_arr);
    char *json = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);

    LeaveCriticalSection(&s_mutex);

    if (json) {
        output_send_clipboard_file_list(json, (int)strlen(json));
        free(json);
    }
}

void cliprdr_file_request_download(const char *temp_dir) {
    if (!temp_dir) return;

    EnterCriticalSection(&s_mutex);

    if (!s_cliprdr || s_server_file_count == 0 || !s_server_descriptors) {
        LeaveCriticalSection(&s_mutex);
        fprintf(stderr, "[conduit-freerdp] CLIPRDR FILE: No files to download\n");
        return;
    }

    /* Cancel any previous download */
    free_downloads();

    s_download_temp_dir = strdup(temp_dir);
    s_download_count = (int)s_server_file_count;
    s_downloads = (DownloadEntry *)calloc((size_t)s_download_count, sizeof(DownloadEntry));
    if (!s_downloads) {
        LeaveCriticalSection(&s_mutex);
        return;
    }

    /* Build download entries with temp paths */
    for (int i = 0; i < s_download_count; i++) {
        char *name = descriptor_name_to_utf8(&s_server_descriptors[i]);
        if (!name) name = strdup("unknown");
        normalize_path_separators(name);

        sanitize_filename(name);

        s_downloads[i].file_index = i;
        s_downloads[i].stream_id = 0;
        s_downloads[i].total_size = 0;
        s_downloads[i].bytes_received = 0;
        s_downloads[i].fp = NULL;
        s_downloads[i].size_received = false;
        s_downloads[i].complete = false;

        /* Build temp path: temp_dir + separator + filename */
        size_t path_len = strlen(temp_dir) + 1 + strlen(name) + 1;
        s_downloads[i].temp_path = (char *)malloc(path_len);
        if (s_downloads[i].temp_path) {
#ifdef _WIN32
            snprintf(s_downloads[i].temp_path, path_len, "%s\\%s", temp_dir, name);
#else
            snprintf(s_downloads[i].temp_path, path_len, "%s/%s", temp_dir, name);
#endif
        }
        free(name);
    }

    s_download_current = 0;
    s_downloading = true;

    fprintf(stderr, "[conduit-freerdp] CLIPRDR FILE: Starting download of %d files to %s\n",
            s_download_count, temp_dir);

    start_next_download();
    LeaveCriticalSection(&s_mutex);
}

void cliprdr_file_set_local_files(const char *json) {
    if (!json) return;

    cJSON *root = cJSON_Parse(json);
    if (!root || !cJSON_IsArray(root)) {
        if (root) cJSON_Delete(root);
        return;
    }

    EnterCriticalSection(&s_mutex);
    free_local_files();

    int count = cJSON_GetArraySize(root);
    if (count <= 0 || count > MAX_LOCAL_FILES) {
        cJSON_Delete(root);
        LeaveCriticalSection(&s_mutex);
        return;
    }

    s_local_files = (LocalFileEntry *)calloc((size_t)count, sizeof(LocalFileEntry));
    s_local_descriptors = (FILEDESCRIPTORW *)calloc((size_t)count, sizeof(FILEDESCRIPTORW));
    if (!s_local_files || !s_local_descriptors) {
        free_local_files();
        cJSON_Delete(root);
        LeaveCriticalSection(&s_mutex);
        return;
    }

    s_local_file_count = 0;

    for (int i = 0; i < count; i++) {
        cJSON *item = cJSON_GetArrayItem(root, i);
        if (!item) continue;

        cJSON *j_path = cJSON_GetObjectItemCaseSensitive(item, "path");
        cJSON *j_name = cJSON_GetObjectItemCaseSensitive(item, "name");
        cJSON *j_size = cJSON_GetObjectItemCaseSensitive(item, "size");
        cJSON *j_isdir = cJSON_GetObjectItemCaseSensitive(item, "isDirectory");

        if (!cJSON_IsString(j_path) || !cJSON_IsString(j_name)) continue;

        LocalFileEntry *entry = &s_local_files[s_local_file_count];
        entry->path = strdup(j_path->valuestring);
        entry->name = strdup(j_name->valuestring);
        entry->size = cJSON_IsNumber(j_size) ? (UINT64)j_size->valuedouble : 0;
        entry->is_directory = cJSON_IsBool(j_isdir) ? cJSON_IsTrue(j_isdir) : false;

        /* Build FILEDESCRIPTORW */
        FILEDESCRIPTORW *desc = &s_local_descriptors[s_local_file_count];
        memset(desc, 0, sizeof(FILEDESCRIPTORW));
        desc->dwFlags = FD_ATTRIBUTES | FD_FILESIZE;

        if (entry->is_directory) {
            desc->dwFileAttributes = FILE_ATTRIBUTE_DIRECTORY;
        } else {
            desc->dwFileAttributes = FILE_ATTRIBUTE_NORMAL;
            desc->nFileSizeLow = (UINT32)(entry->size & 0xFFFFFFFF);
            desc->nFileSizeHigh = (UINT32)(entry->size >> 32);
        }

        /* Convert name to UTF-16LE for cFileName.
         * FILEDESCRIPTORW requires backslash separators for nested paths
         * (e.g. "MyFolder\file.txt"). Mac sends forward slashes. */
        size_t wchar_count = 0;
        WCHAR *wname = ConvertUtf8NToWCharAlloc(entry->name,
                                                 strlen(entry->name), &wchar_count);
        if (wname && wchar_count > 0) {
            size_t copy_len = wchar_count < 259 ? wchar_count : 259;
            memcpy(desc->cFileName, wname, copy_len * sizeof(WCHAR));
            desc->cFileName[copy_len] = 0;
            /* Normalize forward slashes → backslashes for Windows */
            for (size_t j = 0; j < copy_len; j++) {
                if (desc->cFileName[j] == L'/') desc->cFileName[j] = L'\\';
            }
            free(wname);
        }

        fprintf(stderr, "[conduit-freerdp] CLIPRDR FILE: Local file [%d] %s → %s (%llu bytes%s)\n",
                s_local_file_count, entry->path, entry->name,
                (unsigned long long)entry->size, entry->is_directory ? ", dir" : "");

        s_local_file_count++;
    }

    cJSON_Delete(root);

    fprintf(stderr, "[conduit-freerdp] CLIPRDR FILE: %d local files staged\n", s_local_file_count);

    LeaveCriticalSection(&s_mutex);
}

bool cliprdr_file_has_local_files(void) {
    bool result;
    EnterCriticalSection(&s_mutex);
    result = s_local_file_count > 0;
    LeaveCriticalSection(&s_mutex);
    return result;
}

void cliprdr_file_clear_local_files(void) {
    EnterCriticalSection(&s_mutex);
    free_local_files();
    LeaveCriticalSection(&s_mutex);
}

UINT32 cliprdr_file_get_fgd_format_id(void) {
    UINT32 id;
    EnterCriticalSection(&s_mutex);
    id = s_fgd_format_id;
    LeaveCriticalSection(&s_mutex);
    return id;
}

void cliprdr_file_set_fgd_format_id(UINT32 format_id) {
    EnterCriticalSection(&s_mutex);
    s_fgd_format_id = format_id;
    LeaveCriticalSection(&s_mutex);
}

UINT cliprdr_file_handle_fgd_request(CliprdrClientContext *cliprdr) {
    CLIPRDR_FORMAT_DATA_RESPONSE response;
    memset(&response, 0, sizeof(response));

    EnterCriticalSection(&s_mutex);

    if (!s_local_descriptors || s_local_file_count <= 0) {
        LeaveCriticalSection(&s_mutex);
        response.common.msgFlags = CB_RESPONSE_FAIL;
        response.common.dataLen = 0;
        response.requestedFormatData = NULL;
        return cliprdr->ClientFormatDataResponse(cliprdr, &response);
    }

    BYTE *data = NULL;
    UINT32 data_len = 0;
    UINT result = cliprdr_serialize_file_list(s_local_descriptors,
                                              (UINT32)s_local_file_count,
                                              &data, &data_len);

    LeaveCriticalSection(&s_mutex);

    if (result != CHANNEL_RC_OK || !data) {
        fprintf(stderr, "[conduit-freerdp] CLIPRDR FILE: Failed to serialize file list\n");
        response.common.msgFlags = CB_RESPONSE_FAIL;
        response.common.dataLen = 0;
        response.requestedFormatData = NULL;
        return cliprdr->ClientFormatDataResponse(cliprdr, &response);
    }

    response.common.msgFlags = CB_RESPONSE_OK;
    response.common.dataLen = data_len;
    response.requestedFormatData = data;

    fprintf(stderr, "[conduit-freerdp] CLIPRDR FILE: Sending FGD response (%u bytes, %d files)\n",
            data_len, s_local_file_count);

    UINT ret = cliprdr->ClientFormatDataResponse(cliprdr, &response);
    free(data);
    return ret;
}
