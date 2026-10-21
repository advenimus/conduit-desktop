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
    return json_build_error_detail(message, code, phase, NULL);
}

char *json_build_error_detail(const char *message, uint32_t code, const char *phase, const char *tls) {
    cJSON *root = cJSON_CreateObject();
    if (!root) return NULL;

    if (!cJSON_AddStringToObject(root, "message", message ? message : "Unknown error") ||
        (code != 0 && !cJSON_AddNumberToObject(root, "code", (double)code)) ||
        (phase && !cJSON_AddStringToObject(root, "phase", phase)) ||
        (tls && tls[0] && !cJSON_AddStringToObject(root, "tls", tls))) {
        cJSON_Delete(root);
        return NULL;
    }
    return print_and_delete(root);
}

static bool add_optional_string(cJSON *root, const char *key, const char *value) {
    return cJSON_AddStringToObject(root, key, value ? value : "") != NULL;
}

char *json_build_cert_request(const CertRequest *req) {
    cJSON *root = cJSON_CreateObject();
    if (!root) return NULL;

    if (!cJSON_AddNumberToObject(root, "id", req->id) ||
        !add_optional_string(root, "host", req->host) ||
        !cJSON_AddNumberToObject(root, "port", req->port) ||
        !cJSON_AddStringToObject(root, "hop", req->gateway ? "gateway" : "target") ||
        !cJSON_AddBoolToObject(root, "mismatch", req->mismatch) ||
        !cJSON_AddBoolToObject(root, "changed", req->changed) ||
        !add_optional_string(root, "commonName", req->common_name) ||
        !add_optional_string(root, "subject", req->subject) ||
        !add_optional_string(root, "issuer", req->issuer) ||
        !add_optional_string(root, "pem", req->pem)) {
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
