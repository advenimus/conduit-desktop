/* Unit tests for the helper's pure logic (JSON builders, stdin parser); no FreeRDP needed. Run tests/run-tests.sh. */

#include "json_out.h"
#include "protocol.h"
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
    char *json = json_build_disconnected(NULL, 0);
    CHECK_STR(json, "{\"error\":null}");
    json_out_free(json);

    json = json_build_disconnected("bad \"quote\"", 0);
    CHECK_STR(json, "{\"error\":\"bad \\\"quote\\\"\"}");
    json_out_free(json);

    /* ERRINFO_LOGOFF_BY_USER: the server's reason, so Electron can tell a sign-out from a dropped link. */
    json = json_build_disconnected(NULL, 0x0C);
    CHECK_STR(json, "{\"error\":null,\"errorInfo\":12}");
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

    if (g_failures) {
        fprintf(stderr, "%d of %d checks failed\n", g_failures, g_checks);
        return 1;
    }
    printf("All %d checks passed\n", g_checks);
    return 0;
}
