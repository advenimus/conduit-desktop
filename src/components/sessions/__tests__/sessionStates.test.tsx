import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const invoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null));

vi.mock("../../../lib/electron", () => ({
  invoke,
  listen: vi.fn(async () => () => undefined),
  listenSync: vi.fn(() => () => undefined),
}));

vi.mock("../../../hooks/useRemoteClipboard", () => ({ useRemoteClipboard: () => undefined }));

import ConnectionError from "../ConnectionError";
import RdpView from "../RdpView";
import WebCertWarning from "../web/WebCertWarning";
import { SessionConnecting, SessionError } from "../SessionStates";
import { useEntryStore } from "../../../stores/entryStore";
import { useSessionStore } from "../../../stores/sessionStore";

const LEGACY = ".bg-canvas, .bg-panel, .bg-raised, .text-red-400, .bg-conduit-600, .animate-spin.border-b-2";

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(null);
});

describe("ConnectionError (restyle)", () => {
  async function setup(props: Partial<Parameters<typeof ConnectionError>[0]> = {}) {
    const reconnectSession = vi.fn(async () => undefined);
    const closeSession = vi.fn(async () => undefined);
    useEntryStore.setState({ reconnectSession } as never);
    useSessionStore.setState({ closeSession } as never);
    const view = render(<ConnectionError sessionId="s1" entryId="e1" error="boom" sessionType="ssh" {...props} />);
    await act(async () => undefined);
    return { ...view, reconnectSession, closeSession };
  }

  it("sits on the editor surface with the danger title and no legacy classes", async () => {
    const { container } = await setup();
    const root = container.firstElementChild!;
    expect(root).toHaveClass("bg-editor", "flex-1");
    expect(screen.getByText("Connection Error")).toHaveClass("text-danger");
    expect(container.querySelector(LEGACY)).toBeNull();
  });

  it("keeps Reconnect (primary) then Close, and each still calls its store action", async () => {
    const { container, reconnectSession, closeSession } = await setup();
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Reconnect", "Close"]);
    expect(buttons[0]).toHaveClass("bg-btn-primary");
    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[1]);
    expect(reconnectSession).toHaveBeenCalledWith("s1");
    expect(closeSession).toHaveBeenCalledWith("s1");
  });

  it("leaves Reconnect out without an entry", async () => {
    const { container } = await setup({ entryId: undefined });
    expect([...container.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Close"]);
  });

  it("shows the local network block as a warning callout with Open Settings", async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === "local_network_status" ? "denied" : null));
    const { container } = await setup({ error: "connect EHOSTUNREACH 192.168.1.10:22" });
    const title = screen.getByText("macOS is blocking local network access");
    expect(title.closest(".bg-warning-bg")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(invoke).toHaveBeenCalledWith("open_local_network_settings");
    expect(container.querySelector(".bg-yellow-500\\/10, .text-yellow-300")).toBeNull();
  });

  it("never blames macOS for a sign-in failure, even when the permission check says denied", async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === "local_network_status" ? "denied" : null));
    await setup({ error: "All configured authentication methods failed" });
    expect(screen.queryByText("macOS is blocking local network access")).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("local_network_status");
  });
});

describe("SessionConnecting and SessionError", () => {
  it("draws the Spinner primitive with the text unchanged", () => {
    const { container } = render(<SessionConnecting text="Connecting to VNC session..." />);
    expect(container.firstElementChild).toHaveClass("bg-editor");
    expect(container.querySelector("svg.animate-spin")).not.toBeNull();
    expect(container.textContent).toBe("Connecting to VNC session...");
  });

  it("stays see-through when asked, for overlays on a frozen web screenshot", () => {
    const { container } = render(<SessionError surface={false} title="Failed to load web session" message="x" />);
    expect(container.firstElementChild).not.toHaveClass("bg-editor");
  });
});

describe("RdpView states (restyle)", () => {
  const base = { sessionId: "r1", width: 800, height: 600 };

  it("connecting and reconnecting keep their texts on the editor surface", () => {
    const { container, rerender } = render(<RdpView {...base} status="connecting" />);
    expect(container.textContent).toBe("Connecting to RDP session...");
    expect(container.firstElementChild).toHaveClass("bg-editor");
    rerender(<RdpView {...base} status="connecting" reconnecting />);
    expect(container.textContent).toBe("Reconnecting...Waiting for server to release previous session");
    expect(container.querySelector(LEGACY)).toBeNull();
  });

  it("the error state keeps its texts and Close", () => {
    const onClose = vi.fn();
    const { container } = render(<RdpView {...base} status="disconnected" connectionError="raw failure" onClose={onClose} />);
    expect(screen.getByText("Connection Error")).toHaveClass("text-danger");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
    expect(container.querySelector(LEGACY)).toBeNull();
  });

  it("the external FreeRDP state keeps Disconnect", () => {
    const onClose = vi.fn();
    render(<RdpView {...base} rdpMode="xfreerdp" onClose={onClose} />);
    expect(screen.getByText("RDP Session Active")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("the live canvas container is on bg-editor and keeps its keyboard hook", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const { container } = render(<RdpView {...base} />);
    const root = container.querySelector("[data-session-keyboard]")!;
    expect(root).toHaveClass("bg-editor");
    expect(root).toHaveAttribute("tabindex", "0");
  });
});

describe("WebCertWarning", () => {
  it("keeps every text and Proceed Anyway on primitives", () => {
    const onProceed = vi.fn();
    const { container } = render(
      <WebCertWarning certError={{ url: "https://x", error: "ERR_CERT", issuer: "Me", subject: "x" }} onProceed={onProceed} />,
    );
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Your connection is not private");
    expect(container.textContent).toContain("Error: ERR_CERT");
    expect(container.textContent).toContain('enable "Ignore certificate errors" in the entry settings.');
    fireEvent.click(screen.getByRole("button", { name: "Proceed Anyway" }));
    expect(onProceed).toHaveBeenCalled();
    expect(container.querySelector(".bg-panel, .bg-yellow-600, .text-yellow-500")).toBeNull();
  });
});
