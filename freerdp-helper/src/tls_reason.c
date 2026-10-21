#include "tls_reason.h"

#include <ctype.h>
#include <string.h>

static const char HANDSHAKE_PREFIX[] = "[BIO_do_handshake] ";

/* Length of text without a trailing " [123]" (the byte count FreeRDP adds). */
static size_t without_length_suffix(const char *text, size_t len) {
    if (len < 4 || text[len - 1] != ']') return len;
    size_t i = len - 2;
    while (i > 0 && isdigit((unsigned char)text[i])) i--;
    if (i + 2 == len || text[i] != '[' || i == 0 || text[i - 1] != ' ') return len;
    return i - 1;
}

bool tls_reason_from_log(const char *text, char *out, size_t out_size) {
    if (!text || !out || out_size == 0) return false;
    if (strncmp(text, HANDSHAKE_PREFIX, sizeof(HANDSHAKE_PREFIX) - 1) != 0) return false;

    const char *reason = text + sizeof(HANDSHAKE_PREFIX) - 1;
    const char *error = strstr(reason, "error:");
    if (error) reason = error;

    size_t len = without_length_suffix(reason, strlen(reason));
    while (len > 0 && isspace((unsigned char)reason[len - 1])) len--;
    if (len == 0) return false;
    if (len >= out_size) len = out_size - 1;
    memcpy(out, reason, len);
    out[len] = '\0';
    return true;
}

void tls_reason_append(char *buf, size_t buf_size, const char *reason) {
    if (!buf || buf_size == 0 || !reason || !reason[0]) return;
    if (strstr(buf, reason)) return;

    size_t used = strlen(buf);
    const char *sep = used ? "; " : "";
    size_t room = buf_size - 1 - used;
    size_t sep_len = strlen(sep);
    if (room <= sep_len) return;
    memcpy(buf + used, sep, sep_len);
    used += sep_len;
    room -= sep_len;

    size_t len = strlen(reason);
    if (len > room) len = room;
    memcpy(buf + used, reason, len);
    buf[used + len] = '\0';
}
