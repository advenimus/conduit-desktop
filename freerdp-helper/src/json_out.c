/* JSON payload builders for helper to Electron messages. */

#include "json_out.h"
#include "cjson/cJSON.h"

#include <stddef.h>

static char *print_and_delete(cJSON *root) {
    char *json = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    return json;
}

char *json_build_error(const char *message, uint32_t code) {
    return json_build_error_phase(message, code, NULL);
}

char *json_build_error_phase(const char *message, uint32_t code, const char *phase) {
    cJSON *root = cJSON_CreateObject();
    if (!root) return NULL;

    if (!cJSON_AddStringToObject(root, "message", message ? message : "Unknown error") ||
        (code != 0 && !cJSON_AddNumberToObject(root, "code", (double)code)) ||
        (phase && !cJSON_AddStringToObject(root, "phase", phase))) {
        cJSON_Delete(root);
        return NULL;
    }
    return print_and_delete(root);
}

const char *connect_error_phase(bool gateway_enabled, bool target_reached) {
    if (!gateway_enabled) return NULL;
    return target_reached ? "target" : "gateway";
}

char *json_build_disconnected(const char *error) {
    cJSON *root = cJSON_CreateObject();
    if (!root) return NULL;

    cJSON *item = error ? cJSON_AddStringToObject(root, "error", error)
                        : cJSON_AddNullToObject(root, "error");
    if (!item) {
        cJSON_Delete(root);
        return NULL;
    }
    return print_and_delete(root);
}

void json_out_free(char *json) {
    if (json) cJSON_free(json);
}
