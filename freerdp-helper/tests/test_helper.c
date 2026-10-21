/* Unit tests for the helper's pure logic (JSON builders, stdin parser, TLS reasons); no FreeRDP needed. Run tests/run-tests.sh. */

#include "json_out.h"
#include "protocol.h"
#include "tls_reason.h"
#include "cjson/cJSON.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int g_failures = 0;
static int g_checks = 0;

#define CHECK(cond) do { \
    g_checks++; \
    if (!(cond)) { \
        g_failures++; \
        fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
    } \
} while (0)

#define CHECK_STR(actual, expected) do { \
    const char *a_ = (actual); const char *e_ = (expected); \
    g_checks++; \
    if (!a_ || !e_ ? a_ != e_ : strcmp(a_, e_) != 0) { \
        g_failures++; \
        fprintf(stderr, "FAIL %s:%d: got \"%s\", want \"%s\"\n", __FILE__, __LINE__, \
                a_ ? a_ : "(null)", e_ ? e_ : "(null)"); \
    } \
} while (0)

static void test_error_json_plain(void) {
    char *json = json_build_error("Connection failed", 0);
    CHECK_STR(json, "{\"message\":\"Connection failed\"}");
    json_out_free(json);
}

static void test_error_json_with_code(void) {
    char *json = json_build_error("ERRCONNECT_CONNECT_TRANSPORT_FAILED", 0x0002000D);
    CHECK_STR(json, "{\"message\":\"ERRCONNECT_CONNECT_TRANSPORT_FAILED\",\"code\":131085}");
    json_out_free(json);
}

static void test_error_json_with_phase(void) {
    char *json = json_build_error_phase("Access denied.", 0x00020016, "gateway");
    CHECK_STR(json, "{\"message\":\"Access denied.\",\"code\":131094,\"phase\":\"gateway\"}");
    json_out_free(json);

    json = json_build_error_phase("Access denied.", 0x00020016, "target");
    CHECK_STR(json, "{\"message\":\"Access denied.\",\"code\":131094,\"phase\":\"target\"}");
    json_out_free(json);

    json = json_build_error_phase("Connection failed", 0, NULL);
    CHECK_STR(json, "{\"message\":\"Connection failed\"}");
    json_out_free(json);
}

static void test_connect_error_phase(void) {
    CHECK(connect_error_phase(false, false) == NULL);
    CHECK(connect_error_phase(false, true) == NULL);
    CHECK_STR(connect_error_phase(true, false), "gateway");
    CHECK_STR(connect_error_phase(true, true), "target");
}

static void test_error_json_large_code(void) {
    /* HRESULT-style gateway codes are above INT32_MAX. */
    char *json = json_build_error("E_PROXY_NAP_ACCESSDENIED", 0x800759DAu);
    cJSON *root = cJSON_Parse(json);
    CHECK(root != NULL);
    cJSON *code = cJSON_GetObjectItemCaseSensitive(root, "code");
    CHECK(cJSON_IsNumber(code));
    CHECK(code && code->valuedouble == (double)0x800759DAu);
    cJSON_Delete(root);
    json_out_free(json);
}

static void test_error_json_escapes(void) {
    const char *nasty = "Gateway said \"no\" \\ path C:\\x\nline2\ttab\x01 end";
    char *json = json_build_error(nasty, 5);
    cJSON *root = cJSON_Parse(json);
    CHECK(root != NULL);
    cJSON *msg = cJSON_GetObjectItemCaseSensitive(root, "message");
    CHECK(cJSON_IsString(msg));
    CHECK_STR(msg ? msg->valuestring : NULL, nasty);
    CHECK(strchr(json, '\n') == NULL);
    cJSON_Delete(root);
    json_out_free(json);
}

static void test_error_json_null_message(void) {
    char *json = json_build_error(NULL, 0);
    CHECK_STR(json, "{\"message\":\"Unknown error\"}");
    json_out_free(json);
}

static void test_error_json_long_message_not_truncated_into_bad_json(void) {
    char big[5000];
    memset(big, '"', sizeof(big) - 1);
    big[sizeof(big) - 1] = '\0';
    char *json = json_build_error(big, 1);
    cJSON *root = cJSON_Parse(json);
    CHECK(root != NULL);
    cJSON_Delete(root);
    json_out_free(json);
}

