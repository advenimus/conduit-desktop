# Local RD Gateway test rig

A small Docker setup for testing Conduit's RD Gateway support on a Mac without a Windows server.

- **rdpgw**: an open-source RD Gateway (`bolkedebruin/rdpgw`, pinned by digest, arm64 and amd64). It uses NTLM logins and a self-signed TLS certificate. It only lets people through to `desktop:3389`.
- **desktop**: a Debian Linux desktop (xrdp + Xfce). It sits on an internal Docker network with no published port. The Mac cannot reach it directly, so a working session proves the gateway path was used.

Only the gateway is published, on `127.0.0.1:18443`.

## Prerequisites

- Docker Desktop, running.
- `openssl` (built into macOS).
- For `check-reference.sh`: Homebrew FreeRDP 3.x (`brew install freerdp`). The script uses `sdl-freerdp` because `xfreerdp` needs XQuartz on macOS. Set `CLIENT=xfreerdp` if you have an X server.
- For `helper-smoke.mjs`: Node, plus a built Conduit helper (`scripts/build-macos.sh`), or point `HELPER_BIN` at one.

## Commands

Run these from this folder.

| Command | What it does |
| --- | --- |
| `./up.sh` | Makes the test certificate (first run only), builds the desktop image, starts both containers, waits until they are healthy. |
| `./check-reference.sh` | Checks the rig with stock FreeRDP. A good login must stay connected. A wrong gateway password, a blocked target and a gateway that is down must all fail. A direct connection to the desktop must fail. Prints a PASS/FAIL table. Takes about 30 seconds and opens a few short-lived client windows. |
| `node helper-smoke.mjs` | Runs the Conduit helper through the gateway and prints a PASS/FAIL table. See below. |
| `./legacy-up.sh` | Adds old-server TLS fronts next to a running rig (see below). |
| `./down.sh` | Stops the rig. `./down.sh --purge` also deletes the certificate and the desktop image. |

Settings you can change with environment variables:

- `GW_PORT`: the gateway port on the Mac (default `18443`). Use the same value for every command.
- `DOWN_PORT`: a port with nothing on it, used for the "gateway down" case (default `18499`).
- `HELPER_BIN`: the helper to test. By default the script looks in `freerdp-helper/bundle/darwin/` (the path the dev app uses), then `freerdp-helper/build/`.
- `CASES`: a comma list of smoke cases to run, for example `CASES=gateway-good,gateway-down`.
- `LEGACY=1`: also run the old-server cases (start them with `./legacy-up.sh` first).
- `LEGACY_TLS10_PORT`, `LEGACY_WEAK_PORT`, `LEGACY_RENEG_PORT`: the old-server front ports (defaults `18444`, `18445`, `18446`).
- `ENABLE_NLA=0`: send `enableNla: false` to the helper. The default is on, like a normal entry. xrdp has no NLA, so FreeRDP falls back to TLS.

Client and helper logs go to `logs/`, which git ignores, as does `certs/`.

## Test logins (test only)

These exist only inside this rig. Never use them anywhere else.

| What | Value |
| --- | --- |
| Gateway address | `127.0.0.1`, port `18443` |
| Gateway login | `gwuser` / `GwTest-Pass1!` (no domain) |
| Target host behind the gateway | `desktop`, port `3389` |
| Desktop login | `deskuser` / `DeskTest-Pass1!` |
| Login that works on both | `shareduser` / `SharedTest-Pass1!`, for a gateway set to use the RDP entry's login |
| Target the gateway refuses | anything else, for example `not-allowed-host` |

The certificate is self-signed for `localhost` and `127.0.0.1`. Stock clients must skip certificate checks. Conduit asks once (Trust once, Always trust, Cancel) for the gateway and once for the desktop; the smoke cases skip the check unless they test it.

## Helper smoke test

`helper-smoke.mjs` starts the helper, sends one `connect` line on stdin with `config.gateway` set (the same shape as `electron/services/rdp/engines/freerdp.ts`), and reads the binary frames from stdout. The frame parsing and pass rules live in `lib/helper-protocol.mjs` and are covered by `__tests__/helper-protocol.test.ts`.

