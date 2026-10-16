import { describe, it, expect } from "vitest";
import { isPrereleaseVersion, updateCheckToast, whatsNewAutoOpen } from "../updateChannel";

const release = (version: string) => ({ version, date: "2026-10-16", title: "t", summary: "s", highlights: [], hasMedia: false });

describe("isPrereleaseVersion (shared with the main process)", () => {
  it("tells beta builds from regular ones", () => {
    expect(isPrereleaseVersion("0.19.0-beta.1")).toBe(true);
    expect(isPrereleaseVersion("0.19.0")).toBe(false);
  });
});

describe("updateCheckToast", () => {
  it("says up to date when nothing newer was found", () => {
    expect(updateCheckToast(null, "0.18.1")).toEqual({ title: "Conduit is up to date", message: "You have version 0.18.1." });
  });

  it("says the update is downloading", () => {
    expect(updateCheckToast({ version: "0.19.0-beta.1", downloaded: false }, "0.18.1")).toEqual({
      title: "Conduit 0.19.0-beta.1 is available",
      message: "It's downloading now. You'll be asked to restart when it's ready.",
    });
  });

  it("says a downloaded update is ready", () => {
    expect(updateCheckToast({ version: "0.19.0", downloaded: true }, "0.18.1")).toEqual({
      title: "Conduit 0.19.0 is ready",
      message: "Restart Conduit to install it.",
    });
  });
});

describe("whatsNewAutoOpen", () => {
  it("skips a version already seen", () => {
    expect(whatsNewAutoOpen("0.18.1", "0.18.1", null)).toBe("skip");
    expect(whatsNewAutoOpen("0.19.0-beta.1", "0.19.0-beta.1", [release("0.19.0-beta.1")])).toBe("skip");
  });

  it("opens for a regular release without looking at the manifest", () => {
    expect(whatsNewAutoOpen("0.18.1", "0.18.0", null)).toBe("open");
    expect(whatsNewAutoOpen("0.18.1", null, [])).toBe("open");
  });

  it("opens for a beta that has its own manifest entry", () => {
    expect(whatsNewAutoOpen("0.19.0-beta.1", "0.18.1", [release("0.19.0-beta.1"), release("0.18.1")])).toBe("open");
  });

  it("marks a beta without a manifest entry as seen instead of opening", () => {
    expect(whatsNewAutoOpen("0.19.0-beta.1", "0.18.1", [release("0.18.1")])).toBe("mark-seen");
  });

  it("tries again next launch when the manifest could not load for a beta", () => {
    expect(whatsNewAutoOpen("0.19.0-beta.1", "0.18.1", null)).toBe("skip");
  });
});
