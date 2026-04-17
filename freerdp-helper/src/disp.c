/**
 * disp.c — RDPEDISP display control channel implementation.
 *
 * Handles the Display Control Virtual Channel to dynamically resize the
 * remote desktop without reconnecting. The server responds with a GFX
 * pipeline reset, which FreeRDP handles internally via cb_desktop_resize.
 *
 * Thread safety: disp_request_resize() is called from the stdin command
 * thread, while disp_check_pending() and the caps callback run on the
 * event loop thread. All shared state is protected by a mutex.
 */

#include "disp.h"
#include <freerdp/channels/disp.h>
#include <stdio.h>
#include <stdbool.h>
#include <string.h>

#include <winpr/synch.h>
#include <winpr/sysinfo.h>

/* Rate limit: minimum 200ms between resize PDUs */
#define DISP_RATE_LIMIT_MS 200

/* Dimension limits (MS-RDPEDISP spec) */
#define DISP_MIN_SIZE 200
#define DISP_MAX_SIZE 8192

/* Module state — protected by mutex */
static CRITICAL_SECTION s_mutex;
static bool s_mutex_inited = false;
static DispClientContext *s_disp = NULL;
static bool s_activated = false;

/* Rate limiting state */
static UINT64 s_last_send_ms = 0;
static bool s_pending = false;
static int s_pending_w = 0;
static int s_pending_h = 0;
static int s_pending_desktop_sf = 100;
static int s_pending_device_sf = 100;

/* Initial layout — sent when DISP channel first activates to trigger
 * server-side DPI scaling (Windows 10 1803+ / Server 2019+) */
static bool s_initial_set = false;
static int s_initial_w = 0;
static int s_initial_h = 0;
static int s_initial_desktop_sf = 100;
static int s_initial_device_sf = 100;

/* ── Helpers ─────────────────────────────────────────────────────────── */

/** Clamp value to [min, max] and round down to even. */
static int clamp_even(int val, int min_val, int max_val) {
    if (val < min_val) val = min_val;
    if (val > max_val) val = max_val;
    return val & ~1; /* Round down to even */
}

/** Get current time in milliseconds (monotonic). */
static UINT64 now_ms(void) {
    return GetTickCount64();
}

/**
 * Send a monitor layout PDU. Must be called with mutex held.
 * Returns true on success.
 */
static bool send_resize_locked(int width, int height, int desktop_sf, int device_sf) {
    if (!s_disp || !s_activated)
        return false;

    DISPLAY_CONTROL_MONITOR_LAYOUT layout;
    memset(&layout, 0, sizeof(layout));

    layout.Flags = DISPLAY_CONTROL_MONITOR_PRIMARY;
    layout.Left = 0;
    layout.Top = 0;
    layout.Width = (UINT32)width;
    layout.Height = (UINT32)height;
    layout.PhysicalWidth = 0;
    layout.PhysicalHeight = 0;
    layout.Orientation = ORIENTATION_LANDSCAPE;
    layout.DesktopScaleFactor = (UINT32)desktop_sf;
    layout.DeviceScaleFactor = (UINT32)device_sf;

    UINT ret = s_disp->SendMonitorLayout(s_disp, 1, &layout);
    if (ret != CHANNEL_RC_OK) {
        fprintf(stderr, "[conduit-freerdp] DISP SendMonitorLayout failed: 0x%08X\n", ret);
        return false;
    }

    s_last_send_ms = GetTickCount64();
    fprintf(stderr, "[conduit-freerdp] Sent DISP resize: %dx%d (desktopSF=%d deviceSF=%d)\n",
            width, height, desktop_sf, device_sf);
    return true;
}

/* ── Caps callback ───────────────────────────────────────────────────── */

static UINT cb_disp_caps(DispClientContext *disp, UINT32 maxNumMonitors,
                         UINT32 maxMonitorAreaFactorA, UINT32 maxMonitorAreaFactorB) {
    (void)maxNumMonitors;
    (void)maxMonitorAreaFactorA;
    (void)maxMonitorAreaFactorB;
    (void)disp;

    EnterCriticalSection(&s_mutex);
    s_activated = true;

    /* Drain pending resize queued before DISP activated */
    if (s_pending) {
        int w = s_pending_w;
        int h = s_pending_h;
        int dsf = s_pending_desktop_sf;
        int dvsf = s_pending_device_sf;
        s_pending = false;
        send_resize_locked(w, h, dsf, dvsf);
    } else if (s_initial_set) {
        /* Send initial layout with DPI scale factors to trigger
         * server-side display scaling on Windows 10 1803+/Server 2019+ */
        fprintf(stderr, "[conduit-freerdp] Sending initial DISP layout: %dx%d (desktopSF=%d deviceSF=%d)\n",
                s_initial_w, s_initial_h, s_initial_desktop_sf, s_initial_device_sf);
        send_resize_locked(s_initial_w, s_initial_h, s_initial_desktop_sf, s_initial_device_sf);
    }
    s_initial_set = false;
    LeaveCriticalSection(&s_mutex);

    fprintf(stderr, "[conduit-freerdp] DISP caps received: maxMonitors=%u, areaFactors=%ux%u\n",
            maxNumMonitors, maxMonitorAreaFactorA, maxMonitorAreaFactorB);

    return CHANNEL_RC_OK;
}