| Case | Passes when |
| --- | --- |
| good login | The helper says connected and sends at least one frame. |
| transport http | Same, with `transport: 'http'`. |
| wrong gateway password | The helper sends a valid JSON error and never connects. The bad password has quotes and a backslash to test escaping. |
| gateway down | Same, with the gateway port pointing at `DOWN_PORT`. |
| target not allowed | Same, with the target set to `not-allowed-host`. |
| transport rpc | Same. rdpgw has no RPC transport, so this must fail cleanly. A real Microsoft gateway does support RPC. |
| certificate asked, trusted | Certificate checks on: the helper asks about the gateway and the desktop, the script trusts both, and it connects. |
| certificate asked, refused | The script refuses the gateway's certificate, and the helper fails cleanly. |

With `LEGACY=1`:

| Case | Passes when |
| --- | --- |
| TLS 1.0 gateway, switch off | The error carries OpenSSL's `tlsv1 alert protocol version`. |
| TLS 1.0 gateway, switch on | `gateway.legacyTls` connects through to the desktop. |
| TLS 1.0 gateway, entry switch only | The entry's `legacyTls` does not lower the gateway hop, so it still fails. |
| SHA-1/1024-bit gateway cert | Connects: a weak certificate passes the TLS handshake and is only a trust question. |
| no secure renegotiation, off | Fails at TLS connect (FreeRDP logs no OpenSSL reason for this one). |
| no secure renegotiation, on | With `legacyTls` and the app's `OPENSSL_CONF`, TLS passes and it fails later, because that front is not a gateway. |

## Old-server fronts

`./legacy-up.sh` makes test certificates in `certs/legacy/` and starts `legacytls` (compose profile `legacy`, `legacy/Dockerfile`):

- `127.0.0.1:18444`: TLS 1.0 only, passed on to rdpgw (socat).
- `127.0.0.1:18445`: TLS 1.2 with a SHA-1 signed, 1024-bit RSA certificate from a test CA, passed on to rdpgw.
- `127.0.0.1:18446`: GnuTLS with secure renegotiation turned off, answering HTTP only.

Point a gateway entry at one of these ports to see the app's diagnosis and the Allow old TLS switch. `./down.sh` stops it too.

Every case also fails if a password shows up in the helper's stderr.

## Using it in the app

Make an RDP entry with host `desktop`, port `3389`, login `deskuser` / `DeskTest-Pass1!`. Turn on the entry's gateway (Custom) with host `127.0.0.1` and port `18443`. For the gateway login, pick a saved credential for `gwuser` / `GwTest-Pass1!`, because the desktop login is different. The session should show the Xfce desktop. If you set the gateway to Off, the connection must fail, because the Mac cannot resolve `desktop`.

## Errors seen on this rig

Recorded with FreeRDP 3.31.1 (`sdl-freerdp`) and the Conduit helper (FreeRDP 3.15). Useful for matching friendly error messages.

| Case | sdl-freerdp 3.31 | Conduit helper |
| --- | --- | --- |
| Wrong gateway password | `ERRCONNECT_ACCESS_DENIED` | `Access denied.` (code `0x00020016`) |
| Target not allowed | `E_PROXY_RAP_ACCESSDENIED` | `E_PROXY_RAP_ACCESSDENIED` (code `0x800759DA`) |
| Gateway down | `ERRCONNECT_CONNECT_FAILED` | `The connection failed at TLS connect.` (code `0x00020008`) |
| RPC transport against rdpgw | `ERRCONNECT_SECURITY_NEGO_CONNECT_FAILED` | `The connection failed at negotiating security settings.` (code `0x0002000C`) |
| No gateway, host `desktop` | `ERRCONNECT_DNS_NAME_NOT_FOUND` | not tested |

## How the verifier uses it

1. `./up.sh`
2. `./check-reference.sh`: every row must say PASS. This proves the rig works before Conduit is tested.
3. `node helper-smoke.mjs`: every row must say PASS.
4. Test the app end to end with the logins above.
5. `./down.sh` when done.

## Troubleshooting

- **Port in use**: run with another port, for example `GW_PORT=18444 ./up.sh`, and pass the same `GW_PORT` to the other scripts.
- **Rig not healthy**: run `docker compose logs rdpgw desktop`.
- **Gateway side of a connection**: `docker compose logs rdpgw` shows NTLM logins, `Verifying <host> host connection`, and `Connection established`.
