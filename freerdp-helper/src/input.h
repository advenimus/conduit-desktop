/**
 * input.h — Route mouse/keyboard commands to FreeRDP input API.
 *
 * Thread safety: input functions are called from the stdin command thread
 * while the FreeRDP event loop runs on a background thread. A mutex
 * serializes input API calls to prevent transport corruption.
 */

#ifndef INPUT_H
#define INPUT_H

#include <freerdp/freerdp.h>
#include <stdbool.h>

/**
 * Initialize the input mutex. Must be called before any input functions.
 */
void input_init(void);

/**
 * Send mouse move event.
 */
void input_mouse_move(freerdp *instance, int x, int y);

/**
 * Send mouse button down event (button: 0=left, 1=middle, 2=right).
 */
void input_mouse_button_down(freerdp *instance, int x, int y, int button);

/**
 * Send mouse button up event.
 */
void input_mouse_button_up(freerdp *instance, int x, int y, int button);

/**
 * Send mouse scroll event.
 */
void input_mouse_scroll(freerdp *instance, int x, int y, int delta, bool vertical);

/**
 * Send key down event (PS/2 scancode).
 */
void input_key_down(freerdp *instance, int scancode, bool extended);

/**
 * Send key up event (PS/2 scancode).
 */
void input_key_up(freerdp *instance, int scancode, bool extended);

#endif /* INPUT_H */
