/**
 * cliprdr.c — CLIPRDR clipboard redirection channel implementation.
 *
 * Handles the Clipboard Virtual Channel Extension (MS-RDPECLIP) for
 * bidirectional text clipboard sync between local and remote desktops.
 *
 * Thread safety: cliprdr_set_text() is called from the stdin command
 * thread, while all CLIPRDR callbacks run on the event loop thread.
 * All shared state is protected by a critical section.
 */

#include "cliprdr.h"
#include "cliprdr_file.h"
#include "output.h"
#ifdef _WIN32
#include "cliprdr_win32.h"
#endif
#include <freerdp/channels/cliprdr.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdbool.h>
#include <string.h>

#include <winpr/synch.h>
#include <winpr/string.h>
#include <winpr/sysinfo.h>

/* Module state — protected by mutex */
static CRITICAL_SECTION s_mutex;
static bool s_mutex_inited = false;
static CliprdrClientContext *s_cliprdr = NULL;
static bool s_ready = false;

/* Pending local clipboard text (UTF-8) */
static char *s_client_text = NULL;
static int s_client_text_len = 0;

/* Track pending FGD data request (for routing FormatDataResponse) */
static bool s_pending_fgd = false;

/* Rate limiting and backoff for FormatList sends */
static UINT64 s_last_format_list_ms = 0;
static UINT64 s_last_reject_ms = 0;
static bool s_format_list_rejected = false;

#define FORMAT_LIST_MIN_INTERVAL_MS 1000
#define REJECT_BACKOFF_MS           3000

/* ── Helpers ─────────────────────────────────────────────────────────── */

/**
 * Send a format list to the server.
 * If we have pending text, announces CF_UNICODETEXT; otherwise sends an
 * empty list (required by MS-RDPECLIP to complete the handshake).
 * Must be called with mutex held and s_cliprdr != NULL.
 */
/**
 * Send a format list to the server.
 * If bypass_limits is false, applies rate limiting and rejection backoff.
 * Must be called with mutex held.
 */
static UINT send_format_list_locked(bool bypass_limits) {
    if (!s_cliprdr) return CHANNEL_RC_OK;

    if (!bypass_limits) {
        UINT64 now = GetTickCount64();

        /* Backoff after server rejection */
        if (s_format_list_rejected && (now - s_last_reject_ms) < REJECT_BACKOFF_MS) {
            fprintf(stderr, "[conduit-freerdp] CLIPRDR: Backing off after rejection (%llums ago)\n",
                    (unsigned long long)(now - s_last_reject_ms));
            return CHANNEL_RC_OK;
        }

        /* Rate limit */
        if (s_last_format_list_ms > 0 && (now - s_last_format_list_ms) < FORMAT_LIST_MIN_INTERVAL_MS) {
            fprintf(stderr, "[conduit-freerdp] CLIPRDR: Rate-limited (%llums since last)\n",
                    (unsigned long long)(now - s_last_format_list_ms));
            return CHANNEL_RC_OK;
        }
    }

    CLIPRDR_FORMAT_LIST formatList;
    CLIPRDR_FORMAT formats[2];

    memset(&formatList, 0, sizeof(formatList));
    memset(&formats, 0, sizeof(formats));

    int nFormats = 0;

    /* Check if we have local files to announce */
    if (cliprdr_file_has_local_files()) {
        /* For registered formats, formatId is a client-chosen opaque ID.
         * The server matches by formatName, not ID. If we previously received
         * the server's format ID, reuse it; otherwise use a fixed value. */
        UINT32 fgd_id = cliprdr_file_get_fgd_format_id();
        if (fgd_id == 0) fgd_id = 0xC0BC;
        /* Store the ID so cb_server_format_data_request can match it */
        cliprdr_file_set_fgd_format_id(fgd_id);
        formats[nFormats].formatId = fgd_id;
        formats[nFormats].formatName = "FileGroupDescriptorW";
        nFormats++;
        fprintf(stderr, "[conduit-freerdp] CLIPRDR: Announcing FileGroupDescriptorW (format=%u)\n", fgd_id);
    } else {
        /* Always announce CF_UNICODETEXT — even if we have no text yet.
         * Some servers reject empty format lists. If the server requests
         * data we'll respond with failure (which is protocol-legal). */
        formats[nFormats].formatId = CF_UNICODETEXT;
        formats[nFormats].formatName = NULL;
        nFormats++;
    }

    formatList.numFormats = (UINT32)nFormats;
    formatList.formats = nFormats > 0 ? formats : NULL;

    formatList.common.msgFlags = 0;

    s_last_format_list_ms = GetTickCount64();
    s_format_list_rejected = false;

    UINT ret = s_cliprdr->ClientFormatList(s_cliprdr, &formatList);
    if (ret != CHANNEL_RC_OK) {
        fprintf(stderr, "[conduit-freerdp] CLIPRDR: ClientFormatList failed: 0x%08X\n", ret);
    }
    return ret;
}

