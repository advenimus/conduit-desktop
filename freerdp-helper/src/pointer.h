/**
 * pointer.h — Remote cursor support via FreeRDP pointer callbacks.
 *
 * Converts server cursor data to RGBA and sends it through the binary
 * protocol so Electron can apply it as a CSS custom cursor.
 */

#ifndef POINTER_H
#define POINTER_H

#include <freerdp/graphics.h>

/**
 * Register pointer callbacks with the FreeRDP graphics subsystem.
 * Must be called after gdi_init() since it needs context->graphics.
 */
void pointer_register(rdpGraphics *graphics);

#endif /* POINTER_H */
