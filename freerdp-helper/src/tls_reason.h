/* OpenSSL handshake failure reasons. FreeRDP only logs them ("[BIO_do_handshake] ..."), so the helper reads its log. */

#ifndef TLS_REASON_H
#define TLS_REASON_H

#include <stdbool.h>
#include <stddef.h>

#define TLS_REASON_MAX 512

/* Copies the OpenSSL error out of a "[BIO_do_handshake] <thread>:error:... [len]" log text; false for any other text. */
bool tls_reason_from_log(const char *text, char *out, size_t out_size);

/* Appends a reason to buf with "; " between reasons, skipping repeats; truncates instead of overflowing. */
void tls_reason_append(char *buf, size_t buf_size, const char *reason);

#endif /* TLS_REASON_H */