/* ── CLIPRDR Callbacks ───────────────────────────────────────────────── */

static UINT cb_monitor_ready(CliprdrClientContext *cliprdr,
                             const CLIPRDR_MONITOR_READY *monitorReady) {
    (void)monitorReady;

    /* Send client capabilities */
    CLIPRDR_CAPABILITIES caps;
    CLIPRDR_GENERAL_CAPABILITY_SET generalCaps;

    memset(&caps, 0, sizeof(caps));
    memset(&generalCaps, 0, sizeof(generalCaps));

    generalCaps.capabilitySetType = CB_CAPSTYPE_GENERAL;
    generalCaps.capabilitySetLength = 12;
    generalCaps.version = CB_CAPS_VERSION_2;
    generalCaps.generalFlags = CB_USE_LONG_FORMAT_NAMES
                             | cliprdr_file_get_capability_flags();

    caps.cCapabilitiesSets = 1;
    caps.capabilitySets = (CLIPRDR_CAPABILITY_SET *)&generalCaps;

    UINT ret = cliprdr->ClientCapabilities(cliprdr, &caps);
    if (ret != CHANNEL_RC_OK) {
        fprintf(stderr, "[conduit-freerdp] CLIPRDR: ClientCapabilities failed: 0x%08X\n", ret);
        return ret;
    }

    EnterCriticalSection(&s_mutex);
    s_ready = true;

    /* Clear any pre-stored text from before the channel was ready.
     * Don't claim clipboard ownership during the handshake — let the
     * server send its initial FormatList first. Electron will re-sync
     * local clipboard via cliprdr_set_text() when the user focuses. */
    if (s_client_text) {
        free(s_client_text);
        s_client_text = NULL;
    }
    s_client_text_len = 0;
    s_format_list_rejected = false;
    s_last_format_list_ms = 0;
    s_pending_fgd = false;

    /* MS-RDPECLIP: client MUST send a FormatList after capabilities.
     * Announce CF_UNICODETEXT to complete handshake (empty lists may
     * be rejected by some Windows servers). */
    send_format_list_locked(true); /* bypass limits for handshake */

    LeaveCriticalSection(&s_mutex);

    fprintf(stderr, "[conduit-freerdp] CLIPRDR: MonitorReady, channel active\n");
    return CHANNEL_RC_OK;
}

static UINT cb_server_capabilities(CliprdrClientContext *cliprdr,
                                   const CLIPRDR_CAPABILITIES *capabilities) {
    (void)cliprdr;
    (void)capabilities;
    fprintf(stderr, "[conduit-freerdp] CLIPRDR: ServerCapabilities received\n");
    return CHANNEL_RC_OK;
}

