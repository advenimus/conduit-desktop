# RD Gateway

A Remote Desktop Gateway (RDG) lets you reach Windows computers on a private network. The gateway listens on HTTPS (port 443 by default) and passes your RDP session on to the computer behind it. Conduit's FreeRDP helper speaks the gateway protocol over HTTP (with WebSocket) and RPC.

In Conduit a gateway is its own object in the vault. You set it up once, and any number of RDP entries can use it.

## For users

### 1. Create an RD Gateway

Click **+** (New Entry) and pick **RD Gateway** under Connections.

- **General**: a name, for example `Office gateway`.
- **Gateway > Server**: the gateway server, for example `gateway.example.com`. You can type `gateway.example.com:8443`; the port moves into the Port field. Port is 443 when left empty. For an IPv6 address with a port, use brackets: `[2001:db8::1]:8443`.
- **Skip the gateway for local addresses**: connect straight to computers on your local network.
- **Advanced > Transport**: Automatic tries HTTP first, then RPC. Change it only if your gateway needs one of them.

The Server tab also says how many RDP entries use the gateway.

### 2. Choose its login

**Gateway > Login** has three choices:

- **Type a login**: a username, password and domain just for the gateway. The password is stored encrypted, like any credential.
- **Use a saved credential**: pick a credential from the vault. Use this when several gateways share one account.
- **Use the RDP entry's login**: each RDP entry signs in to the gateway with its own username and password.

A `DOMAIN\user` username is split into domain and user for the gateway.

### 3. Pick it on RDP entries

Open an RDP entry and pick the **Gateway** tab.

- **No gateway** (the default): connect straight to the computer.
- Any gateway in the vault, shown with its address.
- **New gateway...**: makes a new RD Gateway and picks it for this entry.

If the picked gateway was deleted, the tab says so. Pick another one or choose No gateway.

Deleting a gateway that RDP entries use asks first and says how many entries use it. Those entries will not connect until you pick another gateway for them.

### Certificates

Conduit checks the TLS certificate of the gateway and of the computer behind it, like the Windows Remote Desktop app.

- A certificate this device already trusts connects without a question. That covers public certificate authorities and certificates your Mac or PC trusts, for example a company CA installed in Keychain or the Windows certificate store.
- Any other certificate, or one made out to another name, makes Conduit ask: **Trust once**, **Always trust** or **Cancel**. The question shows the host and port, who the certificate is for and who issued it, its dates and its SHA-256 fingerprint. Compare the fingerprint with the one your admin gives you.
- **Always trust** is remembered for that host and port on this device only. It is not in the vault and does not sync. To forget every remembered certificate, quit Conduit and delete `rdp-trusted-certificates.json` from the app's data folder.
- If a remembered certificate changes, Conduit shows a red **Certificate changed** warning with the old and new fingerprints and asks again. Cancel unless you know the certificate was renewed.
- No answer within a minute counts as Cancel.
- **Skip certificate verification** on an RDP entry's Security tab connects without any check or question, for the gateway and the computer. Use it only on a network you trust.
- When an AI agent opens the connection (MCP), the same question shows in the app. With no answer in a minute, or no app window, the agent gets an error that says to open the connection once in Conduit and choose Always trust, or to turn on Skip certificate verification.

### Old servers

Some old gateways and Windows servers only offer TLS 1.0 or 1.1, or lack the secure renegotiation update (RFC 5746). Conduit refuses those by default. **Allow old TLS** lets them in:

- For a gateway: the gateway's Server tab, under Advanced.
- For the computer: the RDP entry's Security tab.

Each switch only lowers the check for its own hop. Turn it on only when the connection fails without it, and ask the server's admin to update the server. A weak certificate (SHA-1, 1024-bit key) does not need the switch: it gets the certificate question like any other untrusted certificate.

### iPhone and iPad

iOS does not know about gateways yet. It shows a gateway as a regular credential, and it connects RDP entries straight to the computer, without the gateway.

### When it fails

