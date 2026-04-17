/**
 * connection.c — FreeRDP connection management.
 *
 * Handles the full RDP lifecycle:
 *   1. Create freerdp instance + configure settings
 *   2. PreConnect: set up GDI
 *   3. PostConnect: extract desktop dimensions, send CONNECTED, init GFX
 *   4. EndPaint: extract dirty rects, convert BGRX→RGBA, send BITMAP_UPDATE
 *   5. PostDisconnect: cleanup
 */

#include "connection.h"
#include "cliprdr.h"
#include "disp.h"
#include "output.h"
#include "pointer.h"
#include <freerdp/freerdp.h>
#include <freerdp/gdi/gdi.h>
#include <freerdp/gdi/gfx.h>
#include <freerdp/codec/color.h>
#include <freerdp/settings.h>
#include <freerdp/input.h>
#include <freerdp/addin.h>
#include <freerdp/event.h>
#include <freerdp/client.h>
#include <freerdp/client/cmdline.h>
#include <freerdp/client/channels.h>
#include <freerdp/channels/rdpgfx.h>
#include <freerdp/channels/disp.h>
#include <freerdp/channels/cliprdr.h>
#include <winpr/synch.h>
#include <winpr/thread.h>
#include <winpr/wlog.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

/* ── Certificate callbacks (always accept — headless, no user prompt) ── */

static DWORD cb_verify_certificate(freerdp *instance, const char *host, UINT16 port,
                                    const char *common_name, const char *subject,
                                    const char *issuer, const char *fingerprint, DWORD flags) {
    (void)instance; (void)host; (void)port; (void)common_name;
    (void)subject; (void)issuer; (void)fingerprint; (void)flags;
    return 1; /* Accept temporarily (for this session) */
}

static DWORD cb_verify_changed_certificate(freerdp *instance, const char *host, UINT16 port,
                                            const char *common_name, const char *subject,
                                            const char *issuer, const char *new_fingerprint,
                                            const char *old_subject, const char *old_issuer,
                                            const char *old_fingerprint, DWORD flags) {
    (void)instance; (void)host; (void)port; (void)common_name;
    (void)subject; (void)issuer; (void)new_fingerprint;
    (void)old_subject; (void)old_issuer; (void)old_fingerprint; (void)flags;
    return 1;
}

/* ── Forward declarations ──────────────────────────────────────────── */

static BOOL cb_begin_paint(rdpContext *context);
static BOOL cb_end_paint(rdpContext *context);
static BOOL cb_desktop_resize(rdpContext *context);

/* ── Post-resize frame tracking ───────────────────────────────────── */
static volatile int s_end_paint_count = 0;
static volatile int s_resize_gen = 0;        /* incremented on each resize */
static volatile int s_post_resize_frames = 0; /* frames received after last resize */

/* ── Channel event handlers (GFX pipeline init) ────────────────────── */

static void cb_channel_connected(void *context, const ChannelConnectedEventArgs *e) {
    rdpContext *ctx = (rdpContext *)context;

    if (strcmp(e->name, RDPGFX_DVC_CHANNEL_NAME) == 0) {
        fprintf(stderr, "[conduit-freerdp] GFX pipeline channel connected\n");
        if (ctx->gdi) {
            gdi_graphics_pipeline_init(ctx->gdi, (RdpgfxClientContext *)e->pInterface);
        }
    } else if (strcmp(e->name, DISP_DVC_CHANNEL_NAME) == 0) {
        disp_channel_connected((DispClientContext *)e->pInterface);
    } else if (strcmp(e->name, CLIPRDR_SVC_CHANNEL_NAME) == 0) {
        cliprdr_channel_connected((CliprdrClientContext *)e->pInterface);
    }
}

static void cb_channel_disconnected(void *context, const ChannelDisconnectedEventArgs *e) {
    rdpContext *ctx = (rdpContext *)context;

    if (strcmp(e->name, RDPGFX_DVC_CHANNEL_NAME) == 0) {
        fprintf(stderr, "[conduit-freerdp] GFX pipeline channel disconnected\n");
        if (ctx->gdi) {
            gdi_graphics_pipeline_uninit(ctx->gdi, (RdpgfxClientContext *)e->pInterface);
        }
    } else if (strcmp(e->name, DISP_DVC_CHANNEL_NAME) == 0) {
        disp_channel_disconnected();
    } else if (strcmp(e->name, CLIPRDR_SVC_CHANNEL_NAME) == 0) {
        cliprdr_channel_disconnected();
    }
}

