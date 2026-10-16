/**
 * json_out.c — JSON payload builders for helper → Electron messages.
 */

#include "json_out.h"
#include "cjson/cJSON.h"

#include <stddef.h>

static char *print_and_delete(cJSON *root) {
    char *json = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    return json;
}

char *json_build_error(const char *message, uint32_t code) {
    cJSON *root = cJSON_CreateObject();
    if (!root) return NULL;

    if (!cJSON_AddStringToObject(root, "message", message ? message : "Unknown error") ||
        (code != 0 && !cJSON_AddNumberToObject(root, "code", (double)code))) {
        cJSON_Delete(root);
        return NULL;
    }
    return print_and_delete(root);
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