static void test_disconnected_json(void) {
    char *json = json_build_disconnected(NULL);
    CHECK_STR(json, "{\"error\":null}");
    json_out_free(json);

    json = json_build_disconnected("bad \"quote\"");
    CHECK_STR(json, "{\"error\":\"bad \\\"quote\\\"\"}");
    json_out_free(json);
}

static bool parse_line(const char *line, Command *cmd) {
    FILE *f = tmpfile();
    if (!f) return false;
    fputs(line, f);
    fputc('\n', f);
    rewind(f);
    FILE *saved = stdin;
    stdin = f;
    bool ok = protocol_read_command(cmd);
    stdin = saved;
    fclose(f);
    return ok;
}

static void test_parse_connect_without_gateway(void) {
    Command cmd;
    CHECK(parse_line("{\"type\":\"connect\",\"config\":{\"host\":\"pc1\",\"port\":3389,"
                     "\"username\":\"u\",\"password\":\"p\"}}", &cmd));
    CHECK(cmd.type == CMD_CONNECT);
    CHECK_STR(cmd.data.connect.host, "pc1");
    CHECK(!cmd.data.connect.has_gateway);
    CHECK(cmd.data.connect.gateway.host == NULL);
    protocol_free_command(&cmd);
}

static void test_parse_connect_with_gateway(void) {
    Command cmd;
    CHECK(parse_line("{\"type\":\"connect\",\"config\":{\"host\":\"pc1.corp.local\",\"port\":3389,"
                     "\"gateway\":{\"host\":\"rdg.example.com\",\"port\":8443,"
                     "\"username\":\"gwuser\",\"password\":\"gw\\\"pw\",\"domain\":\"CORP\","
                     "\"transport\":\"http\",\"bypassLocal\":true}}}", &cmd));
    CHECK(cmd.type == CMD_CONNECT);
    CHECK(cmd.data.connect.has_gateway);
    CHECK_STR(cmd.data.connect.gateway.host, "rdg.example.com");
    CHECK(cmd.data.connect.gateway.port == 8443);
    CHECK_STR(cmd.data.connect.gateway.username, "gwuser");
    CHECK_STR(cmd.data.connect.gateway.password, "gw\"pw");
    CHECK_STR(cmd.data.connect.gateway.domain, "CORP");
    CHECK(cmd.data.connect.gateway.transport == GATEWAY_TRANSPORT_HTTP);
    CHECK(cmd.data.connect.gateway.bypass_local);
    protocol_free_command(&cmd);
}

static void test_parse_gateway_defaults(void) {
    Command cmd;
    CHECK(parse_line("{\"type\":\"connect\",\"config\":{\"host\":\"pc1\","
                     "\"gateway\":{\"host\":\"rdg\"}}}", &cmd));
    CHECK(cmd.data.connect.has_gateway);
    CHECK(cmd.data.connect.gateway.port == 443);
    CHECK(cmd.data.connect.gateway.transport == GATEWAY_TRANSPORT_AUTO);
    CHECK(!cmd.data.connect.gateway.bypass_local);
    CHECK(cmd.data.connect.gateway.username == NULL);
    CHECK(cmd.data.connect.gateway.password == NULL);
    protocol_free_command(&cmd);
}

static void test_parse_gateway_transport_values(void) {
    CHECK(gateway_transport_from_string("auto") == GATEWAY_TRANSPORT_AUTO);
    CHECK(gateway_transport_from_string("http") == GATEWAY_TRANSPORT_HTTP);
    CHECK(gateway_transport_from_string("rpc") == GATEWAY_TRANSPORT_RPC);
    CHECK(gateway_transport_from_string("bogus") == GATEWAY_TRANSPORT_AUTO);
    CHECK(gateway_transport_from_string(NULL) == GATEWAY_TRANSPORT_AUTO);
}

static void test_parse_gateway_null_is_no_gateway(void) {
    Command cmd;
    CHECK(parse_line("{\"type\":\"connect\",\"config\":{\"host\":\"pc1\",\"gateway\":null}}", &cmd));
    CHECK(!cmd.data.connect.has_gateway);
    protocol_free_command(&cmd);
}

