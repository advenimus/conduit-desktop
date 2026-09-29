import { describe, it, expect, vi } from "vitest";
import { classifyUnlockError, unlockArgs } from "../vault-unlock-errors";

const OPEN_ELSEWHERE = {
  code: "VAULT_OPEN_ELSEWHERE",
  holders: [],
  limit: 1,
  fileName: "Vault.conduit",
  locationDiffers: false,
  via: "server",
};

describe("classifyUnlockError", () => {
  it("routes structured errors to the sync dialogs", () => {
    const res = classifyUnlockError(new Error(JSON.stringify(OPEN_ELSEWHERE)), "Invalid master password");
    expect(res.message).toBeNull();
    expect(res.payload?.code).toBe("VAULT_OPEN_ELSEWHERE");
  });

  it.each([
    ["VAULT_NOT_OWNER", { code: "VAULT_NOT_OWNER", fileName: "V", offline: false, graceEndedMs: null, released: false, copyTicket: "t", copyDir: "/d" }],
    ["VAULT_SIGN_IN_REQUIRED", { code: "VAULT_SIGN_IN_REQUIRED", fileName: "V" }],
    ["VAULT_UPDATE_REQUIRED", { code: "VAULT_UPDATE_REQUIRED", fileName: "V", minVersion: "0.19.0" }],
  ])("routes %s to its dialog (no retry loop, no error line)", (code, payload) => {
    const res = classifyUnlockError(new Error(JSON.stringify(payload)), "Invalid master password");
    expect(res).toEqual({ payload, message: null });
    expect(res.payload?.code).toBe(code);
  });

  it("keeps the wrong-password message", () => {
    expect(classifyUnlockError(new Error("Invalid master password"), "x")).toEqual({ payload: null, message: "Invalid master password" });
  });

  it("no longer turns every error into Invalid master password", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = classifyUnlockError(new Error("Lock the open vault before unlocking another one."), "Invalid master password");
    expect(res.message).toBe("Lock the open vault before unlocking another one.");
  });

  it("falls back for long or multi-line messages and non-Error values", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(classifyUnlockError(new Error("a\nb"), "Fallback").message).toBe("Fallback");
    expect(classifyUnlockError(new Error("x".repeat(500)), "Fallback").message).toBe("Fallback");
    expect(classifyUnlockError(undefined, "Fallback").message).toBe("Fallback");
  });

  it("ignores JSON with an unknown code", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = classifyUnlockError(new Error('{"code":"SOMETHING_ELSE"}'), "Fallback");
    expect(res.payload).toBeNull();
  });
});

describe("unlockArgs", () => {
  it("adds only the options that are set", () => {
    expect(unlockArgs({ masterPassword: "p" }, undefined)).toEqual({ masterPassword: "p" });
    expect(unlockArgs({ masterPassword: "p" }, { takeover: true })).toEqual({ masterPassword: "p", takeover: true });
    expect(unlockArgs({}, { previousPassword: "old", recoverWorkingCopy: true, takeover: false })).toEqual({
      previousPassword: "old",
      recoverWorkingCopy: true,
    });
  });
});
