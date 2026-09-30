import { describe, it, expect } from "vitest";
import {
  appearanceRequest,
  canUseVersion,
  cycleText,
  displayValue,
  editDeleteText,
  enteredValueChoice,
  folderDeleteText,
  initialAppearanceSelections,
  keepBothCopyNames,
  MASKED_VALUE,
  offersEnteredValue,
  versionCaption,
  versionText,
} from "../conflict-logic";
import type { ConflictItem, ConflictVersion, FieldConflict } from "../../../types/sync";

function version(id: string, over: Partial<ConflictVersion> = {}): ConflictVersion {
  return {
    id,
    source: { kind: "device", deviceUuid: "d", deviceName: `Device ${id}` },
    timeMs: 0,
    value: `value ${id}`,
    masked: false,
    provisional: false,
    undecryptable: false,
    redacted: false,
    olderApp: false,
    ...over,
  };
}

function field(versions: ConflictVersion[], over: Partial<FieldConflict> = {}): FieldConflict {
  return {
    key: { tbl: 1, rowId: "e1", reg: "notes" },
    label: "Notes",
    cls: "prompt",
    secret: false,
    versions,
    staleRevert: false,
    keepBothOffered: true,
    invariantGuard: false,
    snoozeKey: "s1",
    ...over,
  };
}

describe("version display", () => {
  it("masks secrets until revealed and names erased or locked values", () => {
    expect(displayValue(version("a", { masked: true, value: null }))).toBe(MASKED_VALUE);
    expect(displayValue(version("a", { masked: true, value: null }), "hunter2")).toBe("hunter2");
    expect(displayValue(version("a", { redacted: true }))).toBe("Erased");
    expect(displayValue(version("a", { undecryptable: true }))).toBe("Needs your old password");
    expect(displayValue(version("a", { value: null }))).toBe("(empty)");
  });

  it("cannot pick undecryptable or erased versions", () => {
    expect(canUseVersion(version("a"))).toBe(true);
    expect(canUseVersion(version("a", { undecryptable: true }))).toBe(false);
    expect(canUseVersion(version("a", { redacted: true }))).toBe(false);
  });

  it("captions older-app and dated versions", () => {
    expect(versionCaption(version("a", { source: { kind: "older-app" } }))).toBe("Older Conduit app");
    expect(versionCaption(version("a", { timeMs: Date.UTC(2026, 8, 24, 10, 2) }))).toMatch(/^Device a, /);
  });
});

describe("enteredValueChoice", () => {
  it("sends secrets as plaintext", () => {
    expect(enteredValueChoice(field([], { secret: true }), "pw")).toEqual({ ok: true, choice: { kind: "value", value: null, plaintext: "pw" } });
  });

  it("parses whole numbers for numeric fields and rejects the rest", () => {
    const port = field([version("a", { value: 22 }), version("b", { value: 2222 })], { label: "Port" });
    expect(enteredValueChoice(port, "8022")).toEqual({ ok: true, choice: { kind: "value", value: 8022 } });
    expect(enteredValueChoice(port, "")).toEqual({ ok: true, choice: { kind: "value", value: null } });
    expect(enteredValueChoice(port, "22.5")).toEqual({ ok: false, error: "Enter a whole number." });
  });

  it("keeps text as text", () => {
    expect(enteredValueChoice(field([version("a")]), "hello")).toEqual({ ok: true, choice: { kind: "value", value: "hello" } });
  });

  it("stores typed text for a text setting as a JSON string, so the entry config stays valid JSON", () => {
    const doc = field([version("a", { value: '"alpha runbook"' }), version("b", { value: '"beta runbook"' })], {
      key: { tbl: 1, rowId: "e1", reg: "config.content" },
    });
    const entered = enteredValueChoice(doc, 'hello "world"\nline 2');
    expect(entered).toEqual({ ok: true, choice: { kind: "value", value: JSON.stringify('hello "world"\nline 2') } });
    if (entered.ok) expect(() => JSON.parse(`{"content":${String(entered.choice.kind === "value" ? entered.choice.value : "")}}`)).not.toThrow();
  });

  it("asks for valid JSON for a setting that is not text", () => {
    const opts = field([version("a", { value: '{"x":1}' }), version("b", { value: '{"x":2}' })], { key: { tbl: 1, rowId: "e1", reg: "config.opts" } });
    expect(enteredValueChoice(opts, '{"x":3}')).toEqual({ ok: true, choice: { kind: "value", value: '{"x":3}' } });
    expect(enteredValueChoice(opts, "hello world")).toEqual({ ok: false, error: "Enter a valid JSON value." });
  });
});