static UINT cb_server_format_list(CliprdrClientContext *cliprdr,
                                  const CLIPRDR_FORMAT_LIST *formatList) {
    /* Server is actively sending format lists — clear any rejection backoff */
    EnterCriticalSection(&s_mutex);
    s_format_list_rejected = false;
    LeaveCriticalSection(&s_mutex);

    /* Log all formats the server is offering */
    fprintf(stderr, "[conduit-freerdp] CLIPRDR: Server FormatList (%u formats):\n", formatList->numFormats);
    for (UINT32 i = 0; i < formatList->numFormats; i++) {
        fprintf(stderr, "[conduit-freerdp] CLIPRDR:   [%u] id=%u name=%s\n",
                i, formatList->formats[i].formatId,
                formatList->formats[i].formatName ? formatList->formats[i].formatName : "(standard)");
    }

    /* Acknowledge the server's format list */
    CLIPRDR_FORMAT_LIST_RESPONSE response;
    memset(&response, 0, sizeof(response));
    response.common.msgFlags = CB_RESPONSE_OK;

    UINT ret = cliprdr->ClientFormatListResponse(cliprdr, &response);
    if (ret != CHANNEL_RC_OK) {
        fprintf(stderr, "[conduit-freerdp] CLIPRDR: ClientFormatListResponse failed: 0x%08X\n", ret);
        return ret;
    }

    /* Check if server offers text or files */
    bool has_unicode = false;
    bool has_text = false;
    UINT32 fgd_format_id = 0;

    for (UINT32 i = 0; i < formatList->numFormats; i++) {
        if (formatList->formats[i].formatId == CF_UNICODETEXT) {
            has_unicode = true;
        } else if (formatList->formats[i].formatId == CF_TEXT) {
            has_text = true;
        } else if (formatList->formats[i].formatName &&
                   strcmp(formatList->formats[i].formatName, "FileGroupDescriptorW") == 0) {
            fgd_format_id = formatList->formats[i].formatId;
        }
    }

    /* Files take priority over text */
    if (fgd_format_id != 0) {
        fprintf(stderr, "[conduit-freerdp] CLIPRDR: Server has files (FGD format=%u)\n", fgd_format_id);
        EnterCriticalSection(&s_mutex);
        s_pending_fgd = true;
        LeaveCriticalSection(&s_mutex);
        cliprdr_file_server_has_files(cliprdr, fgd_format_id);
        return CHANNEL_RC_OK;
    }

    if (has_unicode || has_text) {
        CLIPRDR_FORMAT_DATA_REQUEST request;
        memset(&request, 0, sizeof(request));
        request.requestedFormatId = has_unicode ? CF_UNICODETEXT : CF_TEXT;

        ret = cliprdr->ClientFormatDataRequest(cliprdr, &request);
        if (ret != CHANNEL_RC_OK) {
            fprintf(stderr, "[conduit-freerdp] CLIPRDR: ClientFormatDataRequest failed: 0x%08X\n", ret);
        } else {
            fprintf(stderr, "[conduit-freerdp] CLIPRDR: Requested format %s from server\n",
                    has_unicode ? "CF_UNICODETEXT" : "CF_TEXT");
        }
    }

    return CHANNEL_RC_OK;
}

static UINT cb_server_format_list_response(CliprdrClientContext *cliprdr,
                                           const CLIPRDR_FORMAT_LIST_RESPONSE *response) {
    (void)cliprdr;
    if (response->common.msgFlags != CB_RESPONSE_OK) {
        fprintf(stderr, "[conduit-freerdp] CLIPRDR: Server rejected our format list\n");
        EnterCriticalSection(&s_mutex);
        s_format_list_rejected = true;
        s_last_reject_ms = GetTickCount64();
        LeaveCriticalSection(&s_mutex);
    }
    return CHANNEL_RC_OK;
}