| Message starts with | What it means |
|---|---|
| The gateway did not accept the login | The gateway answered 401. Check the login on the gateway's Login tab, or the entry's login if the gateway uses it. |
| Could not reach the gateway | No connection to the gateway server or port. Check the name, port, network or VPN. |
| The gateway's address could not be found | DNS could not find the gateway server. |
| The secure connection to the gateway failed | TLS to the gateway failed. The rest of the message says why (see the next table), and OpenSSL's own reason shows under it. |
| You did not trust the certificate of ... | You chose Cancel on the certificate question, or no one answered in time. Connect again to see it. |
| The certificate of ... is not trusted yet, and no one answered | An agent opened the connection and no one answered in the app. Open it once in Conduit and choose Always trust, or turn on Skip certificate verification. |
| The gateway refused the connection | The gateway's policy (RAP/CAP) does not allow this account to reach this computer. |
| The gateway could not reach this computer | The gateway is fine, but it cannot reach the computer's host and port. |
| The gateway this entry uses was deleted | Pick a gateway again on the entry's Gateway tab. |
| The gateway "name" has no server address / has no login | Fix the gateway's Server or Login tab. |
| The gateway "name" uses the login of the RDP entry, but this entry has no username | Add a login to the RDP entry. |
| Could not read the gateway from the vault | The vault could not be read (for example it is locked). The gateway itself may be fine. |

Login, address, secure connection and reach errors name the gateway only when the gateway step failed. Once the gateway has passed the session on, the same errors are about the computer behind it.

A failed secure connection adds one of these:

| The error says | Cause | What to do |
|---|---|---|
| The server only offers an old TLS version | TLS 1.0 or 1.1 only (OpenSSL: `unsupported protocol`, `tlsv1 alert protocol version`) | Turn on Allow old TLS, or have the admin turn on TLS 1.2. |
| The server is missing a TLS security update | No secure renegotiation (`unsafe legacy renegotiation disabled`) | Turn on Allow old TLS, or have the admin update the server. |
| The server's certificate or key is too weak | A SHA-1 signature or short key in the handshake (`md too weak`, `key too small`) | Turn on Allow old TLS, or have the admin replace the certificate. |
| The server refused the secure handshake | The server sent `handshake failure` | Try Allow old TLS; else ask the admin which TLS settings it needs. |
| The server asked for a client certificate | Smart card or certificate login | Not supported yet. |
| The server did not answer with TLS | Plain HTTP or another service on that port (`wrong version number`) | Check the port. |
| The server closed the connection during the secure handshake | `unexpected eof`; a proxy, firewall or TLS setting | Try Allow old TLS; else check the network path. |
| Nothing is listening on that port | No OpenSSL reason, and a port check was refused | Check the port and that the service runs. FreeRDP reports a closed port as "failed at TLS connect". |
| There was no answer on that port / no route to the server | No OpenSSL reason, and the port check timed out or was unreachable | Check the address, firewall, VPN, and on a Mac the Local Network permission. |
| The port is open, but the secure handshake failed without a reason | No OpenSSL reason, port open. Old servers without secure renegotiation do this: FreeRDP does not log that reason | Try Allow old TLS. |

## For contributors

### Data

A gateway is an entry with `entry_type` `credential` and `credential_type` `rd_gateway` (`RD_GATEWAY_CREDENTIAL_TYPE`). A new `entry_type` is not possible: see "Before you add a type or a column" in `docs/ADDING_ENTRY_TYPES.md`. Older clients do not know `rd_gateway` and treat it as a generic credential.