/* ── Callbacks ──────────────────────────────────────────────────────── */

static BOOL cb_pre_connect(freerdp *instance) {
    if (!instance || !instance->context) return FALSE;

    rdpSettings *settings = instance->context->settings;
    if (!settings) return FALSE;

    freerdp_settings_set_bool(settings, FreeRDP_SoftwareGdi, TRUE);

    /* NOTE: Do NOT call freerdp_client_load_channels() here.
     * freerdp_connect_begin() calls utils_reload_channels() AFTER PreConnect,
     * which destroys all channels and reloads via instance->LoadChannels callback.
     * Any channels loaded here would be immediately wiped. */

    return TRUE;
}

static BOOL cb_post_connect(freerdp *instance) {
    if (!instance || !instance->context) return FALSE;

    rdpSettings *settings = instance->context->settings;

    /* Send CONNECTED before gdi_init — gdi_init may trigger paint callbacks
     * which would write bitmap data before the CONNECTED header. */
    UINT32 w = freerdp_settings_get_uint32(settings, FreeRDP_DesktopWidth);
    UINT32 h = freerdp_settings_get_uint32(settings, FreeRDP_DesktopHeight);
    output_send_connected((int)w, (int)h);
    fprintf(stderr, "[conduit-freerdp] Connected: %ux%u\n", w, h);

    /* Initialize GDI with BGRX32 — FreeRDP's proven default format */
    if (!gdi_init(instance, PIXEL_FORMAT_BGRX32)) {
        fprintf(stderr, "[conduit-freerdp] gdi_init failed\n");
        return FALSE;
    }

    /* Register pointer callbacks (must be after gdi_init) */
    pointer_register(instance->context->graphics);

    /* Register update callbacks after gdi_init() */
    instance->context->update->BeginPaint = cb_begin_paint;
    instance->context->update->EndPaint = cb_end_paint;
    instance->context->update->DesktopResize = cb_desktop_resize;

    /* Subscribe to channel events for GFX pipeline initialization.
     * freerdp_channels_post_connect() is called AFTER this callback returns,
     * so subscribing here catches all channel connect events. */
    PubSub_SubscribeChannelConnected(instance->context->pubSub, cb_channel_connected);
    PubSub_SubscribeChannelDisconnected(instance->context->pubSub, cb_channel_disconnected);

    return TRUE;
}

static BOOL cb_begin_paint(rdpContext *context) {
    if (!context || !context->gdi || !context->gdi->primary)
        return TRUE;

    rdpGdi *gdi = context->gdi;
    HGDI_WND hwnd = gdi->primary->hdc->hwnd;

    /* Reset invalid region */
    hwnd->invalid->null = TRUE;
    hwnd->ninvalid = 0;

    return TRUE;
}

