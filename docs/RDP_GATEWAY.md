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

### iPhone and iPad

iOS does not know about gateways yet. It shows a gateway as a regular credential, and it connects RDP entries straight to the computer, without the gateway.

### When it fails

| Message starts with | What it means |
|---|---|
| The gateway did not accept the login | The gateway answered 401. Check the login on the gateway's Login tab, or the entry's login if the gateway uses it. |
| Could not reach the gateway | No connection to the gateway server or port. Check the name, port, network or VPN. |
| The gateway's address could not be found | DNS could not find the gateway server. |
| The secure connection to the gateway failed | TLS to the gateway failed, often a certificate problem. |
| The gateway refused the connection | The gateway's policy (RAP/CAP) does not allow this account to reach this computer. |
| The gateway could not reach this computer | The gateway is fine, but it cannot reach the computer's host and port. |
| The gateway this entry uses was deleted | Pick a gateway again on the entry's Gateway tab. |
| The gateway "name" has no server address / has no login | Fix the gateway's Server or Login tab. |
| The gateway "name" uses the login of the RDP entry, but this entry has no username | Add a login to the RDP entry. |
| Could not read the gateway from the vault | The vault could not be read (for example it is locked). The gateway itself may be fine. |

Login, address, secure connection and reach errors name the gateway only when the gateway step failed. Once the gateway has passed the session on, the same errors are about the computer behind it.

## For contributors

### Data

A gateway is an entry with `entry_type` `credential` and `credential_type` `rd_gateway` (`RD_GATEWAY_CREDENTIAL_TYPE`). A new `entry_type` is not possible: see "Before you add a type or a column" in `docs/ADDING_ENTRY_TYPES.md`. Older clients do not know `rd_gateway` and treat it as a generic credential.

- Settings are flat keys on the gateway's `config` (`RdGatewayConfig`), so sync merges each one: `gatewayHostname` (an IPv6 address is stored without brackets, because FreeRDP looks it up as is), `gatewayPort`, `gatewayTransport`, `gatewayBypassLocal`, `gatewayLoginSource` and `gatewayCredentialId`.
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

### Renderer files

- `src/components/entries/tabs/GatewayServerTab.tsx` and `GatewayLoginTab.tsx`: the gateway object's editor tabs.
- `src/components/entries/tabs/GatewayTab.tsx`: the RDP entry's gateway picker. "New gateway..." opens a nested `EntryDialog` preset to RD Gateway and selects the new entry.
- `src/components/entries/gatewayForm.ts`: what both editors save, save checks, `host:port` splitting, the gateway list and usage count, the delete warning.
- `src/types/credential.ts` `loginCredentials`: keeps gateways out of every login picker (CredentialPicker, Credential Manager, Quick Connect, the picker window).
- `src/lib/errorMessages.ts`: gateway error patterns. `E_PROXY_*` codes and HTTP 401 text always map to the gateway. Login, DNS, TLS and transport failures (by FreeRDP code first, then by text) map to gateway wording only when the helper reported `phase=gateway`. With `phase=target`, or no phase, they get the same wording as a direct connection. Gateway setup errors from the main process pass through unchanged.

### Testing

- Unit tests: `gateway-config.test.ts`, `gateway-connect.test.ts`, `connect-error.test.ts`, `rdp-file.test.ts`, `export-import-gateway.test.ts`, `gateway-info.test.ts`, `gatewayForm.test.ts`, `GatewayTab.test.tsx`, `EntryDialog.test.tsx`, `EntryTree.test.tsx`, `entry-rdp-gateway.test.ts`, `errorMessages.test.ts`. The helper's error JSON and phase are in `freerdp-helper/tests/test_helper.c`.
- A local gateway rig (rdpgw plus a Linux desktop that is only reachable through it) lives in `scripts/gateway-test/`.
