/**
 * input.c — Route mouse/keyboard commands to FreeRDP input API.
 *
 * Thread safety: input functions are called from the stdin command thread
 * while the FreeRDP event loop runs on a background thread processing
 * clipboard channel callbacks and frame updates. A mutex serializes all
 * FreeRDP input API calls to prevent transport corruption.
 */

#include "input.h"
#include <freerdp/input.h>
#include <winpr/synch.h>

static CRITICAL_SECTION s_input_mutex;
static bool s_input_mutex_inited = false;

void input_init(void) {
    if (!s_input_mutex_inited) {
        InitializeCriticalSection(&s_input_mutex);
        s_input_mutex_inited = true;
    }
}

void input_mouse_move(freerdp *instance, int x, int y) {
    if (!instance || !instance->context || !instance->context->input) return;
    EnterCriticalSection(&s_input_mutex);
    freerdp_input_send_mouse_event(instance->context->input,
                                   PTR_FLAGS_MOVE,
                                   (UINT16)x, (UINT16)y);
    LeaveCriticalSection(&s_input_mutex);
}

void input_mouse_button_down(freerdp *instance, int x, int y, int button) {
    if (!instance || !instance->context || !instance->context->input) return;

    UINT16 flags = PTR_FLAGS_DOWN;
    switch (button) {
        case 0: flags |= PTR_FLAGS_BUTTON1; break; /* left */
        case 1: flags |= PTR_FLAGS_BUTTON3; break; /* middle */
        case 2: flags |= PTR_FLAGS_BUTTON2; break; /* right */
        default: flags |= PTR_FLAGS_BUTTON1; break;
    }

    EnterCriticalSection(&s_input_mutex);
    freerdp_input_send_mouse_event(instance->context->input,
                                   flags, (UINT16)x, (UINT16)y);
    LeaveCriticalSection(&s_input_mutex);
}

void input_mouse_button_up(freerdp *instance, int x, int y, int button) {
    if (!instance || !instance->context || !instance->context->input) return;

    /* Button up: same flags but WITHOUT PTR_FLAGS_DOWN */
    UINT16 flags = 0;
    switch (button) {
        case 0: flags = PTR_FLAGS_BUTTON1; break;
        case 1: flags = PTR_FLAGS_BUTTON3; break;
        case 2: flags = PTR_FLAGS_BUTTON2; break;
        default: flags = PTR_FLAGS_BUTTON1; break;
    }

    EnterCriticalSection(&s_input_mutex);
    freerdp_input_send_mouse_event(instance->context->input,
                                   flags, (UINT16)x, (UINT16)y);
    LeaveCriticalSection(&s_input_mutex);
}

void input_mouse_scroll(freerdp *instance, int x, int y, int delta, bool vertical) {
    if (!instance || !instance->context || !instance->context->input) return;

    UINT16 flags = vertical ? PTR_FLAGS_WHEEL : PTR_FLAGS_HWHEEL;

    /* FreeRDP wheel values: positive = scroll up/left, negative = scroll down/right
     * The value is 7 bits (0-0x78), with bit 8 (0x100) as the negative flag.
     * Standard wheel notch = 120 units in Windows, scaled to FreeRDP's 0x78.
     */
    int abs_delta = delta < 0 ? -delta : delta;
    /* Clamp to maximum wheel value */
    if (abs_delta > 0x78) abs_delta = 0x78;

    flags |= (UINT16)(abs_delta & 0xFF);
    if (delta < 0) {
        flags |= PTR_FLAGS_WHEEL_NEGATIVE;
    }

    EnterCriticalSection(&s_input_mutex);
    freerdp_input_send_mouse_event(instance->context->input,
                                   flags, (UINT16)x, (UINT16)y);
    LeaveCriticalSection(&s_input_mutex);
}

void input_key_down(freerdp *instance, int scancode, bool extended) {
    if (!instance || !instance->context || !instance->context->input) return;

    UINT16 flags = KBD_FLAGS_DOWN;
    if (extended) flags |= KBD_FLAGS_EXTENDED;

    EnterCriticalSection(&s_input_mutex);
    freerdp_input_send_keyboard_event(instance->context->input,
                                      flags, (UINT8)scancode);
    LeaveCriticalSection(&s_input_mutex);
}

void input_key_up(freerdp *instance, int scancode, bool extended) {
    if (!instance || !instance->context || !instance->context->input) return;

    UINT16 flags = KBD_FLAGS_RELEASE;
    if (extended) flags |= KBD_FLAGS_EXTENDED;

    EnterCriticalSection(&s_input_mutex);
    freerdp_input_send_keyboard_event(instance->context->input,
                                      flags, (UINT8)scancode);
    LeaveCriticalSection(&s_input_mutex);
}
