import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Each lazy pack resolves only when its gate opens, so tests control load order.
const gates = vi.hoisted(() => {
  const make = () => {
    let open: () => void = () => undefined;
    let fail: (error: Error) => void = () => undefined;
    const promise = new Promise<void>((resolve, reject) => {
      open = resolve;
      fail = reject;
    });
    promise.catch(() => undefined);
    return { promise, open, fail };
  };
  return {
    phosphor: make(),
    hugeicons: make(),
    material: make(),
    fluent: make(),
    tabler: make(),
  };
});

async function fakePack(label: string) {
  const { SEMANTIC_ICON_NAMES } = await import("../types");
  const Fake = () => <svg data-pack={label} />;
  return { mapping: Object.fromEntries(SEMANTIC_ICON_NAMES.map((name) => [name, Fake])) };
}

// Lucide is the bundled default and never loads lazily, so it is not mocked.
vi.mock("../packs/hugeicons", async () => {
  await gates.hugeicons.promise;
  return fakePack("hugeicons");
});
vi.mock("../packs/tabler", async () => {
  await gates.tabler.promise;
  return fakePack("tabler");
});
vi.mock("../packs/phosphor", async () => {
  await gates.phosphor.promise;
  return fakePack("phosphor");
});
vi.mock("../packs/fluent", async () => {
  await gates.fluent.promise;
  return fakePack("fluent");
});
vi.mock("../packs/material", async () => {
  await gates.material.promise;
  return fakePack("material");
});

import { useIconPackStore, setIconPack, bootIconPack, getPackMapping, ICON_PACK_STORAGE_KEY } from "..";

const state = () => useIconPackStore.getState();
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function waitForPack(id: string) {
  await vi.waitFor(() => expect(state().pack).toBe(id));
}

describe("setIconPack", () => {
  it("starts on Lucide, loaded and ready, and mirrors it on <html>", () => {
    expect(state()).toMatchObject({ pack: "lucide", requested: "lucide", status: "ready", error: null });
    expect(state().loaded).toEqual(["lucide"]);
    expect(state().mapping).toBe(getPackMapping("lucide"));
    expect(document.documentElement.getAttribute("data-cv-icon-pack")).toBe("lucide");
  });

  it("ends fast pack switches on the last request", async () => {
    const first = setIconPack("hugeicons");
    const second = setIconPack("fluent");
    expect(state()).toMatchObject({ pack: "lucide", requested: "fluent", status: "loading" });
    expect(document.documentElement.getAttribute("data-cv-icon-pack")).toBe("lucide");

    gates.fluent.open();
    await second;
    expect(state()).toMatchObject({ pack: "fluent", requested: "fluent", status: "ready" });
    expect(document.documentElement.getAttribute("data-cv-icon-pack")).toBe("fluent");

    gates.hugeicons.open();
    await first;
    expect(state().pack).toBe("fluent");
    expect(state().mapping).toBe(getPackMapping("fluent"));
    expect(getPackMapping("hugeicons")).not.toBeNull();
    expect([...state().loaded].sort()).toEqual(["fluent", "hugeicons", "lucide"]);
    expect(document.documentElement.getAttribute("data-cv-icon-pack")).toBe("fluent");
  });

  it("drops a slow load when a cached pack is chosen meanwhile", async () => {
    const slow = setIconPack("phosphor");
    expect(state().status).toBe("loading");
    await setIconPack("lucide");
    expect(state()).toMatchObject({ pack: "lucide", requested: "lucide", status: "ready" });

    gates.phosphor.open();
    await slow;
    expect(state().pack).toBe("lucide");
    expect(document.documentElement.getAttribute("data-cv-icon-pack")).toBe("lucide");
  });

  it("keeps the current pack and reports an error when a load fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    gates.material.fail(new Error("chunk missing"));
    await setIconPack("material");
    expect(state()).toMatchObject({ pack: "lucide", requested: "material", status: "error" });
    expect(document.documentElement.getAttribute("data-cv-icon-pack")).toBe("lucide");
    expect(state().error).toEqual(expect.any(String));
    expect(state().error).not.toBe("");
    expect(getPackMapping("material")).toBeNull();
    expect(error).toHaveBeenCalled();
    error.mockRestore();

    await setIconPack("fluent");
    expect(state()).toMatchObject({ pack: "fluent", status: "ready", error: null });
  });
});