describe("versionText (spec 7.2)", () => {
  it("shows notes and documents in full, and a document as its text", () => {
    const prefix = "x".repeat(139);
    const notes = field([version("a", { value: `${prefix} one` }), version("b", { value: `${prefix} two` })]);
    const [a, b] = notes.versions.map((v) => versionText(notes, v));
    expect(a).not.toBe(b);
    expect(a.endsWith("one")).toBe(true);
    const doc = field([version("a", { value: JSON.stringify("# Steps\n1. ssh in") })], { key: { tbl: 1, rowId: "e1", reg: "config.content" } });
    expect(versionText(doc, doc.versions[0]!)).toBe("# Steps\n1. ssh in");
  });

  it("names places, links and flags instead of raw ids", () => {
    const names = (kind: "folder" | "entry", id: string) => (kind === "folder" && id === "f1" ? "Servers" : kind === "entry" && id === "c1" ? "Prod login" : undefined);
    const loc = field([version("a", { value: "r" }), version("b", { value: "f:f1" })], { key: { tbl: 1, rowId: "e1", reg: "container" } });
    expect(loc.versions.map((v) => versionText(loc, v, null, names))).toEqual(["Top level", "Folder 'Servers'"]);
    const cred = field([version("a", { value: "c1" })], { key: { tbl: 1, rowId: "e1", reg: "credential_id" } });
    expect(versionText(cred, cred.versions[0]!, null, names)).toBe("Prod login");
    const fav = field([version("a", { value: 0 }), version("b", { value: 1 })], { key: { tbl: 1, rowId: "e1", reg: "is_favorite" } });
    expect(fav.versions.map((v) => versionText(fav, v))).toEqual(["No", "Yes"]);
    const tag = field([version("a", { value: null }), version("b", { value: 1 })], { key: { tbl: 1, rowId: "e1", reg: "tag:prod" } });
    expect(tag.versions.map((v) => versionText(tag, v))).toEqual(["Not tagged", "Tagged"]);
    expect(offersEnteredValue(loc)).toBe(false);
    expect(offersEnteredValue(cred)).toBe(false);
    expect(offersEnteredValue(tag)).toBe(false);
    expect(offersEnteredValue(field([version("a")]))).toBe(true);
  });
});

describe("keepBothCopyNames", () => {
  it("names one copy per other usable version and keeps names unique", () => {
    const f = field([
      version("keep", { provisional: true }),
      version("b", { source: { kind: "device", deviceUuid: "x", deviceName: "iPhone" } }),
      version("c", { source: { kind: "device", deviceUuid: "y", deviceName: "iPhone" } }),
      version("d", { undecryptable: true }),
    ]);
    expect(keepBothCopyNames("Doc", f)).toEqual({ b: "Doc (from iPhone)", c: "Doc (from iPhone) 2" });
  });
});

describe("appearance", () => {
  const item: Extract<ConflictItem, { kind: "appearance" }> = {
    kind: "appearance",
    row: { tbl: 1, rowId: "e1" },
    fields: [],
    newest: { icon: "v2", color: "v4" },
    snoozeKey: "s",
  };

  it("preselects Keep newest and sends keep-newest when unchanged", () => {
    const sel = initialAppearanceSelections(item);
    expect(sel).toEqual({ icon: "v2", color: "v4" });
    expect(appearanceRequest(item, sel)).toEqual({ kind: "appearance", row: item.row, choices: "keep-newest" });
  });

  it("sends the per-field choices when the user changed one", () => {
    const req = appearanceRequest(item, { icon: "v1", color: "v4" });
    expect(req).toEqual({ kind: "appearance", row: item.row, choices: { icon: "v1", color: "v4" } });
  });
});

describe("structural texts", () => {
  it("words edit-versus-delete, folder delete and cycles", () => {
    const deleted = [version("d", { source: { kind: "device", deviceUuid: "m", deviceName: "MacBook" } })];
    const edited = [version("e", { source: { kind: "device", deviceUuid: "i", deviceName: "iPhone" } })];
    expect(editDeleteText({ kind: "edit-delete", row: { tbl: 1, rowId: "e" }, deleted, edited, snoozeKey: "s" })).toBe(
      "Deleted on MacBook; edited on iPhone.",
    );
    const folder: Extract<ConflictItem, { kind: "folder-delete" }> = {
      kind: "folder-delete",
      folder: { tbl: 2, rowId: "f" },
      deleted,
      changedItems: [{ tbl: 1, rowId: "a" }, { tbl: 1, rowId: "b" }],
      snoozeKey: "s",
    };
    expect(folderDeleteText(folder, "Servers")).toBe("Folder 'Servers' was deleted on MacBook; 2 items in it were changed on another device.");
    expect(cycleText({ kind: "cycle", tbl: 2, rowIds: ["x", "y"], movedToRoot: "x" }, ["X", "Y"])).toBe(
      "Folders 'X' and 'Y' were moved into each other on different devices.",
    );
  });
});
