import { describe, expect, it } from "vitest";
import { searchQuick } from "../quickSearch";
import { entry, folder } from "../../__tests__/fixtures";

const ENTRIES = [
  entry({ id: "1", name: "web-02", entry_type: "ssh", host: "web02.example.com" }),
  entry({ id: "2", name: "web-01", entry_type: "ssh", host: "web01.example.com" }),
  entry({ id: "3", name: "Intranet web", entry_type: "web", host: "https://intranet.local" }),
  entry({ id: "4", name: "DC01", entry_type: "rdp", host: "10.0.0.10", tags: ["Web-Tier"] }),
  entry({ id: "5", name: "Build box", entry_type: "vnc", host: "build.web.local" }),
  entry({ id: "6", name: "Domain Admin", entry_type: "credential" }),
  entry({ id: "7", name: "Runbook", entry_type: "document", tags: ["ops"] }),
];
const FOLDERS = [folder({ id: "f1", name: "Webfarm" }), folder({ id: "f2", name: "Staging" })];

const names = (query: string, limit = 8) => searchQuick(query, ENTRIES, FOLDERS, limit).map((r) => r.name);

describe("searchQuick", () => {
  it("returns nothing for an empty or blank query", () => {
    expect(searchQuick("", ENTRIES, FOLDERS, 8)).toEqual([]);
    expect(searchQuick("   ", ENTRIES, FOLDERS, 8)).toEqual([]);
  });

  it("ranks name prefix, then name contains, then host or tag, ties by name", () => {
    expect(names("web")).toEqual(["web-01", "web-02", "Webfarm", "Intranet web", "Build box", "DC01"]);
  });

  it("is case-insensitive and trims the query", () => {
    expect(names("  WEB-0 ")).toEqual(["web-01", "web-02"]);
  });

  it("matches tags and includes credentials and documents", () => {
    expect(names("ops")).toEqual(["Runbook"]);
    expect(names("admin")).toEqual(["Domain Admin"]);
  });

  it("matches folders by name only and marks them as folders", () => {
    const results = searchQuick("stag", ENTRIES, FOLDERS, 8);
    expect(results).toEqual([expect.objectContaining({ kind: "folder", id: "f2", name: "Staging" })]);
  });

  it("stops at the limit", () => {
    expect(names("web", 2)).toEqual(["web-01", "web-02"]);
  });
});
