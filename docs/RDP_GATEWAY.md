# RD Gateway

A Remote Desktop Gateway (RDG) lets you reach Windows computers on a private network. The gateway listens on HTTPS (port 443 by default) and passes your RDP session on to the computer behind it. Conduit's FreeRDP helper speaks the gateway protocol over HTTP (with WebSocket) and RPC.

## For users

### Set a default gateway

**Settings > Sessions > RDP > Default gateway**

- Turn on the switch and enter the gateway server, for example `gateway.example.com`. You can type `gateway.example.com:8443`; the port moves into the Port field.
- **Skip the gateway for local addresses**: connect straight to computers on your local network.
- **Advanced > Transport**: Automatic tries HTTP first, then RPC. Change it only if your gateway needs one of them.

The default lives on this device only. It never holds a password or a vault credential.

### Per entry

Open an RDP entry and pick the **Gateway** tab.

- **Use default gateway** (the default): uses the Settings default when it is on. The tab shows which one applies.
- **No gateway**: always connect straight to the computer.
- **Custom gateway**: this entry's own server, port, local bypass and transport.

**Gateway login** (for the default or a custom gateway):

- **Same login as this computer**: the gateway gets the entry's username, password and domain.
- **Use a saved credential**: pick a credential from the vault. Use this when the gateway account differs from the Windows account.

A `DOMAIN\user` username is split into domain and user for the gateway.

### When it fails

| Message starts with | What it means |
|---|---|
| The gateway did not accept the login | The gateway answered 401. Check the gateway username and password. |
| Could not reach the gateway | No connection to the gateway server or port. Check the name, port, network or VPN. |
| The gateway's address could not be found | DNS could not find the gateway server. |
| The secure connection to the gateway failed | TLS to the gateway failed, often a certificate problem. |
| The gateway refused the connection | The gateway's policy (RAP/CAP) does not allow this account to reach this computer. |
| The gateway could not reach this computer | The gateway is fine, but it cannot reach the computer's host and port. |
| The gateway needs a login / The saved gateway login for this entry was not found | Fix the entry's login or its Gateway tab. |

## For contributors

### Data

- Entry keys live flat on the RDP entry's `config` so sync merges each one: `gatewayMode`, `gatewayHostname`, `gatewayPort`, `gatewayTransport`, `gatewayBypassLocal`, `gatewayCredentialMode`, `gatewayCredentialId`. An unset `gatewayMode` means "use default".
- Device defaults live in the `session_defaults_rdp` setting: `gatewayEnabled`, `gatewayHostname`, `gatewayPort`, `gatewayTransport`, `gatewayBypassLocal`.
- No gateway password is ever stored in `config` or settings.
- Types and the resolve logic: `electron/services/rdp/gateway-config.ts`, re-exported to the renderer by `src/lib/rdpGateway.ts`.

### Connect flow

1. Renderer (`src/stores/entryStore.ts` `connectEntry`): `resolveGatewaySettings(entry.config, sessionDefaultsRdp)` gives secret-free `RdpGatewaySettings` or `null`, sent as the `gateway` arg of `rdp_connect`. It also stores `gatewayHost` on the session's metadata for the connecting screen and error mapping.
2. Main (`electron/ipc/rdp.ts`): validates the arg, looks up a linked gateway credential in the active vault, and builds `RdpEngineConfig.gateway` with `resolveGatewayEngineConfig`. A `GatewayConfigError` becomes the connect error.
3. Helper: gets `config.gateway = { host, port, username, password, domain, transport, bypassLocal }` on stdin, omitted when there is no gateway.

The MCP `connection_open_entry` path resolves the same way in the main process (`electron/ipc-server/rdp-entry-config.ts`).

### Renderer files

- `src/components/entries/tabs/GatewayTab.tsx`: the entry tab.
- `src/components/entries/gatewayForm.ts`: what the tab saves (`gatewayConfigForSave`), save checks, `host:port` splitting.
- `src/components/settings/tabs/SessionRdpTab.tsx`: the default gateway section.
- `src/lib/errorMessages.ts`: gateway error patterns. `E_PROXY_*` codes always map; login, DNS, TLS and transport failures map to gateway wording only when the session used a gateway.

### Testing

- Unit tests: `gateway-config.test.ts`, `gatewayForm.test.ts`, `GatewayTab.test.tsx`, `SessionRdpTab.test.tsx`, `entry-rdp-gateway.test.ts`, `errorMessages.test.ts`.
- A local gateway rig (rdpgw plus a Linux desktop that is only reachable through it) lives in `scripts/gateway-test/`.