static UINT cb_server_format_data_request(CliprdrClientContext *cliprdr,
                                          const CLIPRDR_FORMAT_DATA_REQUEST *request) {
    /* Check if server is requesting FileGroupDescriptorW */
    UINT32 fgd_id = cliprdr_file_get_fgd_format_id();
    if (fgd_id != 0 && request->requestedFormatId == fgd_id) {
        fprintf(stderr, "[conduit-freerdp] CLIPRDR: Server requesting FGD data\n");
        return cliprdr_file_handle_fgd_request(cliprdr);
    }

    CLIPRDR_FORMAT_DATA_RESPONSE response;
    memset(&response, 0, sizeof(response));

    EnterCriticalSection(&s_mutex);

    if (request->requestedFormatId == CF_UNICODETEXT && s_client_text && s_client_text_len > 0) {
        /* Convert UTF-8 to UTF-16LE */
        size_t wchar_count = 0;
        WCHAR *wstr = ConvertUtf8NToWCharAlloc(s_client_text, (size_t)s_client_text_len, &wchar_count);

        if (wstr && wchar_count > 0) {
            /* Include null terminator in response */
            size_t byte_len = (wchar_count + 1) * sizeof(WCHAR);
            response.common.msgFlags = CB_RESPONSE_OK;
            response.common.dataLen = (UINT32)byte_len;
            response.requestedFormatData = (const BYTE *)wstr;

            LeaveCriticalSection(&s_mutex);
            UINT ret = cliprdr->ClientFormatDataResponse(cliprdr, &response);
            free(wstr);

            if (ret != CHANNEL_RC_OK) {
                fprintf(stderr, "[conduit-freerdp] CLIPRDR: ClientFormatDataResponse failed: 0x%08X\n", ret);
            }
            return ret;
        }

        if (wstr) free(wstr);
    }

    /* Unknown format or no data — respond with failure (protocol-legal) */
    response.common.msgFlags = CB_RESPONSE_FAIL;
    response.common.dataLen = 0;
    response.requestedFormatData = NULL;

    fprintf(stderr, "[conduit-freerdp] CLIPRDR: No data for requested format %u\n",
            request->requestedFormatId);

    LeaveCriticalSection(&s_mutex);
    return cliprdr->ClientFormatDataResponse(cliprdr, &response);
}

static UINT cb_server_format_data_response(CliprdrClientContext *cliprdr,
                                           const CLIPRDR_FORMAT_DATA_RESPONSE *response) {
    (void)cliprdr;

    if (response->common.msgFlags != CB_RESPONSE_OK) {
        fprintf(stderr, "[conduit-freerdp] CLIPRDR: Server format data response: FAIL\n");
        EnterCriticalSection(&s_mutex);
        s_pending_fgd = false;
        LeaveCriticalSection(&s_mutex);
        return CHANNEL_RC_OK;
    }

    if (!response->requestedFormatData || response->common.dataLen == 0) {
        return CHANNEL_RC_OK;
    }

    /* Check if this is an FGD response */
    EnterCriticalSection(&s_mutex);
    bool is_fgd = s_pending_fgd;
    s_pending_fgd = false;
    LeaveCriticalSection(&s_mutex);

    if (is_fgd) {
        cliprdr_file_handle_fgd_response(response->requestedFormatData,
                                          response->common.dataLen);
        return CHANNEL_RC_OK;
    }

    /* Convert UTF-16LE to UTF-8 */
    const WCHAR *wstr = (const WCHAR *)response->requestedFormatData;
    size_t wchar_count = response->common.dataLen / sizeof(WCHAR);

    /* Strip null terminator if present */
    if (wchar_count > 0 && wstr[wchar_count - 1] == 0) {
        wchar_count--;
    }

    if (wchar_count == 0) {
        return CHANNEL_RC_OK;
    }

    size_t utf8_len = 0;
    char *utf8 = ConvertWCharNToUtf8Alloc(wstr, wchar_count, &utf8_len);

    if (utf8 && utf8_len > 0) {
        fprintf(stderr, "[conduit-freerdp] CLIPRDR: Received %zu bytes of text from server\n", utf8_len);

#ifdef _WIN32
        /* Place text on native Windows clipboard directly */
        if (cliprdr_win32_is_active()) {
            cliprdr_win32_set_text(wstr, (int)wchar_count);
        }
#endif
        /* Always send to Electron too (for UI display / non-native fallback) */
        output_send_clipboard_text(utf8, (int)utf8_len);
        free(utf8);
    }

    return CHANNEL_RC_OK;
}

/* ── Public API ──────────────────────────────────────────────────────── */

