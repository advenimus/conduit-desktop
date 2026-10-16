import { afterEach, describe, expect, it } from "vitest";
import {
  blankAreaMenu,
  headerCreateMenu,
  newEntrySubmenu,
  newHereSubmenu,
  parseCreateAction,
  readNewEntryRequest,
  runCreateAction,
} from "../createMenu";
import { SEMANTIC_ICON_NAMES } from "../../../lib/icons";
import type { PopupMenuItem } from "../../../utils/contextMenu";

const TYPED_IDS = [
  "new_entry:ssh",
  "new_entry:rdp",
  "new_entry:vnc",
  "new_entry:web",
  "sep",
  "new_entry:document",
  "sep",
  "new_entry:command",
  "sep",
  "new_entry:credential:generic",
  "new_entry:credential:ssh_key",
];

const shape = (items: PopupMenuItem[]) => items.map((i) => (i.type === "separator" ? "sep" : i.id));

function captureEvents() {
  const events: Array<{ type: string; detail: unknown }> = [];
  const record = (e: Event) => events.push({ type: e.type, detail: (e as CustomEvent).detail });
  document.addEventListener("conduit:new-entry", record);
  document.addEventListener("conduit:new-folder", record);
  const stop = () => {
    document.removeEventListener("conduit:new-entry", record);
    document.removeEventListener("conduit:new-folder", record);
  };
  return { events, stop };
}

let stopCapture: (() => void) | null = null;
afterEach(() => {
  stopCapture?.();
  stopCapture = null;
});

describe("create menu items", () => {
  it("nests every entry type under New Entry, grouped like the type picker", () => {
    const menu = newEntrySubmenu();
    expect(menu).toMatchObject({ id: "new_entry", label: "New Entry", icon: "plus" });
    expect(shape(menu.children!)).toEqual(TYPED_IDS);
    expect(menu.children!.filter((i) => !i.type).map((i) => i.label)).toEqual([
      "SSH", "RDP", "VNC", "Web", "Document", "Command", "Password", "SSH Key",
    ]);
  });

  it("gives every item a known menu icon", () => {
    const all = [...blankAreaMenu(true), ...headerCreateMenu(), newHereSubmenu("In This Folder")];
    const icons = all.flatMap((i) => [i, ...(i.children ?? [])]).filter((i) => !i.type).map((i) => i.icon);
    for (const icon of icons) expect(SEMANTIC_ICON_NAMES).toContain(icon);
  });

  it("offers New Entry and New Folder on blank space, and only a view-only note to viewers", () => {
    expect(shape(blankAreaMenu(true))).toEqual(["new_entry", "new_folder"]);
    expect(blankAreaMenu(true)[1]).toMatchObject({ label: "New Folder", icon: "folderPlus" });
    expect(blankAreaMenu(false)).toEqual([{ id: "view_only", label: "View-only access", type: "header" }]);
  });

  it("lists the typed entries flat in the header menu, then the type picker and New Folder", () => {
    const menu = headerCreateMenu();
    expect(shape(menu)).toEqual([...TYPED_IDS, "sep", "new_entry:pick", "new_folder"]);
    expect(menu.find((i) => i.id === "new_entry:pick")?.label).toBe("Choose Type…");
    expect(menu.every((i) => !i.children)).toBe(true);
  });

  it("builds a create submenu for an entry's folder with the types and New Folder", () => {
    const menu = newHereSubmenu("New in This Folder");
    expect(menu).toMatchObject({ id: "new_here", label: "New in This Folder" });
    expect(shape(menu.children!)).toEqual([...TYPED_IDS, "sep", "new_folder"]);
  });
});

describe("parseCreateAction", () => {
  it("maps menu ids back to actions", () => {
    expect(parseCreateAction("new_entry:ssh")).toEqual({ kind: "entry", type: "ssh" });
    expect(parseCreateAction("new_entry:credential:ssh_key")).toEqual({ kind: "entry", type: "credential", credentialType: "ssh_key" });
    expect(parseCreateAction("new_entry:credential:generic")).toEqual({ kind: "entry", type: "credential", credentialType: "generic" });
    expect(parseCreateAction("new_entry:pick")).toEqual({ kind: "pickType" });
    expect(parseCreateAction("new_folder")).toEqual({ kind: "folder" });
  });

  it("ignores ids that are not create items", () => {
    for (const id of [null, "", "new_entry", "new_entry:ftp", "new_entry:credential:nope", "rename", "view_only"]) {
      expect(parseCreateAction(id)).toBeNull();
    }
  });
});

describe("runCreateAction", () => {
  it("sends the new-entry event with the type, credential type and target folder", () => {
    const { events, stop } = captureEvents();
    stopCapture = stop;
    runCreateAction({ kind: "entry", type: "rdp" }, "f1");
    runCreateAction({ kind: "entry", type: "credential", credentialType: "ssh_key" }, null);
    runCreateAction({ kind: "pickType" }, "f2");
    expect(events).toEqual([
      { type: "conduit:new-entry", detail: { folderId: "f1", type: "rdp" } },
      { type: "conduit:new-entry", detail: { folderId: null, type: "credential", credentialType: "ssh_key" } },
      { type: "conduit:new-entry", detail: { folderId: "f2" } },
    ]);
  });

  it("sends the new-folder event with the parent folder", () => {
    const { events, stop } = captureEvents();
    stopCapture = stop;
    runCreateAction({ kind: "folder" }, "f1");
    runCreateAction({ kind: "folder" }, null);
    expect(events).toEqual([
      { type: "conduit:new-folder", detail: { parentId: "f1" } },
      { type: "conduit:new-folder", detail: { parentId: null } },
    ]);
  });
});

describe("readNewEntryRequest", () => {
  it("keeps a known type, credential type and folder", () => {
    expect(readNewEntryRequest({ folderId: "f1", type: "ssh" })).toEqual({ folderId: "f1", type: "ssh" });
    expect(readNewEntryRequest({ folderId: null, type: "credential", credentialType: "ssh_key" })).toEqual({
      folderId: null, type: "credential", credentialType: "ssh_key",
    });
  });

  it("opens on the type picker at the top level when the event carries nothing usable", () => {
    for (const detail of [undefined, null, "f1", 7, {}, { folderId: 3 }, { type: "ftp" }]) {
      expect(readNewEntryRequest(detail)).toEqual({ folderId: null });
    }
  });

  it("drops a credential type on anything but a credential, and an unknown one", () => {
    expect(readNewEntryRequest({ type: "ssh", credentialType: "ssh_key" })).toEqual({ folderId: null, type: "ssh" });
    expect(readNewEntryRequest({ type: "credential", credentialType: "nope" })).toEqual({ folderId: null, type: "credential" });
  });
});