- Settings are flat keys on the gateway's `config` (`RdGatewayConfig`), so sync merges each one: `gatewayHostname` (an IPv6 address is stored without brackets, because FreeRDP looks it up as is), `gatewayPort`, `gatewayTransport`, `gatewayBypassLocal`, `gatewayLegacyTls`, `gatewayLoginSource` and `gatewayCredentialId`.
- `gatewayLoginSource` is `own` (typed in), `credential` (a saved credential) or `connection` (the RDP entry's login).
- A typed-in login uses the normal entry columns: `username`, `password` (encrypted) and `domain`.
- A saved credential is linked with `config.gatewayCredentialId`, not the `credential_id` column. Team vaults do not sync `credential_id`, but they sync (and encrypt) `config`. The editor saves only what the chosen login uses and keeps `credential_id` empty.
- Gateways saved by early builds of this branch linked the credential in `credential_id`. `readGatewayConfig` reads that as `credential`, and the editor moves the link into `config` on the next save.
- An RDP entry points at a gateway with `config.gatewayId`. Nothing else about the gateway is stored on the RDP entry.
- There is no device default gateway. Older builds stored per-entry keys (`gatewayMode`, `gatewayHostname`, ...) and `gatewayEnabled` and friends in `session_defaults_rdp`; these never shipped and are ignored. The RDP editor drops the old per-entry keys when it saves.
- Types and the resolve logic: `electron/services/rdp/gateway-config.ts`, re-exported to the renderer by `src/lib/rdpGateway.ts`.

### Connect flow

1. Renderer (`src/stores/entryStore.ts` `connectEntry`): sends `gatewayId` (from `gatewayIdOf(entry.config)`) as an `rdp_connect` arg. No gateway address or secret crosses IPC. It stores `gatewayId`, `gatewayName` and `gatewayHost` on the session's metadata for the connecting screen ("Connecting through gateway <name>") and the error mapping.
2. Main (`electron/ipc/rdp.ts`, `electron/services/rdp/gateway-connect.ts` `connectGateway`): loads the gateway entry from the active vault, resolves its own login from its login source (the linked credential or the typed-in fields, never parent-folder inheritance), and calls `resolveGatewayEngineConfig` with the host login from the same `rdp_connect` args. A `GatewayConfigError` becomes the connect error. Only "Entry not found" counts as a deleted gateway or credential; any other vault error is logged and reported as "Could not read the gateway from the vault".
3. Helper: gets `config.gateway = { host, port, username, password, domain, transport, bypassLocal }` on stdin, omitted when there is no gateway.
4. Errors: a failed connect sends `{"message","code","phase"}`. `phase` is `gateway` or `target` and is sent only with a gateway. The helper wraps FreeRDP's transport `WritePdu`: gateway code writes to its own sockets, so the first transport write is RDP data to the computer, and a failure after it is `target`. The engine keeps the message and adds a marker (`electron/services/rdp/connect-error.ts`, for example `Access denied. [rdp-error code=0x00020016 phase=gateway]`). The renderer reads the marker and strips it before showing the text.

The MCP `connection_open_entry` path resolves the same way in the main process (`electron/ipc-server/rdp-entry-config.ts`).

### Certificate check

1. Spawn (`electron/services/rdp/engines/freerdp.ts`, `cert-trust/helper-tls-files.ts`): the helper gets `SSL_CERT_FILE`, a PEM file of Node's bundled CAs plus `tls.getCACertificates('system')` (Keychain or Windows store, so company CAs count), and `configDir`, a FreeRDP config folder under the data folder. FreeRDP's own certificate store (`~/.config/freerdp/server`) is never read or written: older builds accepted every certificate into it.
2. FreeRDP verifies the chain against that file and the host name. Only a failure calls `VerifyCertificateEx` (`freerdp-helper/src/connection.c`). FreeRDP matches DNS names only, so a connection by IP address always reaches the callback.
3. The callback sends `CERT_VERIFY` (0x0E) with `{id, host, port, hop, mismatch, changed, commonName, subject, issuer, pem}` (the public certificate only) and blocks on stdin for `{"type":"cert_response","id":N,"accept":bool}` (`cert_prompt.c`). It answers FreeRDP with 2 (this connection only) or 0. A disconnect or stdin EOF while waiting refuses and ends the helper. A callback outside the connect step (no one is reading stdin) refuses.
4. Main (`cert-trust/cert-trust.ts` `RdpCertTrust.check`): a fingerprint equal to the one remembered for `host:port` connects. Anything else asks through `CertPromptManager` (`cert-prompts.ts`), which sends `rdp:cert_prompt` to the renderer (`src/components/sessions/CertificatePromptDialog.tsx`) and times out to Cancel after 60 seconds. `rdp_cert_prompt_respond` carries the answer.
5. Always trust writes `rdp-trusted-certificates.json` (`cert-trust/trust-store.ts`, mode 0600, atomic rename): `{version: 1, hosts: {"host:port": {fingerprint, subject, issuer, validTo, trustedAt}}}`. Keys are lower case, IPv6 in brackets.
6. A refusal replaces the helper's TLS error with the verifier's own words and `cert=rejected` in the marker, so the renderer shows it unchanged.

`skipCertVerification` (entry config, both hops) sets FreeRDP's `IgnoreCertificate`, so no callback runs. `rdp_connect` passes the verifier with origin `user`; `openRdpSession` (MCP `connection_open`, `connection_open_entry`) passes origin `agent`. The MCP client waits up to 100 seconds for `ConnectionOpen` and `ConnectionOpenEntry`, longer than the question.

### TLS diagnostics and old TLS

- FreeRDP only logs OpenSSL's handshake reason (`[BIO_do_handshake] ...`). The helper routes the FreeRDP log through a callback appender (`tls_diag.c`) that still prints every line to stderr and keeps those reasons (`tls_reason.c`). A failed connect sends them as `"tls"` in the ERROR frame. Some failures, like missing secure renegotiation, log no reason.
- With TLS connect failed (0x00020008) and no reason, the engine connects to the failed hop's host and port with plain TCP (`net-probe.ts`) and adds `net=refused|timeout|unreachable|dns|reset|open` to the marker. It skips the computer hop behind a gateway, which only the gateway can reach.
- `electron/services/rdp/tls-advice.ts` turns the reason or port check into advice; `src/lib/errorMessages.ts` puts it after a short lead. The raw text under the message includes the OpenSSL reason.
- Allow old TLS: `gatewayLegacyTls` on the gateway's config and `legacyTls` on the RDP entry's config (flat keys, off when missing). The helper sets FreeRDP's `TlsSecLevel` to 0 for the hop whose switch is on: the gateway's value first, then the entry's from the first RDP write (the X.224 request goes out before the computer's TLS). Secure renegotiation has no FreeRDP setting, so when either switch is on Electron points `OPENSSL_CONF` at a file with `Options = UnsafeLegacyServerConnect`; that one applies to the whole helper process.