/* ── Public API ──────────────────────────────────────────────────────── */

void disp_init(void) {
    if (!s_mutex_inited) {
        InitializeCriticalSection(&s_mutex);
        s_mutex_inited = true;
    }
    EnterCriticalSection(&s_mutex);
    s_disp = NULL;
    s_activated = false;
    s_pending = false;
    s_pending_w = 0;
    s_pending_h = 0;
    s_pending_desktop_sf = 100;
    s_pending_device_sf = 100;
    s_last_send_ms = 0;
    s_initial_set = false;
    s_initial_w = 0;
    s_initial_h = 0;
    s_initial_desktop_sf = 100;
    s_initial_device_sf = 100;
    LeaveCriticalSection(&s_mutex);
}

void disp_channel_connected(DispClientContext *disp) {
    EnterCriticalSection(&s_mutex);
    s_disp = disp;
    s_activated = false; /* Wait for caps PDU */
    disp->DisplayControlCaps = cb_disp_caps;
    LeaveCriticalSection(&s_mutex);

    fprintf(stderr, "[conduit-freerdp] DISP channel connected\n");
}

void disp_channel_disconnected(void) {
    EnterCriticalSection(&s_mutex);
    s_disp = NULL;
    s_activated = false;
    /* Preserve s_pending so queued resizes survive DISP channel reconnections */
    LeaveCriticalSection(&s_mutex);

    fprintf(stderr, "[conduit-freerdp] DISP channel disconnected\n");
}

void disp_set_initial_layout(int width, int height, int desktop_scale_factor, int device_scale_factor) {
    if (!s_mutex_inited) return;

    EnterCriticalSection(&s_mutex);
    s_initial_w = clamp_even(width, DISP_MIN_SIZE, DISP_MAX_SIZE);
    s_initial_h = clamp_even(height, DISP_MIN_SIZE, DISP_MAX_SIZE);
    s_initial_desktop_sf = desktop_scale_factor;
    s_initial_device_sf = device_scale_factor;
    s_initial_set = true;
    LeaveCriticalSection(&s_mutex);

    fprintf(stderr, "[conduit-freerdp] Initial layout stored: %dx%d (desktopSF=%d deviceSF=%d)\n",
            s_initial_w, s_initial_h, s_initial_desktop_sf, s_initial_device_sf);
}

void disp_request_resize(int width, int height, int desktop_scale_factor, int device_scale_factor) {
    width = clamp_even(width, DISP_MIN_SIZE, DISP_MAX_SIZE);
    height = clamp_even(height, DISP_MIN_SIZE, DISP_MAX_SIZE);

    fprintf(stderr, "[conduit-freerdp] disp_request_resize(%dx%d desktopSF=%d deviceSF=%d)\n",
            width, height, desktop_scale_factor, device_scale_factor);

    EnterCriticalSection(&s_mutex);

    if (!s_disp || !s_activated) {
        /* Queue instead of dropping — will be sent when DISP activates */
        s_pending = true;
        s_pending_w = width;
        s_pending_h = height;
        s_pending_desktop_sf = desktop_scale_factor;
        s_pending_device_sf = device_scale_factor;
        LeaveCriticalSection(&s_mutex);
        return;
    }

    UINT64 elapsed = now_ms() - s_last_send_ms;
    if (elapsed < DISP_RATE_LIMIT_MS) {
        /* Within cooldown — store as pending */
        s_pending = true;
        s_pending_w = width;
        s_pending_h = height;
        s_pending_desktop_sf = desktop_scale_factor;
        s_pending_device_sf = device_scale_factor;
        LeaveCriticalSection(&s_mutex);
        return;
    }

    send_resize_locked(width, height, desktop_scale_factor, device_scale_factor);
    s_pending = false;
    LeaveCriticalSection(&s_mutex);
}

void disp_check_pending(void) {
    EnterCriticalSection(&s_mutex);

    if (!s_pending || !s_disp || !s_activated) {
        LeaveCriticalSection(&s_mutex);
        return;
    }

    UINT64 elapsed = now_ms() - s_last_send_ms;
    if (elapsed < DISP_RATE_LIMIT_MS) {
        LeaveCriticalSection(&s_mutex);
        return;
    }

    int w = s_pending_w;
    int h = s_pending_h;
    int dsf = s_pending_desktop_sf;
    int dvsf = s_pending_device_sf;
    s_pending = false;

    send_resize_locked(w, h, dsf, dvsf);
    LeaveCriticalSection(&s_mutex);
}
