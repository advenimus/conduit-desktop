/* JSON payload builders for helper to Electron messages; cJSON escapes strings so any FreeRDP or gateway text stays valid JSON. */

#ifndef JSON_OUT_H
#define JSON_OUT_H

#include <stdbool.h>
#include <stdint.h>

/* {"message":"..."} plus "code":N when non-zero; a heap string for json_out_free, or NULL when out of memory. */
char *json_build_error(const char *message, uint32_t code);

/* Like json_build_error, plus "phase":"gateway"|"target" when phase is not NULL. */
char *json_build_error_phase(const char *message, uint32_t code, const char *phase);

/* Which hop a failed connect broke at: NULL without a gateway, "target" once the gateway tunnel carried RDP data. */
const char *connect_error_phase(bool gateway_enabled, bool target_reached);

/* {"error":null} or {"error":"..."}; a heap string for json_out_free, or NULL when out of memory. */
char *json_build_disconnected(const char *error);

void json_out_free(char *json);

#endif /* JSON_OUT_H */