static void test_validate_gateway(void) {
    ConnectConfig cfg;
    memset(&cfg, 0, sizeof(cfg));
    CHECK(connect_config_validate(&cfg) == NULL);

    cfg.has_gateway = true;
    cfg.gateway.port = 443;
    CHECK(connect_config_validate(&cfg) != NULL);

    char host[] = "rdg";
    cfg.gateway.host = host;
    CHECK(connect_config_validate(&cfg) == NULL);

    cfg.gateway.port = 70000;
    CHECK(connect_config_validate(&cfg) != NULL);
    cfg.gateway.port = 0;
    CHECK(connect_config_validate(&cfg) != NULL);
}


static void test_error_json_with_tls(void) {
    char *json = json_build_error_detail("The connection failed at TLS connect.", 0x00020008, "gateway",
                                         "error:0A00042E:SSL routines::tlsv1 alert protocol version");
    CHECK_STR(json, "{\"message\":\"The connection failed at TLS connect.\",\"code\":131080,\"phase\":\"gateway\","
                    "\"tls\":\"error:0A00042E:SSL routines::tlsv1 alert protocol version\"}");
    json_out_free(json);

    json = json_build_error_detail("x", 0, NULL, "");
    CHECK_STR(json, "{\"message\":\"x\"}");
    json_out_free(json);
}

static void test_cert_request_json(void) {
    CertRequest req = {
        .id = 7, .host = "rdg.example.com", .port = 443, .common_name = "rdg.example.com",
        .subject = "CN=rdg.example.com", .issuer = "CN=Corp \"Root\" CA",
        .pem = "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n",
        .gateway = true, .mismatch = false, .changed = false,
    };
    char *json = json_build_cert_request(&req);
    cJSON *root = cJSON_Parse(json);
    CHECK(root != NULL);
    CHECK(cJSON_GetObjectItemCaseSensitive(root, "id")->valueint == 7);
    CHECK_STR(cJSON_GetObjectItemCaseSensitive(root, "host")->valuestring, "rdg.example.com");
    CHECK(cJSON_GetObjectItemCaseSensitive(root, "port")->valueint == 443);
    CHECK_STR(cJSON_GetObjectItemCaseSensitive(root, "hop")->valuestring, "gateway");
    CHECK(cJSON_IsFalse(cJSON_GetObjectItemCaseSensitive(root, "mismatch")));
    CHECK_STR(cJSON_GetObjectItemCaseSensitive(root, "issuer")->valuestring, "CN=Corp \"Root\" CA");
    CHECK_STR(cJSON_GetObjectItemCaseSensitive(root, "pem")->valuestring, req.pem);
    cJSON_Delete(root);
    json_out_free(json);

    CertRequest target = { .id = 1, .port = 3389, .mismatch = true, .changed = true };
    json = json_build_cert_request(&target);
    root = cJSON_Parse(json);
    CHECK(root != NULL);
    CHECK_STR(cJSON_GetObjectItemCaseSensitive(root, "hop")->valuestring, "target");
    CHECK_STR(cJSON_GetObjectItemCaseSensitive(root, "host")->valuestring, "");
    CHECK(cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(root, "mismatch")));
    CHECK(cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(root, "changed")));
    cJSON_Delete(root);
    json_out_free(json);
}

static void test_parse_cert_response(void) {
    Command cmd;
    CHECK(parse_line("{\"type\":\"cert_response\",\"id\":3,\"accept\":true}", &cmd));
    CHECK(cmd.type == CMD_CERT_RESPONSE);
    CHECK(cmd.data.cert_response.id == 3);
    CHECK(cmd.data.cert_response.accept);
    protocol_free_command(&cmd);

    CHECK(parse_line("{\"type\":\"cert_response\",\"id\":4,\"accept\":\"yes\"}", &cmd));
    CHECK(cmd.type == CMD_CERT_RESPONSE);
    CHECK(!cmd.data.cert_response.accept);
    protocol_free_command(&cmd);

    CHECK(parse_line("{\"type\":\"cert_response\"}", &cmd));
    CHECK(cmd.data.cert_response.id == -1);
    CHECK(!cmd.data.cert_response.accept);
    protocol_free_command(&cmd);
}