static BOOL cb_end_paint(rdpContext *context) {
    if (!context || !context->gdi || !context->gdi->primary ||
        !context->gdi->primary_buffer)
        return TRUE;

    rdpGdi *gdi = context->gdi;
    HGDI_WND hwnd = gdi->primary->hdc->hwnd;

    /* Skip if nothing changed */
    if (hwnd->invalid->null)
        return TRUE;

    INT32 x = hwnd->invalid->x;
    INT32 y = hwnd->invalid->y;
    INT32 w = hwnd->invalid->w;
    INT32 h = hwnd->invalid->h;

    /* Use GDI dimensions (not settings) — during gdi_resize_ex, settings
     * already have new dimensions but the buffer is still at old size.
     * gdi->width/height always match the actual primary_buffer layout. */
    INT32 dw = gdi->width;
    INT32 dh = gdi->height;

    if (dw <= 0 || dh <= 0) return TRUE;

    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    if (x + w > dw) w = dw - x;
    if (y + h > dh) h = dh - y;
    if (w <= 0 || h <= 0) return TRUE;

    /* Extract dirty region from primary buffer and convert BGRX→RGBA */
    BYTE *primary_buffer = gdi->primary_buffer;
    int stride = gdi->stride; /* Use GDI stride (matches buffer layout) */
    size_t row_bytes = (size_t)w * 4;
    size_t rgba_size = row_bytes * (size_t)h;

    uint8_t *rgba = (uint8_t *)malloc(rgba_size);
    if (!rgba) return TRUE;

    for (int row = 0; row < h; row++) {
        const uint8_t *src = primary_buffer + (y + row) * stride + x * 4;
        uint8_t *dst = rgba + row * row_bytes;
        for (int col = 0; col < w; col++) {
            dst[0] = src[2]; /* R ← B */
            dst[1] = src[1]; /* G ← G */
            dst[2] = src[0]; /* B ← R */
            dst[3] = 255;    /* A     */
            src += 4;
            dst += 4;
        }
    }

    output_send_bitmap((uint16_t)x, (uint16_t)y,
                       (uint16_t)w, (uint16_t)h,
                       rgba, rgba_size);
    free(rgba);

    s_end_paint_count++;
    s_post_resize_frames++;

    /* Log first frame after each resize — confirms GFX pipeline is alive */
    if (s_post_resize_frames == 1) {
        fprintf(stderr, "[conduit-freerdp] First post-resize frame: rect=(%d,%d %dx%d) gdi=%dx%d\n",
                x, y, w, h, gdi->width, gdi->height);
    }

    return TRUE;
}

static BOOL cb_desktop_resize(rdpContext *context) {
    if (!context || !context->gdi) return TRUE;

    rdpSettings *settings = context->settings;
    UINT32 w = freerdp_settings_get_uint32(settings, FreeRDP_DesktopWidth);
    UINT32 h = freerdp_settings_get_uint32(settings, FreeRDP_DesktopHeight);

    rdpGdi *gdi = context->gdi;
    fprintf(stderr, "[conduit-freerdp] Desktop resize: %ux%u (gdi: %dx%d stride=%d buf=%p)\n",
            w, h, gdi->width, gdi->height, gdi->stride, (void*)gdi->primary_buffer);

    /* gdi_ResetGraphics calls us BEFORE it clears surfaces and resets codecs.
     * We must call gdi_resize to allocate a new primary buffer at the new size. */
    if (gdi->width != (INT32)w || gdi->height != (INT32)h) {
        BOOL ok = gdi_resize(gdi, w, h);
        fprintf(stderr, "[conduit-freerdp] gdi_resize(%ux%u) → %s (gdi now: %dx%d stride=%d buf=%p)\n",
                w, h, ok ? "OK" : "FAIL",
                gdi->width, gdi->height, gdi->stride, (void*)gdi->primary_buffer);
        if (!ok) {
            /* Don't return FALSE — it kills the entire session.
             * CSS scaling in the frontend handles dimension mismatches. */
        }
    } else {
        fprintf(stderr, "[conduit-freerdp] GDI already at target dimensions, skip resize\n");
    }

    /* Reset post-resize frame counter */
    s_resize_gen++;
    s_post_resize_frames = 0;

    /* Notify Electron of dimensions */
    output_send_resized((int)w, (int)h);
    return TRUE;
}

static void cb_post_disconnect(freerdp *instance) {
    if (!instance || !instance->context) return;

    PubSub_UnsubscribeChannelConnected(instance->context->pubSub, cb_channel_connected);
    PubSub_UnsubscribeChannelDisconnected(instance->context->pubSub, cb_channel_disconnected);

    gdi_free(instance);
    fprintf(stderr, "[conduit-freerdp] Disconnected\n");
}

/* ── Public API ─────────────────────────────────────────────────────── */

