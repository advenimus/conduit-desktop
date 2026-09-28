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
    lucide: make(),
    tabler: make(),
    phosphor: make(),
    fluent: make(),
    material: make(),
  };
});

async function fakePack(label: string) {
  const { SEMANTIC_ICON_NAMES } = await import("../types");
  const Fake = () => <svg data-pack={label} />;
  return { mapping: Object.fromEntries(SEMANTIC_ICON_NAMES.map((name) => [name, Fake])) };
}

vi.mock("../packs/lucide", async () => {
  await gates.lucide.promise;
  return fakePack("lucide");
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
  it("starts on Codicons, loaded and ready", () => {
    expect(state()).toMatchObject({ pack: "codicons", requested: "codicons", status: "ready", error: null });
    expect(state().loaded).toEqual(["codicons"]);
    expect(state().mapping).toBe(getPackMapping("codicons"));
  });

  it("ends fast pack switches on the last request", async () => {
    const first = setIconPack("lucide");
    const second = setIconPack("fluent");
    expect(state()).toMatchObject({ pack: "codicons", requested: "fluent", status: "loading" });

    gates.fluent.open();
    await second;
    expect(state()).toMatchObject({ pack: "fluent", requested: "fluent", status: "ready" });

    gates.lucide.open();
    await first;
    expect(state().pack).toBe("fluent");
    expect(state().mapping).toBe(getPackMapping("fluent"));
    expect(getPackMapping("lucide")).not.toBeNull();
    expect([...state().loaded].sort()).toEqual(["codicons", "fluent", "lucide"]);
  });

  it("drops a slow load when a cached pack is chosen meanwhile", async () => {
    const slow = setIconPack("phosphor");
    expect(state().status).toBe("loading");
    await setIconPack("codicons");
    expect(state()).toMatchObject({ pack: "codicons", requested: "codicons", status: "ready" });

    gates.phosphor.open();
    await slow;
    expect(state().pack).toBe("codicons");
  });

  it("keeps the current pack and reports an error when a load fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    gates.material.fail(new Error("chunk missing"));
    await setIconPack("material");
    expect(state()).toMatchObject({ pack: "codicons", requested: "material", status: "error" });
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
    await setIconPack("codicons");
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
    await waitForPack("codicons");

    window.dispatchEvent(new StorageEvent("storage", { key: "conduit-icon-pack", newValue: "lucide" }));
    await waitForPack("lucide");

    window.dispatchEvent(new StorageEvent("storage", { key: "conduit-icon-pack", newValue: null }));
    await waitForPack("codicons");
  });

  it("follows conduit:theme-change with an iconPack", async () => {
    document.dispatchEvent(new CustomEvent("conduit:theme-change", { detail: { theme: "dark", iconPack: "lucide" } }));
    await waitForPack("lucide");

    document.dispatchEvent(new CustomEvent("conduit:theme-change", { detail: { theme: "light" } }));
    document.dispatchEvent(new CustomEvent("conduit:theme-change", { detail: { iconPack: "not-a-pack" } }));
    document.dispatchEvent(new CustomEvent("conduit:theme-change"));
    await flush();
    expect(state().pack).toBe("lucide");

    document.dispatchEvent(new CustomEvent("conduit:theme-change", { detail: { iconPack: "codicons" } }));
    await waitForPack("codicons");
  });

  it("boots from localStorage and falls back to Codicons", async () => {
    localStorage.setItem("conduit-icon-pack", "fluent");
    await bootIconPack();
    expect(state().pack).toBe("fluent");

    localStorage.setItem("conduit-icon-pack", "not-a-pack");
    await bootIconPack();
    expect(state().pack).toBe("codicons");

    await setIconPack("lucide");
    localStorage.removeItem("conduit-icon-pack");
    await bootIconPack();
    expect(state().pack).toBe("codicons");
  });

  it("boots Codicons synchronously and loads other packs lazily", async () => {
    localStorage.setItem("conduit-icon-pack", "tabler");
    const booting = bootIconPack();
    expect(state()).toMatchObject({ pack: "codicons", requested: "tabler", status: "loading" });
    gates.tabler.open();
    await booting;
    expect(state().pack).toBe("tabler");
  });

  it("boots when localStorage throws", async () => {
    await setIconPack("lucide");
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await bootIconPack();
    expect(state().pack).toBe("codicons");
    getItem.mockRestore();
    warn.mockRestore();
  });
});
