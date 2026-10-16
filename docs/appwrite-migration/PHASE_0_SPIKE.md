# Appwrite migration: Phase 0 spike results

Run 2026-10-14 against a local Appwrite 2.3.0 (Docker, PostgreSQL adapter), the same version as the self-hosted server. Scripts live in `appwrite/spike/`.

## Results

| Check | Result | Script |
|---|---|---|
| Import a user with a Supabase-style `$2a$` bcrypt hash and a fixed UUID as the user ID | Pass. ID kept, old password signs in | `spike1-auth.mjs` |
| MFA with the email factor for an imported user | Pass. `user_more_factors_required`, email code completes it | `spike1-auth.mjs` |
| Blocked (suspended) user cannot sign in | Pass | `spike1-auth.mjs` |
| JWT for calls to the website API | Pass. `users.createJWT` and `account.createJWT` both identify the user server-side | `spike1b-handoff.mjs` |
| Desktop handoff with a one-time token (`users.createToken` then `account.createSession`) | **Gap.** Every new session needs its own second step, including server-created ones | `spike1-auth.mjs`, `spike1b-handoff.mjs` |
| Realtime from Node (Electron main process) with a session secret | Pass with a one-line shim. Server-side query filters work, rows the user can't read never arrive | `spike2-realtime.mjs` |
| Lease race: 20 parallel acquirers, cap of 1 | **Naive transactions fail** (12 of 20 won). Guard-revision pattern passes 5 of 5 rounds (exactly 1 winner) | `spike3-race.mjs` |
| Function call speed (user session, sync execution, one DB read) | Pass. Cold about 850 ms, warm median 16 ms, p90 21 ms. Anonymous calls rejected (401) | `spike4-fn.mjs` |

## What changes in the plan

1. **Desktop sign-in handoff.** A token-created session asks for MFA again. Keep today's model instead: when the website runs a `?desktop=true` sign-in (or sign-up plus authenticator setup), the session it just verified is handed to the app in the deep link and the website forgets it. This is the same as today, where the website hands its Supabase access and refresh tokens to the app. If someone is already signed in on the website, the desktop flow asks for one fresh code to build a new verified session.
2. **Realtime in the main process.** The web SDK's realtime calls `window.setInterval`. Set `globalThis.window ??= globalThis` before loading it, or write a small client for the realtime socket protocol (connect, `authentication` message with the session, `subscribe` with channels and queries). Node 22+ has a global `WebSocket`, so no extra package.
3. **Every rule-backed write uses the guard-revision pattern.** Appwrite transactions do not serialize reads. Each account (or team, or vault) gets a guard table. A write reads the latest `rev`, checks the rule, then commits one transaction that creates guard row `hash(scope, rev + 1)` with a fixed ID plus the real change. A parallel writer hits a 409 on the guard row and retries from fresh reads. All writers of a guarded scope must bump the guard, or the rule can be broken.
4. **Functions call the API on an internal address.** The default `APPWRITE_FUNCTION_API_ENDPOINT` points at the public domain. Locally that is `localhost`, which a function container can't reach. Functions read `CONDUIT_API_ENDPOINT` first (local: `http://appwrite-api/v1`).

## Local stack notes (for the Phase 7 harness script)

- Install: `docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$PWD":/usr/src/code/appwrite:rw --entrypoint=install appwrite/appwrite:2.3.0 --http-port=8085 --https-port=8445 --interactive=N --database=postgresql --domain=localhost`
- `.env` changes: `_APP_SMTP_HOST=conduit-appwrite-mailpit`, `_APP_SMTP_PORT=1025`, `_APP_FUNCTIONS_RUNTIMES="node-22"`.
- Mail catcher: `axllent/mailpit` on the `appwrite` network, UI and API on port 8025.
- `docker-compose.override.yml` (in `appwrite/spike/`) puts the API container on the `runtimes` network as `appwrite-api`.
- Console user, org team, project `conduit-dev`, API key and a `localhost` web platform are created with the console REST API (`X-Appwrite-Project: console`); `projectId`, `keyId` and `platformId` are required.
- `_APP_FUNCTIONS_INACTIVE_THRESHOLD` is 60 s by default. Heartbeats run more often than that, so the lease function stays warm.

## Not covered by the spike

- Appwrite Swift SDK realtime and sessions on iOS (covered when Phase 5 starts).
- Re-enrolling TOTP after the email bridge (adding an authenticator to an email-MFA account).
- The Next.js cookie flow end to end. Only the building blocks were tested: the server gets the session secret, and a session-secret client works.
