import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import ConflictFieldRow from "../ConflictFieldRow";
import type { ConflictVersion, FieldConflict } from "../../../types/sync";

function version(id: string, value: string | null, extra: Partial<ConflictVersion> = {}): ConflictVersion {
  return {
    id,
    source: { kind: "device", deviceUuid: id, deviceName: id === "a" ? "MacBook" : "iPhone" },
    timeMs: 0,
    value,
    masked: false,
    provisional: id === "a",
    undecryptable: false,
    redacted: false,
    olderApp: false,
    ...extra,
  };
}

function field(reg: string, label: string, secret: boolean, keepBoth: boolean, versions: ConflictVersion[]): FieldConflict {
  return { key: { tbl: 1, rowId: "e1", reg }, label, cls: "prompt", secret, versions, staleRevert: false, keepBothOffered: keepBoth, invariantGuard: false, snoozeKey: "s" };
}

beforeEach(() => {
  window.electron = { platform: "darwin", invoke: vi.fn(), send: vi.fn(), on: vi.fn(() => () => {}), removeListener: vi.fn() };
});

afterEach(cleanup);

describe("ConflictFieldRow (spec 7.2, 7.3)", () => {
  it("shows long notes in full, so versions that differ late can be told apart", () => {
    const head = `Runbook: ${"x".repeat(130)}`;
    render(<ConflictFieldRow field={field("notes", "Notes", false, true, [version("a", `${head} restart nginx`), version("b", `${head} reboot the server`)])} itemTitle="Prod" />);
    expect(screen.getByText(`${head} restart nginx`)).toBeInTheDocument();
    expect(screen.getByText(`${head} reboot the server`)).toBeInTheDocument();
  });

  it("never points at a Keep both button that a private key does not have", () => {
    render(<ConflictFieldRow field={field("private_key", "Private key", true, false, [version("a", null, { masked: true }), version("b", null, { masked: true })])} itemTitle="Prod" />);
    expect(screen.queryByText(/Keep both/)).toBeNull();
    expect(screen.getByText(/Reveal and copy any key you still need/)).toBeInTheDocument();
  });

  it("labels a document by its text, not its JSON", () => {
    const doc = { ...field("config.content", "Document", false, true, [version("a", JSON.stringify("# Steps\n1. ssh in"))]) };
    const { container } = render(<ConflictFieldRow field={doc} itemTitle="Runbook" />);
    expect(container.querySelector("pre")?.textContent).toBe("# Steps\n1. ssh in");
  });
});
