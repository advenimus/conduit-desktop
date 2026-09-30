import { describe, expect, it } from "vitest";
import type { ReachabilityResult } from "../../../../types/dashboard";
import { entry, folder, minutesAgo } from "../../__tests__/fixtures";
import {
  checkAllIds,
  collectFolderItems,
  filterFolderItems,
  openAllIds,
  rowDescription,
  sortFolderItems,
  type FolderListItem,
  type SortContext,
} from "../folderList";

const FOLDERS = [
  folder({ id: "prod", name: "Production" }),
  folder({ id: "web", name: "Web", parent_id: "prod" }),
  folder({ id: "edge", name: "Edge", parent_id: "web" }),
  folder({ id: "other", name: "Other" }),
];

const ENTRIES = [
  entry({ id: "w1", name: "web-01", entry_type: "ssh", folder_id: "prod", host: "web01.example.com", tags: ["linux"] }),
  entry({ id: "w2", name: "web-02", entry_type: "ssh", folder_id: "web", host: "web02.example.com" }),
  entry({ id: "e1", name: "edge-lb", entry_type: "web", folder_id: "edge", host: "https://lb.example.com" }),
  entry({ id: "dc", name: "DC01", entry_type: "rdp", folder_id: "prod", host: "10.0.0.10" }),
  entry({ id: "cred", name: "Domain Admin", entry_type: "credential", folder_id: "web" }),
  entry({ id: "doc", name: "Runbook", entry_type: "document", folder_id: "prod" }),
  entry({ id: "cmd", name: "Deploy", entry_type: "command", folder_id: "prod" }),
  entry({ id: "out", name: "elsewhere", entry_type: "ssh", folder_id: "other", host: "x" }),
  entry({ id: "root", name: "root-level", entry_type: "ssh", folder_id: null, host: "y" }),
];

const items = () => collectFolderItems("prod", ENTRIES, FOLDERS);
const byId = (list: readonly FolderListItem[], id: string) => list.find((i) => i.entry.id === id)!;
const names = (list: readonly FolderListItem[]) => list.map((i) => i.entry.name);
const EMPTY_CTX: SortContext = { lastConnected: new Map(), results: {} };

const checked = (entryId: string, status: ReachabilityResult["status"]): ReachabilityResult => ({
  entryId,
  status,
  host: null,
  port: null,
  latencyMs: null,
  checkedAt: minutesAgo(1),
});

describe("collectFolderItems", () => {
  it("lists every entry in the folder and all its sub-folders with the path below the folder", () => {
    const list = items();
    expect(names(list).sort()).toEqual(["DC01", "Deploy", "Domain Admin", "Runbook", "edge-lb", "web-01", "web-02"].sort());
    expect(byId(list, "w1").subPath).toEqual([]);
    expect(byId(list, "w2").subPath).toEqual(["Web"]);
    expect(byId(list, "e1").subPath).toEqual(["Web", "Edge"]);
  });

  it("survives a folder cycle", () => {
    const cyclic = [folder({ id: "a", name: "A", parent_id: "b" }), folder({ id: "b", name: "B", parent_id: "a" })];
    const list = collectFolderItems("a", [entry({ id: "x", name: "x", entry_type: "ssh", folder_id: "b" })], cyclic);
    expect(list.map((i) => i.subPath)).toEqual([["B"]]);
  });
});

describe("rowDescription", () => {
  it("joins the host of connection types and the sub-folder path", () => {
    const list = items();
    expect(rowDescription(byId(list, "w1"))).toBe("web01.example.com");
    expect(rowDescription(byId(list, "w2"))).toBe("web02.example.com · in Web");
    expect(rowDescription(byId(list, "e1"))).toBe("https://lb.example.com · in Web / Edge");
    expect(rowDescription(byId(list, "cred"))).toBe("in Web");
    expect(rowDescription(byId(list, "doc"))).toBeNull();
  });
});

describe("filterFolderItems", () => {
  it("matches name, host and tags, case-insensitive and trimmed", () => {
    const list = items();
    expect(names(filterFolderItems(list, "  WEB-0 "))).toEqual(["web-01", "web-02"]);
    expect(names(filterFolderItems(list, "10.0.0"))).toEqual(["DC01"]);
    expect(names(filterFolderItems(list, "LINUX"))).toEqual(["web-01"]);
    expect(filterFolderItems(list, "nothing-like-this")).toEqual([]);
    expect(filterFolderItems(list, "")).toHaveLength(list.length);
  });
});

describe("sortFolderItems", () => {
  it("sorts by name A to Z", () => {
    expect(names(sortFolderItems(items(), "name", EMPTY_CTX))).toEqual([
      "DC01",
      "Deploy",
      "Domain Admin",
      "edge-lb",
      "Runbook",
      "web-01",
      "web-02",
    ]);
  });

  it("sorts by type label, then name", () => {
    expect(names(sortFolderItems(items(), "type", EMPTY_CTX))).toEqual([
      "Deploy",
      "Domain Admin",
      "Runbook",
      "DC01",
      "web-01",
      "web-02",
      "edge-lb",
    ]);
  });

  it("sorts by last connected, newest first, never connected last by name", () => {
    const lastConnected = new Map([
      ["w2", minutesAgo(60)],
      ["dc", minutesAgo(5)],
    ]);
    expect(names(sortFolderItems(items(), "last-connected", { lastConnected, results: {} })).slice(0, 4)).toEqual([
      "DC01",
      "web-02",
      "Deploy",
      "Domain Admin",
    ]);
  });

  it("sorts by status: reachable, refused, timeout, unreachable, not found, then unchecked, each by name", () => {
    const results = {
      w1: checked("w1", "timeout"),
      w2: checked("w2", "reachable"),
      e1: checked("e1", "not_found"),
      dc: checked("dc", "refused"),
      doc: checked("doc", "unreachable"),
    };
    expect(names(sortFolderItems(items(), "status", { lastConnected: new Map(), results }))).toEqual([
      "web-02",
      "DC01",
      "web-01",
      "Runbook",
      "edge-lb",
      "Deploy",
      "Domain Admin",
    ]);
  });

  it("does not change its input", () => {
    const list = items();
    const before = names(list);
    sortFolderItems(list, "name", EMPTY_CTX);
    expect(names(list)).toEqual(before);
  });
});

describe("Open all and Check all targets", () => {
  it("opens ssh, rdp, vnc and web entries that are not locked, skipping commands, documents and credentials", () => {
    const list = sortFolderItems(items(), "name", EMPTY_CTX);
    expect(openAllIds(list, (id) => id === "w2")).toEqual(["dc", "e1", "w1"]);
  });

  it("checks entries with a host in list order, at most the limit", () => {
    const list = sortFolderItems(items(), "name", EMPTY_CTX);
    expect(checkAllIds(list, 50)).toEqual({ ids: ["dc", "e1", "w1", "w2"], capped: false });
    expect(checkAllIds(list, 3)).toEqual({ ids: ["dc", "e1", "w1"], capped: true });
  });
});
