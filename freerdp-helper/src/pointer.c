/**
 * pointer.c — Remote cursor support via FreeRDP pointer callbacks.
 *
 * Converts server cursor shapes (monochrome, color, alpha) to RGBA using
 * freerdp_image_copy_from_pointer_data(), then sends the RGBA data through
 * the binary protocol for Electron to render as a CSS custom cursor.
 */

#include "pointer.h"
#include "output.h"
#include <freerdp/freerdp.h>
#include <freerdp/gdi/gdi.h>
#include <freerdp/codec/color.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

/**
 * Extended pointer struct — must start with rdpPointer as first field.
 * FreeRDP allocates sizeof(ConduitPointer) and casts to rdpPointer*.
 */
typedef struct {
    rdpPointer pointer;
    uint8_t *rgba_data;
    size_t rgba_size;
} ConduitPointer;

/* ── Callbacks ──────────────────────────────────────────────────────── */

static BOOL cb_pointer_new(rdpContext *context, rdpPointer *pointer) {
    if (!context || !context->gdi || !pointer) return FALSE;

    ConduitPointer *cp = (ConduitPointer *)pointer;
    UINT32 w = pointer->width;
    UINT32 h = pointer->height;

    if (w == 0 || h == 0 || w > 384 || h > 384) return FALSE;

    size_t rgba_size = (size_t)w * h * 4;
    uint8_t *rgba = (uint8_t *)calloc(1, rgba_size);
    if (!rgba) return FALSE;

    BOOL ok = freerdp_image_copy_from_pointer_data(
        rgba,                       /* pDstData */
        PIXEL_FORMAT_RGBA32,        /* DstFormat */
        0,                          /* nDstStep (0 = auto = width * bpp) */
        0, 0,                       /* nXDst, nYDst */
        w, h,                       /* nWidth, nHeight */
        pointer->xorMaskData,       /* xorMask */
        pointer->lengthXorMask,     /* xorMaskLength */
        pointer->andMaskData,       /* andMask */
        pointer->lengthAndMask,     /* andMaskLength */
        pointer->xorBpp,            /* xorBpp */
        &context->gdi->palette      /* palette */
    );

    if (!ok) {
        free(rgba);
        return FALSE;
    }

    cp->rgba_data = rgba;
    cp->rgba_size = rgba_size;

    return TRUE;
}

static BOOL cb_pointer_set(rdpContext *context, rdpPointer *pointer) {
    (void)context;
    if (!pointer) return FALSE;

    ConduitPointer *cp = (ConduitPointer *)pointer;
    if (!cp->rgba_data || cp->rgba_size == 0) return FALSE;

    UINT32 w = pointer->width;
    UINT32 h = pointer->height;
    UINT32 hotX = pointer->xPos;
    UINT32 hotY = pointer->yPos;

    /* Payload: [hotspotX:u16-LE][hotspotY:u16-LE][width:u16-LE][height:u16-LE][rgba...] */
    output_send_cursor(
        (uint16_t)hotX, (uint16_t)hotY,
        (uint16_t)w, (uint16_t)h,
        cp->rgba_data, cp->rgba_size
    );

    return TRUE;
}

static void cb_pointer_free(rdpContext *context, rdpPointer *pointer) {
    (void)context;
    if (!pointer) return;

    ConduitPointer *cp = (ConduitPointer *)pointer;
    free(cp->rgba_data);
    cp->rgba_data = NULL;
    cp->rgba_size = 0;
}

static BOOL cb_pointer_set_null(rdpContext *context) {
    (void)context;
    output_send_cursor_null();
    return TRUE;
}

static BOOL cb_pointer_set_default(rdpContext *context) {
    (void)context;
    output_send_cursor_default();
    return TRUE;
}

static BOOL cb_pointer_set_position(rdpContext *context, UINT32 x, UINT32 y) {
    /* No-op — we track cursor position from local mouse input,
     * not from server position updates. */
    (void)context;
    (void)x;
    (void)y;
    return TRUE;
}

/* ── Registration ──────────────────────────────────────────────────── */

void pointer_register(rdpGraphics *graphics) {
    if (!graphics) return;

    rdpPointer pointer = { 0 };
    pointer.size = sizeof(ConduitPointer);
    pointer.New = cb_pointer_new;
    pointer.Free = cb_pointer_free;
    pointer.Set = cb_pointer_set;
    pointer.SetNull = cb_pointer_set_null;
    pointer.SetDefault = cb_pointer_set_default;
    pointer.SetPosition = cb_pointer_set_position;

    graphics_register_pointer(graphics, &pointer);
    fprintf(stderr, "[conduit-freerdp] Pointer callbacks registered\n");
}
