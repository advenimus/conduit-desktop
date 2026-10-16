import { describe, it, expect } from "vitest";
import { connectionErrorText, friendlyConnectionError, localNetworkPermissionMessage, mayBeLocalNetworkBlock } from "../errorMessages";
import { formatRdpConnectError } from "../rdpConnectError";

describe("friendlyConnectionError", () => {
  describe("RDP (FreeRDP) errors", () => {
    it("maps the CredSSP/NLA auth failure (0x00020009) to domain/NTLM guidance", () => {
      // Exact string the FreeRDP helper reports for ERRCONNECT_AUTHENTICATION_FAILED.
      const raw = "An authentication failure aborted the connection.";
      const friendly = friendlyConnectionError(raw, "rdp");

      expect(friendly).not.toBe(raw);
      expect(friendly).toMatch(/domain/i);
      expect(friendly).toMatch(/hostname/i);
      expect(friendly).toMatch(/NTLM/i);
    });

    it("maps security negotiation failures to an NLA hint", () => {
      const friendly = friendlyConnectionError(
        "The security negotiation has failed.",
        "rdp",
      );
      expect(friendly).toMatch(/NLA|Network Level Authentication/i);
    });

    it("maps TLS / certificate errors to a certificate hint", () => {
      const friendly = friendlyConnectionError(
        "The connection failed during TLS handshake.",
        "rdp",
      );
      expect(friendly).toMatch(/certificate|TLS/i);
    });

    it("maps expired-password errors", () => {
      const friendly = friendlyConnectionError(
        "The password is expired and must be changed.",
        "rdp",
      );
      expect(friendly).toMatch(/expired/i);
    });

    it("maps insufficient-privilege / access denied errors", () => {
      const friendly = friendlyConnectionError(
        "Insufficient privileges to log on.",
        "rdp",
      );
      expect(friendly).toMatch(/Remote Desktop Users|not allowed/i);
    });

    it("maps name-resolution failures", () => {
      const friendly = friendlyConnectionError(
        "The DNS host name could not be resolved.",
        "rdp",
      );
      expect(friendly).toMatch(/resolved|hostname/i);
    });

    it("maps transport / unreachable failures", () => {
      const friendly = friendlyConnectionError(
        "ERRCONNECT_CONNECT_TRANSPORT_FAILED",
        "rdp",
      );
      expect(friendly).toMatch(/reach|online|port/i);
    });

    it("passes through unrecognized RDP errors unchanged", () => {
      const raw = "Some brand new FreeRDP error we do not recognize.";
      expect(friendlyConnectionError(raw, "rdp")).toBe(raw);
    });

    it("prefers RDP guidance over the generic table for RDP sessions", () => {
      // "authentication failure" is RDP wording; ensure RDP table wins and
      // does not fall through to the SSH-oriented generic message.
      const friendly = friendlyConnectionError(
        "An authentication failure aborted the connection.",
        "rdp",
      );
      expect(friendly).not.toMatch(/SSH key/i);
    });

    it("contains no em dashes in RDP guidance (user-facing copy rule)", () => {
      const friendly = friendlyConnectionError(
        "An authentication failure aborted the connection.",
        "rdp",
      );
      expect(friendly).not.toContain("—");
    });
  });

  describe("RD Gateway errors", () => {
    const viaGateway = { gateway: true };

    const ACCESS_DENIED = 0x00020016;
    const TLS_CONNECT_FAILED = 0x00020008;
    const DNS_NAME_NOT_FOUND = 0x00020005;
    const TRANSPORT_FAILED = 0x0002000d;
    const atGateway = (message: string, code?: number) => formatRdpConnectError({ message, code, phase: "gateway" });
    const atTarget = (message: string, code?: number) => formatRdpConnectError({ message, code, phase: "target" });

    it("maps the gateway's HTTP 401 (FreeRDP 'Access denied.') to a gateway login hint when the gateway refused", () => {
      const friendly = friendlyConnectionError(atGateway("Access denied.", ACCESS_DENIED), "rdp", viaGateway);
      expect(friendly).toMatch(/gateway/i);
      expect(friendly).toMatch(/login|password/i);
      expect(friendly).not.toMatch(/Remote Desktop Users/);
    });

    it("does not blame the gateway for 'Access denied.' from the computer behind it", () => {
      expect(friendlyConnectionError(atTarget("Access denied.", ACCESS_DENIED), "rdp", viaGateway)).toMatch(/server rejected the sign in/);
    });

    it("treats a direct 'Access denied.' as a rejected sign in", () => {
      expect(friendlyConnectionError("Access denied.", "rdp")).toMatch(/server rejected the sign in/);
    });

    it("does not blame the gateway for 'Access denied.' without evidence of the failed hop", () => {
      expect(friendlyConnectionError("Access denied.", "rdp", viaGateway)).not.toMatch(/gateway/i);
    });

    it("uses the FreeRDP code over the text when the gateway refused", () => {
      expect(friendlyConnectionError(atGateway("Something odd", ACCESS_DENIED), "rdp", viaGateway)).toMatch(
        /gateway did not accept the login/i,
      );
      expect(friendlyConnectionError(atGateway("Something odd", DNS_NAME_NOT_FOUND), "rdp", viaGateway)).toMatch(
        /gateway's address could not be found/i,
      );
      expect(friendlyConnectionError(atGateway("Something odd", TLS_CONNECT_FAILED), "rdp", viaGateway)).toMatch(
        /secure connection to the gateway/i,
      );
      expect(friendlyConnectionError(atGateway("Something odd", TRANSPORT_FAILED), "rdp", viaGateway)).toMatch(
        /Could not reach the gateway/i,
      );
    });

    it("gives the computer's TLS, DNS and transport guidance once the gateway tunnel was up", () => {
      const tls = friendlyConnectionError(atTarget("The connection failed at TLS connect.", TLS_CONNECT_FAILED), "rdp", viaGateway);
      expect(tls).not.toMatch(/gateway/i);
      expect(tls).toMatch(/certificate/i);
      const dns = friendlyConnectionError(atTarget("The DNS host name was not found.", DNS_NAME_NOT_FOUND), "rdp", viaGateway);
      expect(dns).toMatch(/server's hostname/i);
      const transport = friendlyConnectionError(atTarget("The connection transport layer failed.", TRANSPORT_FAILED), "rdp", viaGateway);
      expect(transport).toMatch(/Could not reach the server/i);
    });

    it("shows the message without the marker when nothing matches", () => {
      const raw = atGateway("Could not connect through the RD Gateway.", 0);
      expect(friendlyConnectionError(raw, "rdp", viaGateway)).toBe("Could not connect through the RD Gateway.");
      expect(connectionErrorText(raw)).toBe("Could not connect through the RD Gateway.");
      expect(connectionErrorText("plain")).toBe("plain");
    });

    it("keeps today's access denied guidance when no gateway is in use", () => {
      expect(friendlyConnectionError("Access is denied.", "rdp")).toMatch(/Remote Desktop Users/);
    });

    it.each([
      "E_PROXY_COOKIE_AUTHENTICATION_ACCESS_DENIED",
      "E_PROXY_UNSUPPORTED_AUTHENTICATION_METHOD",
      "E_PROXY_REAUTH_AUTHN_FAILED",
      "HTTP status 401 Unauthorized",
    ])("treats %s as a gateway login failure", (raw) => {
      expect(friendlyConnectionError(raw, "rdp", viaGateway)).toMatch(/gateway.*(login|password)/i);
    });

    it.each(["E_PROXY_RAP_ACCESSDENIED", "E_PROXY_NAP_ACCESSDENIED", "E_PROXY_QUARANTINE_ACCESSDENIED"])(
      "explains that the gateway refused this computer for %s",
      (raw) => {
        const friendly = friendlyConnectionError(raw, "rdp");
        expect(friendly).toMatch(/gateway/i);
        expect(friendly).toMatch(/not allowed|policy|refused/i);
      },
    );

    it("explains that the gateway could not reach the computer", () => {
      const friendly = friendlyConnectionError("E_PROXY_TS_CONNECTFAILED", "rdp", viaGateway);
      expect(friendly).toMatch(/gateway could not reach/i);
    });

    it("maps a failed transport to an unreachable gateway when the gateway hop failed", () => {
      const friendly = friendlyConnectionError(atGateway("The connection transport layer failed.", TRANSPORT_FAILED), "rdp", viaGateway);
      expect(friendly).toMatch(/Could not reach the gateway/i);
    });

    it("maps a DNS failure to the gateway's address when the gateway hop failed", () => {
      const friendly = friendlyConnectionError(atGateway("The DNS host name was not found.", DNS_NAME_NOT_FOUND), "rdp", viaGateway);
      expect(friendly).toMatch(/gateway/i);
      expect(friendly).toMatch(/address|hostname/i);
    });

    it("maps a TLS failure to a gateway certificate hint when the gateway hop failed", () => {
      const friendly = friendlyConnectionError(atGateway("The connection failed at TLS connect.", TLS_CONNECT_FAILED), "rdp", viaGateway);
      expect(friendly).toMatch(/gateway/i);
      expect(friendly).toMatch(/certificate/i);
    });

    it("keeps the direct TLS and transport guidance without a gateway", () => {
      expect(friendlyConnectionError("The connection failed at TLS connect.", "rdp")).not.toMatch(/gateway/i);
      expect(friendlyConnectionError("The connection transport layer failed.", "rdp")).not.toMatch(/gateway/i);
    });

    it("gives a gateway hint for other E_PROXY errors", () => {
      expect(friendlyConnectionError("E_PROXY_MAXCONNECTIONSREACHED", "rdp")).toMatch(/gateway/i);
    });

    it("passes the gateway setup errors from the main process through unchanged", () => {
      const raw =
        'The gateway "Office" has no login. Add one in the gateway\'s settings, or set it to use the RDP entry\'s login.';
      expect(friendlyConnectionError(raw, "rdp", viaGateway)).toBe(raw);
      expect(friendlyConnectionError(`GatewayConfigError: ${raw}`, "rdp")).toBe(raw);
      const deleted = "The gateway this entry uses was deleted. Pick a gateway again in the entry's Gateway settings.";
      expect(friendlyConnectionError(deleted, "rdp", viaGateway)).toBe(deleted);
      const noUser =
        'The gateway "Office" uses the login of the RDP entry, but this entry has no username. Add a login to the entry.';
      expect(friendlyConnectionError(noUser, "rdp", viaGateway)).toBe(noUser);
    });

    it("contains no em dashes in gateway guidance", () => {
      for (const raw of [atGateway("Access denied.", ACCESS_DENIED), "E_PROXY_RAP_ACCESSDENIED", "E_PROXY_TS_CONNECTFAILED", atGateway("The connection failed at TLS connect.")]) {
        expect(friendlyConnectionError(raw, "rdp", viaGateway)).not.toContain("—");
      }
    });
  });

  describe("non-RDP errors are unaffected", () => {
    it("still maps the SSH auth failure for ssh sessions", () => {
      const friendly = friendlyConnectionError(
        "All configured authentication methods failed",
        "ssh",
      );
      expect(friendly).toMatch(/SSH key|username, password/i);
    });

    it("does not apply RDP-only guidance to ssh sessions", () => {
      // A bare 'authentication failure' string for SSH should not pick up the
      // RDP domain/NTLM message (RDP table is only consulted for rdp).
      const raw = "authentication failure";
      const friendly = friendlyConnectionError(raw, "ssh");
      expect(friendly).not.toMatch(/NTLM/i);
    });

    it("maps host-not-found for any session type", () => {
      const friendly = friendlyConnectionError("getaddrinfo ENOTFOUND host", "web");
      expect(friendly).toMatch(/Host not found/i);
    });

    it("passes through unknown errors", () => {
      const raw = "totally unknown error";
      expect(friendlyConnectionError(raw, "vnc")).toBe(raw);
    });
  });

  describe("macOS local network permission", () => {
    // The main process appends this tag only after confirming macOS is the
    // cause; the underlying errno is EHOSTUNREACH, which the generic table
    // would otherwise blame on an unreachable host.
    const tagged = "connect EHOSTUNREACH 192.168.1.50:22 [ConduitLocalNetworkBlocked]";

    it("explains the permission instead of the errno", () => {
      const friendly = friendlyConnectionError(tagged, "ssh");
      expect(friendly).toMatch(/Local Network/i);
      expect(friendly).not.toMatch(/check network connectivity/i);
    });

    it("tells the user which app name to turn on", () => {
      expect(localNetworkPermissionMessage("Conduit Dev")).toMatch(/turn on Conduit Dev/);
      expect(localNetworkPermissionMessage("Conduit")).toMatch(/turn on Conduit/);
      expect(localNetworkPermissionMessage("Conduit Dev")).not.toBe(
        localNetworkPermissionMessage("Conduit"),
      );
    });

    it("wins over the RDP table, which is consulted first", () => {
      expect(friendlyConnectionError(tagged, "rdp")).toMatch(/Local Network/i);
    });

    it("applies to every session type", () => {
      for (const type of ["ssh", "vnc", "rdp", "web"] as const) {
        expect(friendlyConnectionError(tagged, type)).toMatch(/Local Network/i);
      }
    });

    it("leaves untagged unreachable-host errors on the generic message", () => {
      const friendly = friendlyConnectionError("connect EHOSTUNREACH 192.168.1.50:22", "ssh");
      expect(friendly).toMatch(/Host unreachable/i);
      expect(friendly).not.toMatch(/Local Network/i);
    });
  });
});

describe("mayBeLocalNetworkBlock", () => {
  it.each([
    "connect EHOSTUNREACH 192.168.1.10:22",
    "connect EPERM 10.0.0.5:5900",
    "No route to host",
    "net::ERR_ADDRESS_UNREACHABLE",
    "Failed to connect [ConduitLocalNetworkBlocked]",
    "ERRCONNECT_CONNECT_TRANSPORT_FAILED",
  ])("checks macOS for %s", (raw) => {
    expect(mayBeLocalNetworkBlock(raw)).toBe(true);
  });

  it.each([
    "All configured authentication methods failed",
    "connect ECONNREFUSED 192.168.1.10:22",
    "connect ETIMEDOUT 192.168.1.10:22",
    "getaddrinfo ENOTFOUND web-01",
    "VNC authentication failed",
    "An authentication failure aborted the connection.",
  ])("does not blame macOS for %s", (raw) => {
    expect(mayBeLocalNetworkBlock(raw)).toBe(false);
  });
});