describe("pack events", () => {
  beforeEach(async () => {
    await setIconPack("lucide");
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("follows storage events for conduit-icon-pack", async () => {
    expect(ICON_PACK_STORAGE_KEY).toBe("conduit-icon-pack");
    window.dispatchEvent(new StorageEvent("storage", { key: "conduit-icon-pack", newValue: "fluent" }));
    await waitForPack("fluent");

    window.dispatchEvent(new StorageEvent("storage", { key: "conduit-theme", newValue: "lucide" }));
    await flush();
    expect(state().pack).toBe("fluent");

    window.dispatchEvent(new StorageEvent("storage", { key: "conduit-icon-pack", newValue: "bogus" }));
    await waitForPack("lucide");

    window.dispatchEvent(new StorageEvent("storage", { key: "conduit-icon-pack", newValue: "fluent" }));
    await waitForPack("fluent");

    // A value an older build stored is not a pack any more.
    window.dispatchEvent(new StorageEvent("storage", { key: "conduit-icon-pack", newValue: "codicons" }));
    await waitForPack("lucide");

    window.dispatchEvent(new StorageEvent("storage", { key: "conduit-icon-pack", newValue: "fluent" }));
    await waitForPack("fluent");
    window.dispatchEvent(new StorageEvent("storage", { key: "conduit-icon-pack", newValue: null }));
    await waitForPack("lucide");
    expect(document.documentElement.getAttribute("data-cv-icon-pack")).toBe("lucide");
  });

  it("follows conduit:theme-change with an iconPack", async () => {
    document.dispatchEvent(new CustomEvent("conduit:theme-change", { detail: { theme: "dark", iconPack: "hugeicons" } }));
    await waitForPack("hugeicons");

    document.dispatchEvent(new CustomEvent("conduit:theme-change", { detail: { theme: "light" } }));
    document.dispatchEvent(new CustomEvent("conduit:theme-change", { detail: { iconPack: "not-a-pack" } }));
    document.dispatchEvent(new CustomEvent("conduit:theme-change", { detail: { iconPack: "codicons" } }));
    document.dispatchEvent(new CustomEvent("conduit:theme-change"));
    await flush();
    expect(state().pack).toBe("hugeicons");
    expect(document.documentElement.getAttribute("data-cv-icon-pack")).toBe("hugeicons");

    document.dispatchEvent(new CustomEvent("conduit:theme-change", { detail: { iconPack: "lucide" } }));
    await waitForPack("lucide");
  });

  it("boots from localStorage and falls back to Lucide", async () => {
    localStorage.setItem("conduit-icon-pack", "fluent");
    await bootIconPack();
    expect(state().pack).toBe("fluent");

    localStorage.setItem("conduit-icon-pack", "codicons");
    await bootIconPack();
    expect(state().pack).toBe("lucide");

    await setIconPack("fluent");
    localStorage.removeItem("conduit-icon-pack");
    await bootIconPack();
    expect(state().pack).toBe("lucide");
  });

  it("boots Lucide synchronously and loads other packs lazily", async () => {
    localStorage.setItem("conduit-icon-pack", "tabler");
    const booting = bootIconPack();
    expect(state()).toMatchObject({ pack: "lucide", requested: "tabler", status: "loading" });
    expect(document.documentElement.getAttribute("data-cv-icon-pack")).toBe("lucide");
    gates.tabler.open();
    await booting;
    expect(state().pack).toBe("tabler");
    expect(document.documentElement.getAttribute("data-cv-icon-pack")).toBe("tabler");
  });

  it("boots when localStorage throws", async () => {
    await setIconPack("fluent");
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await bootIconPack();
    expect(state().pack).toBe("lucide");
    getItem.mockRestore();
    warn.mockRestore();
  });
});