### Renderer files

- `src/components/entries/tabs/GatewayServerTab.tsx` and `GatewayLoginTab.tsx`: the gateway object's editor tabs.
- `src/components/entries/tabs/GatewayTab.tsx`: the RDP entry's gateway picker. "New gateway..." opens a nested `EntryDialog` preset to RD Gateway and selects the new entry.
- `src/components/entries/gatewayForm.ts`: what both editors save, save checks, `host:port` splitting, the gateway list and usage count, the delete warning.
- `src/types/credential.ts` `loginCredentials`: keeps gateways out of every login picker (CredentialPicker, Credential Manager, Quick Connect, the picker window).
- `src/lib/errorMessages.ts`: gateway error patterns. `E_PROXY_*` codes and HTTP 401 text always map to the gateway. Login, DNS, TLS and transport failures (by FreeRDP code first, then by text) map to gateway wording only when the helper reported `phase=gateway`. With `phase=target`, or no phase, they get the same wording as a direct connection. Gateway setup errors from the main process pass through unchanged.

### Testing

- Unit tests: `gateway-config.test.ts`, `gateway-connect.test.ts`, `connect-error.test.ts`, `rdp-file.test.ts`, `export-import-gateway.test.ts`, `gateway-info.test.ts`, `gatewayForm.test.ts`, `GatewayTab.test.tsx`, `EntryDialog.test.tsx`, `EntryTree.test.tsx`, `entry-rdp-gateway.test.ts`, `errorMessages.test.ts`. The helper's error JSON and phase are in `freerdp-helper/tests/test_helper.c`.
- Certificates and TLS: `cert-trust/__tests__/cert-trust.test.ts` (details, store, decisions, prompt queue), `helper-tls-files.test.ts`, `freerdp-cert-flow.test.ts` (engine and a fake helper), `tls-advice.test.ts`, `net-probe.test.ts`, `CertificatePromptDialog.test.tsx`, `SecurityTab.test.tsx`. The helper's cert request JSON, `cert_response` parsing and log reason parsing are in `test_helper.c`.
- A local gateway rig (rdpgw plus a Linux desktop that is only reachable through it) lives in `scripts/gateway-test/`. `legacy-up.sh` adds old-server fronts (TLS 1.0 only, SHA-1/1024-bit certificate, no secure renegotiation), and `LEGACY=1 node helper-smoke.mjs` tests them.
