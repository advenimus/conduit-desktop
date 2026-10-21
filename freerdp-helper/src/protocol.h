/**
 * protocol.h — JSON command parser for stdin input.
 *
 * Parses newline-delimited JSON commands from Electron.
 */

#ifndef PROTOCOL_H
#define PROTOCOL_H

#include "cjson/cJSON.h"
#include <stdbool.h>

/* Command types from Electron */
typedef enum {
    CMD_CONNECT,
    CMD_DISCONNECT,
    CMD_MOUSE_MOVE,
    CMD_MOUSE_BUTTON_DOWN,
    CMD_MOUSE_BUTTON_UP,
    CMD_MOUSE_SCROLL,
    CMD_KEY_DOWN,
    CMD_KEY_UP,
    CMD_RESIZE,
    CMD_CLIPBOARD_SET,
    CMD_CLIPBOARD_SET_FILES,
    CMD_CLIPBOARD_REQUEST_FILES,
    CMD_CERT_RESPONSE,
    CMD_UNKNOWN
} CommandType;

/* Drive redirection config */
typedef struct {
    char *name;
    char *path;
} DriveConfig;

typedef enum {
    GATEWAY_TRANSPORT_AUTO,
    GATEWAY_TRANSPORT_HTTP,
    GATEWAY_TRANSPORT_RPC
} GatewayTransport;

/* RD Gateway config (config.gateway). Credentials are resolved by Electron. */
typedef struct {
    char *host;
    int port;
    char *username;
    char *password;
    char *domain;
    GatewayTransport transport;
    bool bypass_local;
    bool legacy_tls;
} GatewayConfig;

/* Parsed connect configuration */
typedef struct {
    char *host;
    int port;
    char *username;
    char *password;
    char *domain;
    int width;
    int height;
    bool enable_nla;
    bool skip_cert_verification;
    bool enable_gfx;
    bool enable_h264;
    DriveConfig *drives;
    int drive_count;
    int desktop_scale_factor;
    int device_scale_factor;
    bool enable_clipboard;
    /* TLS security level 0 for old servers (TLS 1.0/1.1); renegotiation is set by Electron in OPENSSL_CONF. */
    bool legacy_tls;
    /* FreeRDP's config folder; its certificate store there is never written. */
    char *config_dir;
    bool has_gateway;
    GatewayConfig gateway;
} ConnectConfig;

/* Parsed command */
typedef struct {
    CommandType type;
    union {
        ConnectConfig connect;
        struct { int x; int y; } mouse_move;
        struct { int x; int y; int button; } mouse_button;
        struct { int x; int y; int delta; bool vertical; } mouse_scroll;
        struct { int scancode; bool extended; } key;
        struct { int width; int height; int desktop_scale_factor; int device_scale_factor; } resize;
        struct { char *text; int length; } clipboard_set;
        struct { char *json; } clipboard_set_files;
        struct { char *temp_dir; } clipboard_request_files;
        struct { int id; bool accept; } cert_response;
    } data;
} Command;

/**
 * Read a single JSON command from stdin (blocking).
 * Returns true if a command was parsed, false on EOF or error.
 */
bool protocol_read_command(Command *cmd);

/**
 * Free any dynamically allocated data in a command.
 */
void protocol_free_command(Command *cmd);

/* Map "auto" | "http" | "rpc" to a transport. Anything else is AUTO. */
GatewayTransport gateway_transport_from_string(const char *s);

/* NULL when a parsed connect config is valid, else a short user-facing message (static string). */
const char *connect_config_validate(const ConnectConfig *config);

#endif /* PROTOCOL_H */
