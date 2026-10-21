#include "tls_diag.h"
#include "tls_reason.h"

#include <winpr/wlog.h>
#include <stdio.h>

static char s_reasons[TLS_REASON_MAX];

/* The appender's lock serializes calls, so s_reasons needs no lock of its own. */
static BOOL on_log_message(const wLogMessage *msg) {
    if (!msg) return FALSE;
    const char *text = msg->TextString ? msg->TextString : "";
    fprintf(stderr, "%s%s\n", msg->PrefixString ? msg->PrefixString : "", text);

    char reason[TLS_REASON_MAX];
    if (tls_reason_from_log(text, reason, sizeof(reason))) {
        tls_reason_append(s_reasons, sizeof(s_reasons), reason);
    }
    return TRUE;
}

bool tls_diag_install(void) {
    wLog *root = WLog_GetRoot();
    if (!root || !WLog_SetLogAppenderType(root, WLOG_APPENDER_CALLBACK)) return false;

    wLogAppender *appender = WLog_GetLogAppender(root);
    wLogCallbacks callbacks = { 0 };
    callbacks.message = on_log_message;
    return appender && WLog_ConfigureAppender(appender, "callbacks", &callbacks);
}

void tls_diag_reset(void) {
    s_reasons[0] = '\0';
}

const char *tls_diag_reasons(void) {
    return s_reasons;
}
