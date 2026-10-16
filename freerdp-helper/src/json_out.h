/**
 * json_out.h — JSON payload builders for helper → Electron messages.
 *
 * Strings are escaped by cJSON, so error text from FreeRDP or a gateway
 * (quotes, backslashes, control characters) always yields valid JSON.
 */

#ifndef JSON_OUT_H
#define JSON_OUT_H

#include <stdint.h>

/**
 * Build {"message":"..."} plus "code":N when code is non-zero.
 * Returns a heap string (free with json_out_free) or NULL on allocation failure.
 */
char *json_build_error(const char *message, uint32_t code);

/**
 * Build {"error":null} or {"error":"..."}.
 * Returns a heap string (free with json_out_free) or NULL on allocation failure.
 */
char *json_build_disconnected(const char *error);

void json_out_free(char *json);

#endif /* JSON_OUT_H */