void cliprdr_init(void) {
    if (!s_mutex_inited) {
        InitializeCriticalSection(&s_mutex);
        s_mutex_inited = true;
    }
    EnterCriticalSection(&s_mutex);
    s_cliprdr = NULL;
    s_ready = false;
    if (s_client_text) {
        free(s_client_text);
        s_client_text = NULL;
    }
    s_client_text_len = 0;
    s_last_format_list_ms = 0;
    s_last_reject_ms = 0;
    s_format_list_rejected = false;
    s_pending_fgd = false;
    LeaveCriticalSection(&s_mutex);
}

void cliprdr_channel_connected(CliprdrClientContext *cliprdr) {
    EnterCriticalSection(&s_mutex);
    s_cliprdr = cliprdr;
    s_ready = false;
    s_pending_fgd = false;

    /* Register callbacks */
    cliprdr->MonitorReady = cb_monitor_ready;
    cliprdr->ServerCapabilities = cb_server_capabilities;
    cliprdr->ServerFormatList = cb_server_format_list;
    cliprdr->ServerFormatListResponse = cb_server_format_list_response;
    cliprdr->ServerFormatDataRequest = cb_server_format_data_request;
    cliprdr->ServerFormatDataResponse = cb_server_format_data_response;

    LeaveCriticalSection(&s_mutex);

    /* Register file clipboard callbacks */
    cliprdr_file_channel_connected(cliprdr);

#ifdef _WIN32
    cliprdr_win32_set_ready(true);
#endif

    fprintf(stderr, "[conduit-freerdp] CLIPRDR channel connected\n");
}

void cliprdr_channel_disconnected(void) {
#ifdef _WIN32
    cliprdr_win32_set_ready(false);
#endif

    cliprdr_file_channel_disconnected();

    EnterCriticalSection(&s_mutex);
    s_cliprdr = NULL;
    s_ready = false;
    s_pending_fgd = false;
    LeaveCriticalSection(&s_mutex);

    fprintf(stderr, "[conduit-freerdp] CLIPRDR channel disconnected\n");
}

void cliprdr_announce_files(void) {
    EnterCriticalSection(&s_mutex);
    if (s_cliprdr && s_ready && cliprdr_file_has_local_files()) {
        /* Clear any pending text — files take priority */
        if (s_client_text) {
            free(s_client_text);
            s_client_text = NULL;
        }
        s_client_text_len = 0;
        /* Bypass rate limiting — this is an explicit user action */
        send_format_list_locked(true);
    }
    LeaveCriticalSection(&s_mutex);
}

void cliprdr_set_text(const char *text, int length) {
    if (!text || length <= 0) return;

    /* Check if we had files staged — need to force re-announce even if
     * the text is identical (format is switching from files→text) and
     * bypass rate limits (file announcement may have been <1s ago). */
    bool had_files = cliprdr_file_has_local_files();

    /* Clear any staged local files — clipboard is switching to text mode */
    cliprdr_file_clear_local_files();

    EnterCriticalSection(&s_mutex);

    /* Dedup: skip if identical text is already stored and announced.
     * But NOT if we just switched from file mode — the server still
     * thinks we have files and needs a CF_UNICODETEXT announcement. */
    if (!had_files && s_client_text && s_client_text_len == length &&
        memcmp(s_client_text, text, (size_t)length) == 0) {
        LeaveCriticalSection(&s_mutex);
        return;
    }

    /* Store the text */
    if (s_client_text) {
        free(s_client_text);
    }
    s_client_text = (char *)malloc((size_t)length + 1);
    if (s_client_text) {
        memcpy(s_client_text, text, (size_t)length);
        s_client_text[length] = '\0';
        s_client_text_len = length;
    } else {
        s_client_text_len = 0;
    }

    /* If channel is ready, announce format list.
     * Bypass rate limits when switching from files→text — the previous
     * FileGroupDescriptorW announcement may have been <1s ago, and we
     * MUST tell the server we now have CF_UNICODETEXT instead. */
    if (s_cliprdr && s_ready && s_client_text_len > 0) {
        send_format_list_locked(had_files);
    } else if (!s_ready) {
        fprintf(stderr, "[conduit-freerdp] CLIPRDR: Text stored, waiting for channel ready\n");
    }

    LeaveCriticalSection(&s_mutex);
}
