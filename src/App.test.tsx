import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

type AuthMode = "authenticated" | "local" | "cached" | null;

const invoke = vi.fn<(channel: string, args?: unknown) => Promise<unknown>>();

// An open vault: the startup check finds it unlocked and leaves the hub for the main layout.
const OPEN_VAULT: Readonly<Record<string, unknown>> = {
  vault_exists: true,
  vault_is_unlocked: true,
  vault_get_path: "/tmp/Acme.conduit",
  settings_get: {},
  entry_list: [],
  folder_list: [],
};

function stubElectron(authMode: AuthMode, { pending, replies = {} }: { pending?: Promise<unknown>; replies?: Readonly<Record<string, unknown>> } = {}): void {
  invoke.mockImplementation((channel) => {
    if (channel === "auth_initialize") {
      return pending ?? Promise.resolve({ user: null, profile: null, isAuthenticated: false, emailConfirmed: false, authMode });
    }
    return Promise.resolve(replies[channel] ?? null);
  });
  vi.stubGlobal("electron", { platform: "darwin", invoke, send: vi.fn(), on: vi.fn(() => () => {}), removeListener: vi.fn() });
}

type Modules = {
  App: typeof import("./App").default;
  useAuthStore: typeof import("./stores/authStore").useAuthStore;
  useVaultStore: typeof import("./stores/vaultStore").useVaultStore;
};
let modules: Modules;

// Loaded once, after a stub: some stores call window.electron while their module loads. Loading App's
// whole module graph takes seconds on a busy machine, so it happens here and not inside a test.
beforeAll(async () => {
  stubElectron(null);
  const [app, auth, vault] = await Promise.all([import("./App"), import("./stores/authStore"), import("./stores/vaultStore")]);
  modules = { App: app.default, useAuthStore: auth.useAuthStore, useVaultStore: vault.useVaultStore };
  vi.unstubAllGlobals();
}, 60_000);

// The stores are module singletons, so each render starts from the state a fresh launch has.
function renderApp(): void {
  const { App, useAuthStore, useVaultStore } = modules;
  useAuthStore.setState({ isInitializing: true, isAuthenticated: false, authMode: null, user: null, profile: null, error: null });
  useVaultStore.setState({ showVaultHub: true, autoConnectInProgress: false, isUnlocked: false });
  render(<App />);
}

afterEach(() => {
  cleanup();
  invoke.mockReset();
  vi.unstubAllGlobals();
});

describe("App startup", () => {
  it("shows the loading screen, whose whole text is Loading..., while auth initializes", async () => {
    stubElectron(null, { pending: new Promise(() => {}) });
    renderApp();
    expect(document.body.textContent).toBe("Loading...");
  });

  it("then shows the sign-in screen when the stubbed auth has no session", async () => {
    stubElectron(null);
    renderApp();
    expect(await screen.findByRole("heading", { name: "Conduit" })).toBeInTheDocument();
    expect(screen.getByText("Remote Connection Manager")).toBeInTheDocument();
    expect(screen.getByText("30-day free trial of Pro")).toBeInTheDocument();
  });

  it("offers Sign In, Create Account and Continue without signing in", async () => {
    stubElectron(null);
    renderApp();
    expect(await screen.findByRole("button", { name: "Sign In" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create Account" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue without signing in" })).toBeInTheDocument();
  });
});

describe("App main layout and banners", () => {
  it("starts with the 2px accent line on bg-accent", async () => {
    stubElectron("local", { replies: OPEN_VAULT });
    renderApp();
    await screen.findByTitle("Toggle AI Panel");
    const line = document.querySelector("[data-cv-accent-line]") as HTMLElement;
    expect(line).not.toBeNull();
    expect(line.className).toContain("h-[2px]");
    expect(line.className).toContain("bg-accent");
    expect(line.parentElement?.firstElementChild).toBe(line);
  });

  it("renders the AI toggle as a pressed-state IconButton that opens the panel", async () => {
    stubElectron("local", { replies: OPEN_VAULT });
    renderApp();
    const toggle = await screen.findByTitle("Toggle AI Panel");
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle.hasAttribute("data-cv-ai-toggle")).toBe(true);
    expect(toggle.getAttribute("aria-label")).toBe("Toggle AI Panel");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    const panel = document.querySelector("[data-cv-ai-panel]") as HTMLElement;
    const divider = document.querySelector("[data-cv-ai-divider]") as HTMLElement;
    expect(panel.style.display).toBe("none");
    expect(divider.style.display).toBe("none");
    expect(divider.className).toContain("cv-sash-ai");

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-pressed")).toBe("true"));
    expect(panel.style.display).toBe("");
    expect(divider.style.display).toBe("");
    expect([...panel.parentElement!.children].slice(-2)).toEqual([divider, panel]);
  });

  it("shows the centered offline banner without role=status and with its Reconnect button in cached mode", async () => {
    stubElectron("cached", { replies: OPEN_VAULT });
    renderApp();
    await screen.findByTitle("Toggle AI Panel");
    const text = screen.getByText("Working offline — using cached features");
    const banner = text.closest("[data-cv-banner-text]")!.parentElement as HTMLElement;
    expect(banner.getAttribute("role")).toBeNull();
    expect(banner.className).toContain("justify-center");
    const reconnect = screen.getByRole("button", { name: "Reconnect" });
    expect(banner.contains(reconnect)).toBe(true);
    expect(document.querySelectorAll('[role="status"]')).toHaveLength(0);
  });

  it("shows the same offline banner over the vault hub in cached mode", async () => {
    stubElectron("cached");
    renderApp();
    const text = await screen.findByText("Working offline — using cached features");
    const banner = text.closest("[data-cv-banner-text]")!.parentElement as HTMLElement;
    expect(banner.getAttribute("role")).toBeNull();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
  });
});
