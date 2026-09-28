import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import ImportDialog from "../ImportDialog";
import type { ImportPreviewEntry } from "../ImportSteps";
import { clickScrim, closeButton, pressEscape, topPanel } from "../../common/__tests__/dialogClose";

const invoke = vi.fn<(channel: string, args?: unknown) => Promise<unknown>>();

function entry(patch: Partial<ImportPreviewEntry>): ImportPreviewEntry {
  return {
    rdmId: "1",
    name: "web01",
    conduitType: "ssh",
    status: "ready",
    statusMessage: null,
    folderPath: "Servers",
    host: "10.0.0.1",
    username: null,
    isGroupCredential: false,
    isDuplicate: false,
    existingEntryId: null,
    ...patch,
  };
}

const PREVIEW = [entry({}), entry({ rdmId: "2", name: "dc01", status: "decrypt-failed", conduitType: "rdp" })];
const RESULT = { totalParsed: 2, imported: 1, skipped: 0, errors: 1, entries: [{ name: "web01", conduitType: "ssh", status: "imported", message: "ok" }] };

let finishImport: (value: unknown) => void = () => {};

beforeEach(() => {
  invoke.mockImplementation((channel) => {
    if (channel === "import_pick_rdm_file") return Promise.resolve("/tmp/export.rdm");
    if (channel === "import_parse_rdm") return Promise.resolve(PREVIEW);
    if (channel === "import_execute_rdm") return new Promise((resolve) => (finishImport = resolve));
    return Promise.resolve(null);
  });
  vi.stubGlobal("electron", { platform: "darwin", invoke, send: vi.fn(), on: vi.fn(() => () => {}), removeListener: vi.fn() });
});

afterEach(() => {
  cleanup();
  invoke.mockReset();
  vi.unstubAllGlobals();
});

const footerButtons = () => [...topPanel().querySelectorAll("[data-cv-dialog-footer] button")].map((b) => b.textContent);

async function toPreview(onClose = vi.fn()) {
  render(<ImportDialog onClose={onClose} />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Choose file/ }));
  });
  return onClose;
}

describe("ImportDialog", () => {
  it("keeps its title, width and the select step's controls", () => {
    render(<ImportDialog onClose={() => {}} />);
    const panel = topPanel();
    expect(panel.querySelector("h2")).toHaveTextContent("Import from Remote Desktop Manager");
    expect(panel).toHaveStyle({ maxWidth: "672px" });
    expect(panel).toHaveTextContent("Export File");
    expect(footerButtons()).toEqual(["Cancel"]);
  });

  it("walks preview and results with today's texts", async () => {
    await toPreview();
    expect(topPanel()).toHaveTextContent("1 ready");
    expect(topPanel()).toHaveTextContent("1 credential could not be decrypted");
    expect(screen.getByTitle("Password decryption failed")).toBeInTheDocument();
    expect(footerButtons()).toEqual(["Back", "Import 2 Entries"]);
    fireEvent.click(screen.getByRole("button", { name: "Import 2 Entries" }));
    expect(topPanel()).toHaveTextContent("Importing entries...");
    await act(async () => finishImport(RESULT));
    expect(topPanel()).toHaveTextContent("Imported");
    expect(footerButtons()).toEqual(["Save Log", "Close"]);
  });

  it("shows a parse error as a danger callout", async () => {
    invoke.mockImplementation((channel) =>
      channel === "import_pick_rdm_file" ? Promise.resolve("/tmp/x.rdm") : Promise.reject(new Error("Bad file")),
    );
    await toPreview();
    expect(document.querySelector("[data-cv-error]")).toHaveTextContent("Bad file");
  });

  it("closes on Escape, a scrim click and its close button while idle (3.12.1)", async () => {
    const onClose = await toPreview();
    pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
    clickScrim();
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(closeButton() as HTMLButtonElement);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("cannot be closed while importing: no close button, Escape and the scrim do nothing", async () => {
    const onClose = await toPreview();
    fireEvent.click(screen.getByRole("button", { name: "Import 2 Entries" }));
    expect(closeButton()).toBeNull();
    pressEscape();
    clickScrim();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => finishImport(RESULT));
    expect(closeButton()).not.toBeNull();
  });
});
