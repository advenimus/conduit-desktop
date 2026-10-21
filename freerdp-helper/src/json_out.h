/* JSON payload builders for helper to Electron messages; cJSON escapes strings so any FreeRDP or gateway text stays valid JSON. */

#ifndef JSON_OUT_H
#define JSON_OUT_H

#include <stdbool.h>
#include <stdint.h>

/* {"message":"..."} plus "code":N when non-zero; a heap string for json_out_free, or NULL when out of memory. */
char *json_build_error(const char *message, uint32_t code);

/* Like json_build_error, plus "phase":"gateway"|"target" when phase is not NULL. */
char *json_build_error_phase(const char *message, uint32_t code, const char *phase);

/* Like json_build_error_phase, plus "tls":"..." (OpenSSL's handshake failure reasons) when tls is not empty. */
char *json_build_error_detail(const char *message, uint32_t code, const char *phase, const char *tls);

/* A certificate FreeRDP could not verify, for Electron to decide on. pem is the public certificate only. */
typedef struct {
    int id;
    const char *host;
    int port;
    const char *common_name;
    const char *subject;
    const char *issuer;
    const char *pem;
    bool gateway;
    bool mismatch;
    bool changed;
} CertRequest;

/* {"id":N,"host":"...","port":N,"hop":"gateway"|"target","mismatch":bool,"changed":bool,...}; NULL when out of memory. */
char *json_build_cert_request(const CertRequest *req);

/* Which hop a failed connect broke at: NULL without a gateway, "target" once the gateway tunnel carried RDP data. */
const char *connect_error_phase(bool gateway_enabled, bool target_reached);

/* {"error":null} or {"error":"..."}; a heap string for json_out_free, or NULL when out of memory. */
char *json_build_disconnected(const char *error);

void json_out_free(char *json);

#endif /* JSON_OUT_H */
