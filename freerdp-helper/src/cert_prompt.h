/* Asks Electron about a certificate FreeRDP could not verify. FreeRDP calls back on the thread running
 * freerdp_connect, which is the stdin reader, so the answer is read right here. */

#ifndef CERT_PROMPT_H
#define CERT_PROMPT_H

#include <stdbool.h>
#include "json_out.h"

/* Allows prompts on the calling thread until cert_prompt_end. */
void cert_prompt_begin(void);
void cert_prompt_end(void);

/* Sends CERT_VERIFY and waits for the matching cert_response; input that arrives meanwhile is dropped.
 * False for "do not trust", a disconnect, stdin EOF, or a call outside begin/end. req->id is assigned here. */
bool cert_prompt_ask(const CertRequest *req);

/* A disconnect or stdin EOF arrived while waiting for an answer. */
bool cert_prompt_disconnect_requested(void);

#endif /* CERT_PROMPT_H */
