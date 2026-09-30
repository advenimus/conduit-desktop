import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import RenameVaultDialog from "../vault/RenameVaultDialog";
import CreateTeamVaultDialog from "../vault/CreateTeamVaultDialog";
import SshKeyGeneratorDialog from "../tools/SshKeyGeneratorDialog";
import { useVaultStore } from "../../stores/vaultStore";

vi.mock("../common/Toast", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

type Handler = (args?: unknown) => unknown;
let handlers: Record<string, Handler> = {};

/** invoke() rejects with an Error whose message is the main process's reason. */
const failWith = (message: string): Handler => () => {
  throw new Error(message);
};

beforeEach(() => {
  handlers = { settings_get: () => ({}), team_vault_list: () => [] };
  const invoke = vi.fn(async (channel: string, args?: unknown) => handlers[channel]?.(args) ?? null);
  window.electron = { platform: "darwin", invoke, send: vi.fn(), on: vi.fn(() => () => {}), removeListener: vi.fn() };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const errorLine = () => document.querySelector("[data-dialog-content] [data-cv-error]") ?? screen.queryByRole("alert");

describe("dialogs show the reason an IPC call failed, not a generic message", () => {
  it("Rename Vault", async () => {
    useVaultStore.setState({ currentVaultPath: "/v/Acme.conduit", vaultType: "personal", teamVaultId: null });
    handlers.vault_rename = failWith("A vault named Ops already exists");
    render(<RenameVaultDialog onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("Enter new vault name"), { target: { value: "Ops" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    });
    expect(screen.getByText("A vault named Ops already exists")).toBeInTheDocument();
    expect(screen.queryByText("Failed to rename vault")).toBeNull();
  });

  it("Create Team Vault", async () => {
    handlers.identity_key_exists = () => false;
    handlers.identity_key_generate = failWith("Keychain access was denied");
    render(<CreateTeamVaultDialog onClose={vi.fn()} />);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Generate Identity Key" }));
    });
    expect(screen.getByText("Keychain access was denied")).toBeInTheDocument();
    expect(screen.queryByText("Failed to generate identity key")).toBeNull();
  });

  it("SSH Key Generator", async () => {
    handlers.ssh_generate_keypair = failWith("Unsupported key size");
    render(<SshKeyGeneratorDialog onClose={vi.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Generate Key Pair" }));
    });
    expect(screen.getByText("Unsupported key size")).toBeInTheDocument();
    expect(errorLine()).not.toBeNull();
  });
});

describe("stores keep the reason too", () => {
  it("vaultStore.createCredential stores the Error's message", async () => {
    handlers.credential_create = failWith("Entry limit reached");
    await expect(useVaultStore.getState().createCredential({ name: "db" } as never)).rejects.toThrow("Entry limit reached");
    expect(useVaultStore.getState().error).toBe("Entry limit reached");
  });
});

describe("no error handling in src reads only string errors", () => {
  const SRC = path.resolve(__dirname, "../..");
  // A caught error is an Error (invoke() rejects with one), so a string-only read always shows the fallback.
  const STRING_ONLY = /typeof\s+(?:err|error|e)\s*===\s*["']string["']\s*\?\s*(?:err|error|e)\s*:\s*["']/;

  function files(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "__tests__" ? [] : files(full);
      return /\.tsx?$/.test(entry.name) ? [full] : [];
    });
  }

  it("uses errorText wherever a caught error becomes a message", () => {
    const offenders = files(SRC).filter((f) => STRING_ONLY.test(fs.readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });
});
