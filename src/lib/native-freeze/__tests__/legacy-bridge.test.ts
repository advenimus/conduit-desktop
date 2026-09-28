import { describe, it, expect, afterEach } from "vitest";
import { createFreezeRegistry } from "../registry";
import { installLegacyBridge, LEGACY_FREEZE_EVENTS } from "../legacy-bridge";
import { freezeHolders, isFrozen } from "..";

function emit(target: EventTarget, type: string, detail: unknown) {
  target.dispatchEvent(new CustomEvent(type, { detail }));
}

describe("installLegacyBridge", () => {
  it("listens for the three legacy events", () => {
    expect(LEGACY_FREEZE_EVENTS).toEqual([
      "conduit:overlay-change",
      "conduit:sidebar-overlay-change",
      "conduit:drag-change",
    ]);
  });

  it("maps each legacy event to one legacy holder", () => {
    const target = new EventTarget();
    const registry = createFreezeRegistry();
    installLegacyBridge(target, registry.acquire);

    emit(target, "conduit:overlay-change", true);
    emit(target, "conduit:overlay-change", true);
    expect(registry.holders()).toEqual([expect.objectContaining({ reason: "legacy", label: "conduit:overlay-change" })]);

    emit(target, "conduit:sidebar-overlay-change", true);
    emit(target, "conduit:drag-change", true);
    expect(registry.holders().map((h) => h.label)).toEqual([
      "conduit:overlay-change",
      "conduit:sidebar-overlay-change",
      "conduit:drag-change",
    ]);

    emit(target, "conduit:overlay-change", false);
    emit(target, "conduit:drag-change", false);
    expect(registry.holders().map((h) => h.label)).toEqual(["conduit:sidebar-overlay-change"]);

    emit(target, "conduit:sidebar-overlay-change", false);
    expect(registry.isFrozen()).toBe(false);
  });

  it("ignores a release event when nothing is held", () => {
    const target = new EventTarget();
    const registry = createFreezeRegistry();
    installLegacyBridge(target, registry.acquire);
    emit(target, "conduit:overlay-change", false);
    expect(registry.isFrozen()).toBe(false);
  });

  it("reads a missing or odd detail as a boolean", () => {
    const target = new EventTarget();
    const registry = createFreezeRegistry();
    installLegacyBridge(target, registry.acquire);
    emit(target, "conduit:drag-change", "yes");
    expect(registry.isFrozen()).toBe(true);
    target.dispatchEvent(new Event("conduit:drag-change"));
    expect(registry.isFrozen()).toBe(false);
  });

  it("releases its holders and stops listening when uninstalled", () => {
    const target = new EventTarget();
    const registry = createFreezeRegistry();
    const uninstall = installLegacyBridge(target, registry.acquire);
    emit(target, "conduit:overlay-change", true);
    uninstall();
    expect(registry.isFrozen()).toBe(false);
    emit(target, "conduit:overlay-change", true);
    expect(registry.isFrozen()).toBe(false);
  });
});

describe("the bridge installed on document", () => {
  afterEach(() => {
    for (const type of LEGACY_FREEZE_EVENTS) emit(document, type, false);
    expect(freezeHolders()).toEqual([]);
  });

  it("keeps old dispatchers working", () => {
    emit(document, "conduit:overlay-change", true);
    expect(isFrozen()).toBe(true);
    expect(freezeHolders()).toEqual([expect.objectContaining({ reason: "legacy", label: "conduit:overlay-change" })]);
    emit(document, "conduit:overlay-change", false);
    expect(isFrozen()).toBe(false);
  });
});
