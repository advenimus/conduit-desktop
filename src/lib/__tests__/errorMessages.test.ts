import { describe, it, expect } from "vitest";
import { friendlyConnectionError } from "../errorMessages";

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
