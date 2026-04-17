/**
 * protocol.c — JSON command parser for stdin input.
 */

#include "protocol.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static char *safe_strdup(const char *s) {
    return s ? strdup(s) : NULL;
}

static const char *cjson_get_string(cJSON *obj, const char *key) {
    cJSON *item = cJSON_GetObjectItemCaseSensitive(obj, key);
    if (cJSON_IsString(item)) return item->valuestring;
    return NULL;
}

static int cjson_get_int(cJSON *obj, const char *key, int def) {
    cJSON *item = cJSON_GetObjectItemCaseSensitive(obj, key);
    if (cJSON_IsNumber(item)) return item->valueint;
    return def;
}

static bool cjson_get_bool(cJSON *obj, const char *key, bool def) {
    cJSON *item = cJSON_GetObjectItemCaseSensitive(obj, key);
    if (cJSON_IsBool(item)) return cJSON_IsTrue(item);
    return def;
}

bool protocol_read_command(Command *cmd) {
    char line[16384];

    if (!fgets(line, sizeof(line), stdin)) {
        return false;
    }

    /* Strip trailing newline */
    size_t len = strlen(line);
    if (len > 0 && line[len - 1] == '\n') line[len - 1] = '\0';
    if (len > 1 && line[len - 2] == '\r') line[len - 2] = '\0';

    if (strlen(line) == 0) return false;

    cJSON *json = cJSON_Parse(line);
    if (!json) {
        fprintf(stderr, "[conduit-freerdp] Failed to parse JSON: %s\n", line);
        cmd->type = CMD_UNKNOWN;
        return true;
    }

    const char *type = cjson_get_string(json, "type");
    if (!type) {
        cmd->type = CMD_UNKNOWN;
        cJSON_Delete(json);
        return true;
    }

    memset(cmd, 0, sizeof(Command));

    if (strcmp(type, "connect") == 0) {
        cmd->type = CMD_CONNECT;
        cJSON *config = cJSON_GetObjectItemCaseSensitive(json, "config");
        if (config) {
            cmd->data.connect.host = safe_strdup(cjson_get_string(config, "host"));
            cmd->data.connect.port = cjson_get_int(config, "port", 3389);
            cmd->data.connect.username = safe_strdup(cjson_get_string(config, "username"));
            cmd->data.connect.password = safe_strdup(cjson_get_string(config, "password"));
            cmd->data.connect.domain = safe_strdup(cjson_get_string(config, "domain"));
            cmd->data.connect.width = cjson_get_int(config, "width", 1920);
            cmd->data.connect.height = cjson_get_int(config, "height", 1080);
            cmd->data.connect.enable_nla = cjson_get_bool(config, "enableNla", true);
            cmd->data.connect.skip_cert_verification = cjson_get_bool(config, "skipCertVerification", false);
            cmd->data.connect.enable_gfx = cjson_get_bool(config, "enableGfx", true);
            cmd->data.connect.enable_h264 = cjson_get_bool(config, "enableH264", true);

            cmd->data.connect.desktop_scale_factor = cjson_get_int(config, "desktopScaleFactor", 100);
            cmd->data.connect.device_scale_factor = cjson_get_int(config, "deviceScaleFactor", 100);
            cmd->data.connect.enable_clipboard = cjson_get_bool(config, "enableClipboard", true);

            /* Parse drives array for RDPDR */
            cJSON *drives = cJSON_GetObjectItemCaseSensitive(config, "drives");
            if (cJSON_IsArray(drives)) {
                int count = cJSON_GetArraySize(drives);
                if (count > 0) {
                    cmd->data.connect.drives = calloc((size_t)count, sizeof(DriveConfig));
                    if (cmd->data.connect.drives) {
                        cmd->data.connect.drive_count = count;
                        for (int i = 0; i < count; i++) {
                            cJSON *item = cJSON_GetArrayItem(drives, i);
                            cmd->data.connect.drives[i].name = safe_strdup(cjson_get_string(item, "name"));
                            cmd->data.connect.drives[i].path = safe_strdup(cjson_get_string(item, "path"));
                        }
                    }
                }
            }
        }
    } else if (strcmp(type, "disconnect") == 0) {
        cmd->type = CMD_DISCONNECT;
    } else if (strcmp(type, "mouse_move") == 0) {
        cmd->type = CMD_MOUSE_MOVE;
        cmd->data.mouse_move.x = cjson_get_int(json, "x", 0);
        cmd->data.mouse_move.y = cjson_get_int(json, "y", 0);
    } else if (strcmp(type, "mouse_button_down") == 0) {
        cmd->type = CMD_MOUSE_BUTTON_DOWN;
        cmd->data.mouse_button.x = cjson_get_int(json, "x", 0);
        cmd->data.mouse_button.y = cjson_get_int(json, "y", 0);
        cmd->data.mouse_button.button = cjson_get_int(json, "button", 0);
    } else if (strcmp(type, "mouse_button_up") == 0) {
        cmd->type = CMD_MOUSE_BUTTON_UP;
        cmd->data.mouse_button.x = cjson_get_int(json, "x", 0);
        cmd->data.mouse_button.y = cjson_get_int(json, "y", 0);
        cmd->data.mouse_button.button = cjson_get_int(json, "button", 0);
    } else if (strcmp(type, "mouse_scroll") == 0) {
        cmd->type = CMD_MOUSE_SCROLL;
        cmd->data.mouse_scroll.x = cjson_get_int(json, "x", 0);
        cmd->data.mouse_scroll.y = cjson_get_int(json, "y", 0);
        cmd->data.mouse_scroll.delta = cjson_get_int(json, "delta", 0);
        cmd->data.mouse_scroll.vertical = cjson_get_bool(json, "vertical", true);
    } else if (strcmp(type, "key_down") == 0) {
        cmd->type = CMD_KEY_DOWN;
        cmd->data.key.scancode = cjson_get_int(json, "scancode", 0);
        cmd->data.key.extended = cjson_get_bool(json, "extended", false);
    } else if (strcmp(type, "key_up") == 0) {
        cmd->type = CMD_KEY_UP;
        cmd->data.key.scancode = cjson_get_int(json, "scancode", 0);
        cmd->data.key.extended = cjson_get_bool(json, "extended", false);
    } else if (strcmp(type, "resize") == 0) {
        cmd->type = CMD_RESIZE;
        cmd->data.resize.width = cjson_get_int(json, "width", 1920);
        cmd->data.resize.height = cjson_get_int(json, "height", 1080);
        cmd->data.resize.desktop_scale_factor = cjson_get_int(json, "desktopScaleFactor", 100);
        cmd->data.resize.device_scale_factor = cjson_get_int(json, "deviceScaleFactor", 100);
    } else if (strcmp(type, "clipboard_set") == 0) {
        cmd->type = CMD_CLIPBOARD_SET;
        const char *text = cjson_get_string(json, "text");
        if (text) {
            cmd->data.clipboard_set.length = (int)strlen(text);
            cmd->data.clipboard_set.text = safe_strdup(text);
        }
    } else if (strcmp(type, "clipboard_set_files") == 0) {
        cmd->type = CMD_CLIPBOARD_SET_FILES;
        cJSON *files = cJSON_GetObjectItemCaseSensitive(json, "files");
        if (files) {
            char *printed = cJSON_PrintUnformatted(files);
            cmd->data.clipboard_set_files.json = printed;
        }
    } else if (strcmp(type, "clipboard_request_files") == 0) {
        cmd->type = CMD_CLIPBOARD_REQUEST_FILES;
        cmd->data.clipboard_request_files.temp_dir = safe_strdup(cjson_get_string(json, "tempDir"));
    } else {
        cmd->type = CMD_UNKNOWN;
    }

    cJSON_Delete(json);
    return true;
}

void protocol_free_command(Command *cmd) {
    if (cmd->type == CMD_CLIPBOARD_SET) {
        free(cmd->data.clipboard_set.text);
        return;
    }
    if (cmd->type == CMD_CLIPBOARD_SET_FILES) {
        free(cmd->data.clipboard_set_files.json);
        return;
    }
    if (cmd->type == CMD_CLIPBOARD_REQUEST_FILES) {
        free(cmd->data.clipboard_request_files.temp_dir);
        return;
    }
    if (cmd->type == CMD_CONNECT) {
        free(cmd->data.connect.host);
        free(cmd->data.connect.username);
        free(cmd->data.connect.password);
        free(cmd->data.connect.domain);
        if (cmd->data.connect.drives) {
            for (int i = 0; i < cmd->data.connect.drive_count; i++) {
                free(cmd->data.connect.drives[i].name);
                free(cmd->data.connect.drives[i].path);
            }
            free(cmd->data.connect.drives);
        }
    }
}