freerdp *connection_init(const ConnectConfig *config) {
    /* Show RDPDR/channel activity at DEBUG level, errors for everything else */
    wLog *root = WLog_GetRoot();
    WLog_SetLogLevel(root, WLOG_WARN);
    wLog *rdpdr_log = WLog_Get("com.freerdp.channels.rdpdr");
    if (rdpdr_log) WLog_SetLogLevel(rdpdr_log, WLOG_DEBUG);
    wLog *chan_log = WLog_Get("com.freerdp.client.common");
    if (chan_log) WLog_SetLogLevel(chan_log, WLOG_DEBUG);

    freerdp *instance = freerdp_new();
    if (!instance) {
        fprintf(stderr, "[conduit-freerdp] freerdp_new() failed\n");
        return NULL;
    }

    /* Set callbacks */
    instance->PreConnect = cb_pre_connect;
    instance->PostConnect = cb_post_connect;
    instance->PostDisconnect = cb_post_disconnect;
    instance->VerifyCertificateEx = cb_verify_certificate;
    instance->VerifyChangedCertificateEx = cb_verify_changed_certificate;

    /* Allocate context */
    if (!freerdp_context_new(instance)) {
        fprintf(stderr, "[conduit-freerdp] freerdp_context_new() failed\n");
        freerdp_free(instance);
        return NULL;
    }

    /* Register static channel addin provider so freerdp_client_load_channels()
     * can find builtin channels (RDPDR, etc.) in CLIENT_STATIC_ADDIN_TABLE
     * instead of trying to dlopen plugin .dylib files. This is normally done
     * by freerdp_client_context_new(), but we use the simpler freerdp_context_new(). */
    freerdp_register_addin_provider(freerdp_channels_load_static_addin_entry, 0);

    /* Set the LoadChannels callback. freerdp_connect_begin() calls
     * utils_reload_channels() AFTER PreConnect, which destroys any existing
     * channels and reloads them via this callback. Without it, channels
     * (RDPDR, rdpsnd) are never loaded into the connection. */
    instance->LoadChannels = freerdp_client_load_channels;

    rdpSettings *settings = instance->context->settings;

    /* ── Connection ── */
    freerdp_settings_set_string(settings, FreeRDP_ServerHostname, config->host);
    freerdp_settings_set_uint32(settings, FreeRDP_ServerPort, (UINT32)config->port);
    freerdp_settings_set_string(settings, FreeRDP_Username, config->username);
    freerdp_settings_set_string(settings, FreeRDP_Password, config->password);
    if (config->domain && config->domain[0]) {
        freerdp_settings_set_string(settings, FreeRDP_Domain, config->domain);
    }
    freerdp_settings_set_uint32(settings, FreeRDP_DesktopWidth, (UINT32)config->width);
    freerdp_settings_set_uint32(settings, FreeRDP_DesktopHeight, (UINT32)config->height);
    freerdp_settings_set_uint32(settings, FreeRDP_ColorDepth, 32);

    /* ── High DPI / Retina scale factors ── */
    if (config->desktop_scale_factor > 100) {
        freerdp_settings_set_uint32(settings, FreeRDP_DesktopScaleFactor, (UINT32)config->desktop_scale_factor);
        fprintf(stderr, "[conduit-freerdp] DesktopScaleFactor=%d\n", config->desktop_scale_factor);
    }
    if (config->device_scale_factor > 0 && config->device_scale_factor != 100) {
        freerdp_settings_set_uint32(settings, FreeRDP_DeviceScaleFactor, (UINT32)config->device_scale_factor);
        fprintf(stderr, "[conduit-freerdp] DeviceScaleFactor=%d\n", config->device_scale_factor);
    }

    /* ── Security ── */
    freerdp_settings_set_bool(settings, FreeRDP_NlaSecurity, config->enable_nla);
    freerdp_settings_set_bool(settings, FreeRDP_TlsSecurity, TRUE);
    freerdp_settings_set_bool(settings, FreeRDP_RdpSecurity, TRUE);
    if (config->skip_cert_verification) {
        freerdp_settings_set_bool(settings, FreeRDP_IgnoreCertificate, TRUE);
    }

    /* ── Network ── */
    freerdp_settings_set_bool(settings, FreeRDP_NetworkAutoDetect, TRUE);

    /* ── GFX pipeline (H.264/AVC + progressive codec) ── */
    if (config->enable_gfx) {
        freerdp_settings_set_bool(settings, FreeRDP_SupportGraphicsPipeline, TRUE);
        freerdp_settings_set_bool(settings, FreeRDP_GfxThinClient, FALSE);
        freerdp_settings_set_bool(settings, FreeRDP_GfxSmallCache, TRUE);
    }
    if (config->enable_h264) {
        freerdp_settings_set_bool(settings, FreeRDP_GfxH264, TRUE);
        freerdp_settings_set_bool(settings, FreeRDP_GfxAVC444, TRUE);
    }

    /* ── Display control (RDPEDISP) — dynamic resize without reconnect ── */
    freerdp_settings_set_bool(settings, FreeRDP_SupportDisplayControl, TRUE);
    freerdp_settings_set_bool(settings, FreeRDP_DynamicResolutionUpdate, TRUE);

    /* ── Software GDI ── */
    freerdp_settings_set_bool(settings, FreeRDP_SoftwareGdi, TRUE);

    /* ── Clipboard redirection (CLIPRDR) ── */
    if (config->enable_clipboard) {
        freerdp_settings_set_bool(settings, FreeRDP_RedirectClipboard, TRUE);
        /* Enable all clipboard directions including file transfers */
        freerdp_settings_set_uint32(settings, FreeRDP_ClipboardFeatureMask,
            CLIPRDR_FLAG_LOCAL_TO_REMOTE | CLIPRDR_FLAG_LOCAL_TO_REMOTE_FILES |
            CLIPRDR_FLAG_REMOTE_TO_LOCAL | CLIPRDR_FLAG_REMOTE_TO_LOCAL_FILES);
        fprintf(stderr, "[conduit-freerdp] Clipboard redirection enabled (feature mask=0x%02X)\n",
            (unsigned)freerdp_settings_get_uint32(settings, FreeRDP_ClipboardFeatureMask));
    }

    /* ── Drive redirection (RDPDR) ── */
    if (config->drives && config->drive_count > 0) {
        freerdp_settings_set_bool(settings, FreeRDP_DeviceRedirection, TRUE);
        for (int i = 0; i < config->drive_count; i++) {
            const char *const params[] = { "drive", config->drives[i].name, config->drives[i].path };
            if (!freerdp_client_add_device_channel(settings, 3, params)) {
                fprintf(stderr, "[conduit-freerdp] Failed to add drive: %s -> %s\n",
                        config->drives[i].name, config->drives[i].path);
            } else {
                fprintf(stderr, "[conduit-freerdp] Added drive: %s -> %s\n",
                        config->drives[i].name, config->drives[i].path);
            }
        }
    }

    return instance;
}