static void test_parse_legacy_tls_and_config_dir(void) {
    Command cmd;
    CHECK(parse_line("{\"type\":\"connect\",\"config\":{\"host\":\"pc1\",\"legacyTls\":true,"
                     "\"configDir\":\"/tmp/conduit freerdp\",\"gateway\":{\"host\":\"rdg\",\"legacyTls\":true}}}", &cmd));
    CHECK(cmd.data.connect.legacy_tls);
    CHECK_STR(cmd.data.connect.config_dir, "/tmp/conduit freerdp");
    CHECK(cmd.data.connect.gateway.legacy_tls);
    protocol_free_command(&cmd);

    CHECK(parse_line("{\"type\":\"connect\",\"config\":{\"host\":\"pc1\",\"gateway\":{\"host\":\"rdg\"}}}", &cmd));
    CHECK(!cmd.data.connect.legacy_tls);
    CHECK(cmd.data.connect.config_dir == NULL);
    CHECK(!cmd.data.connect.gateway.legacy_tls);
    protocol_free_command(&cmd);
}

static void test_tls_reason_from_log(void) {
    char out[TLS_REASON_MAX];
    CHECK(tls_reason_from_log("[BIO_do_handshake] 803FC9F001000000:error:0A00042E:SSL routines:ssl3_read_bytes:"
                              "tlsv1 alert protocol version:ssl/record/rec_layer_s3.c:908:SSL alert number 70 [131]",
                              out, sizeof(out)));
    CHECK_STR(out, "error:0A00042E:SSL routines:ssl3_read_bytes:tlsv1 alert protocol version:"
                   "ssl/record/rec_layer_s3.c:908:SSL alert number 70");

    CHECK(tls_reason_from_log("[BIO_do_handshake] something odd", out, sizeof(out)));
    CHECK_STR(out, "something odd");

    CHECK(!tls_reason_from_log("BIO_do_handshake failed", out, sizeof(out)));
    CHECK(!tls_reason_from_log("[BIO_do_handshake]  [0]", out, sizeof(out)));
    CHECK(!tls_reason_from_log(NULL, out, sizeof(out)));

    char tiny[8];
    CHECK(tls_reason_from_log("[BIO_do_handshake] error:0A000102:SSL routines::unsupported protocol [9]", tiny, sizeof(tiny)));
    CHECK_STR(tiny, "error:0");
}

static void test_tls_reason_append(void) {
    char buf[40] = "";
    tls_reason_append(buf, sizeof(buf), "first");
    tls_reason_append(buf, sizeof(buf), "second");
    tls_reason_append(buf, sizeof(buf), "first");
    tls_reason_append(buf, sizeof(buf), "");
    CHECK_STR(buf, "first; second");

    tls_reason_append(buf, sizeof(buf), "a reason that is much too long to fit");
    CHECK(strlen(buf) == sizeof(buf) - 1);
    CHECK(strncmp(buf, "first; second; a reason", 23) == 0);

    tls_reason_append(buf, sizeof(buf), "more");
    CHECK(strlen(buf) == sizeof(buf) - 1);
}

int main(void) {
    test_error_json_plain();
    test_error_json_with_code();
    test_error_json_with_phase();
    test_connect_error_phase();
    test_error_json_large_code();
    test_error_json_escapes();
    test_error_json_null_message();
    test_error_json_long_message_not_truncated_into_bad_json();
    test_disconnected_json();
    test_parse_connect_without_gateway();
    test_parse_connect_with_gateway();
    test_parse_gateway_defaults();
    test_parse_gateway_transport_values();
    test_parse_gateway_null_is_no_gateway();
    test_validate_gateway();
    test_error_json_with_tls();
    test_cert_request_json();
    test_parse_cert_response();
    test_parse_legacy_tls_and_config_dir();
    test_tls_reason_from_log();
    test_tls_reason_append();

    if (g_failures) {
        fprintf(stderr, "%d of %d checks failed\n", g_failures, g_checks);
        return 1;
    }
    printf("All %d checks passed\n", g_checks);
    return 0;
}
