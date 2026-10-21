/* Keeps OpenSSL's handshake failure reasons from FreeRDP's log so a failed connect can report them. */

#ifndef TLS_DIAG_H
#define TLS_DIAG_H

#include <stdbool.h>

/* Routes FreeRDP's log through the helper: every line still goes to stderr. Call once, after output_init. */
bool tls_diag_install(void);

/* Forgets reasons from an earlier connect. */
void tls_diag_reset(void);

/* "; "-joined reasons since the last reset, or "" when OpenSSL logged none. */
const char *tls_diag_reasons(void);

#endif /* TLS_DIAG_H */
