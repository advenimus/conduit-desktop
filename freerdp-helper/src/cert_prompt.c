#include "cert_prompt.h"
#include "output.h"
#include "protocol.h"

#include <winpr/thread.h>
#include <stdio.h>

static bool s_active = false;
static DWORD s_owner_thread = 0;
static int s_last_id = 0;
static bool s_disconnect_requested = false;

void cert_prompt_begin(void) {
    s_owner_thread = GetCurrentThreadId();
    s_disconnect_requested = false;
    s_active = true;
}

void cert_prompt_end(void) {
    s_active = false;
}

bool cert_prompt_disconnect_requested(void) {
    return s_disconnect_requested;
}

static bool wait_for_answer(int id) {
    for (;;) {
        Command cmd;
        if (!protocol_read_command(&cmd)) {
            s_disconnect_requested = true;
            return false;
        }
        if (cmd.type == CMD_CERT_RESPONSE && cmd.data.cert_response.id == id) {
            return cmd.data.cert_response.accept;
        }
        if (cmd.type == CMD_DISCONNECT) {
            s_disconnect_requested = true;
            return false;
        }
        protocol_free_command(&cmd);
    }
}

bool cert_prompt_ask(const CertRequest *req) {
    const char *host = req->host ? req->host : "?";
    const char *hop = req->gateway ? "gateway" : "target";

    if (!s_active || GetCurrentThreadId() != s_owner_thread) {
        fprintf(stderr, "[conduit-freerdp] Certificate of %s:%d (%s) came outside the connect step; not trusting it\n",
                host, req->port, hop);
        return false;
    }

    CertRequest numbered = *req;
    numbered.id = ++s_last_id;
    if (!output_send_cert_request(&numbered)) {
        fprintf(stderr, "[conduit-freerdp] Could not send the certificate of %s:%d to the app\n", host, req->port);
        return false;
    }
    fprintf(stderr, "[conduit-freerdp] Asked the app about the certificate of %s:%d (%s%s%s)\n", host, req->port, hop,
            req->mismatch ? ", name mismatch" : "", req->changed ? ", changed" : "");

    const bool accept = wait_for_answer(numbered.id);
    fprintf(stderr, "[conduit-freerdp] Certificate of %s:%d %s\n", host, req->port,
            accept ? "trusted by the app" : "not trusted");
    return accept;
}