bool connection_connect(freerdp *instance) {
    if (!instance) return false;

    if (!freerdp_connect(instance)) {
        UINT32 error = freerdp_get_last_error(instance->context);
        const char *error_str = freerdp_get_last_error_string(error);
        fprintf(stderr, "[conduit-freerdp] Connection failed: %s (0x%08X)\n",
                error_str ? error_str : "unknown", error);
        output_send_error(error_str ? error_str : "Connection failed");
        return false;
    }

    return true;
}

bool connection_check_events(freerdp *instance) {
    if (!instance || !instance->context) return false;

    HANDLE events[64];
    DWORD nCount = freerdp_get_event_handles(instance->context, events, 64);
    if (nCount == 0) {
        fprintf(stderr, "[conduit-freerdp] freerdp_get_event_handles failed\n");
        return false;
    }

    DWORD waitStatus = WaitForMultipleObjects(nCount, events, FALSE, 100);
    if (waitStatus == WAIT_FAILED) {
        return false;
    }

    if (!freerdp_check_event_handles(instance->context)) {
        if (freerdp_get_last_error(instance->context) == FREERDP_ERROR_SUCCESS) {
            return false; /* Clean disconnect */
        }
        UINT32 error = freerdp_get_last_error(instance->context);
        const char *error_str = freerdp_get_last_error_string(error);
        fprintf(stderr, "[conduit-freerdp] Event check failed: %s\n",
                error_str ? error_str : "unknown");
        return false;
    }

    return true;
}

void connection_free(freerdp *instance) {
    if (!instance) return;

    freerdp_disconnect(instance);
    freerdp_context_free(instance);
    freerdp_free(instance);
}

void connection_get_resize_diag(int *resize_gen, int *post_resize_frames) {
    if (resize_gen) *resize_gen = s_resize_gen;
    if (post_resize_frames) *post_resize_frames = s_post_resize_frames;
}
