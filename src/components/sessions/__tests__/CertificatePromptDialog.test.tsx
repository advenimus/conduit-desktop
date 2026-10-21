import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listeners = new Map<string, (event: { payload: unknown }) => void>();
vi.mock("../../../lib/electron", () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === "rdp_cert_prompt_list_pending" ? [] : true)),
  listenSync: vi.fn((event: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(event, handler);
    return () => listeners.delete(event);
  }),
}));
vi.mock("../../common/Toast", () => ({ toast: { error: vi.fn() } }));

const { invoke } = await import("../../../lib/electron");
const { toast } = await import("../../common/Toast");
const { default: CertificatePromptDialog, CERT_PROMPT_EVENT, CERT_PROMPT_RESOLVED_EVENT } = await import("../CertificatePromptDialog");

const FP_NEW = "C2:6A:53:AB:64:44:C4:C9:12:9A:27:AC:E0:ED:79:0B:44:46:D9:63:69:D0:6F:49:76:A0:BE:E0:4C:B0:44:EB";
const FP_OLD = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";

const REQUEST = {
  request_id: "c1",
  origin: "user",
  kind: "new",
  hop: "gateway",
  host: "rdg.example.com",
  port: 443,
  connection_name: "Office PC",
  problems: ["untrusted", "expired"],
  subject: "CN=rdg.example.com, O=Example Corp",
  issuer: "CN=Example Corp Root CA",
  valid_from: "2024-01-01T00:00:00.000Z",
  valid_to: "2025-01-01T00:00:00.000Z",
  fingerprint: FP_NEW,
  previous: null,
};

const show = (payload: unknown) => act(() => listeners.get(CERT_PROMPT_EVENT)!({ payload }));

beforeEach(() => {
  listeners.clear();
  vi.mocked(invoke).mockClear();
  vi.mocked(toast.error).mockClear();
});

describe("CertificatePromptDialog", () => {
  it("shows the host, issuer, subject, validity and fingerprint, and the problems", () => {
    render(<CertificatePromptDialog />);
    show(REQUEST);
    expect(screen.getByText("Trust this certificate?")).toBeInTheDocument();
    expect(screen.getByText("rdg.example.com:443")).toBeInTheDocument();
    expect(screen.getByText(/the gateway/)).toBeInTheDocument();
    expect(screen.getByText(REQUEST.subject)).toBeInTheDocument();
    expect(screen.getByText(REQUEST.issuer)).toBeInTheDocument();
    expect(screen.getByText(FP_NEW)).toBeInTheDocument();
    expect(screen.getByText("It is not issued by an authority this computer trusts.")).toBeInTheDocument();
    expect(screen.getByText(/^It expired on/)).toBeInTheDocument();
  });

  it.each([
    ["Trust once", "once"],
    ["Always trust", "always"],
    ["Cancel", "cancel"],
  ])("sends %s", async (label, answer) => {
    render(<CertificatePromptDialog />);
    show(REQUEST);
    fireEvent.click(screen.getByRole("button", { name: label }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("rdp_cert_prompt_respond", { request_id: "c1", answer }));
    await waitFor(() => expect(screen.queryByText("Trust this certificate?")).not.toBeInTheDocument());
  });

  it("warns clearly when a trusted certificate changed, with both fingerprints", () => {
    render(<CertificatePromptDialog />);
    show({
      ...REQUEST,
      kind: "changed",
      problems: ["untrusted"],
      previous: { fingerprint: FP_OLD, subject: "CN=rdg", issuer: "CN=rdg", valid_to: "2026-01-01T00:00:00.000Z", trusted_at: "2025-03-01T00:00:00.000Z" },
    });
    expect(screen.getByText("Certificate changed")).toBeInTheDocument();
    expect(screen.getByText(/intercepting the connection/)).toBeInTheDocument();
    expect(screen.getByText(FP_NEW)).toBeInTheDocument();
    expect(screen.getByText(FP_OLD)).toBeInTheDocument();
  });

  it("says when an AI agent opened the connection", () => {
    render(<CertificatePromptDialog />);
    show({ ...REQUEST, origin: "agent" });
    expect(screen.getByText("An AI agent is opening this connection.")).toBeInTheDocument();
  });

  it("closes when the main process times the question out", () => {
    render(<CertificatePromptDialog />);
    show(REQUEST);
    act(() => listeners.get(CERT_PROMPT_RESOLVED_EVENT)!({ payload: { request_id: "c1" } }));
    expect(screen.queryByText("Trust this certificate?")).not.toBeInTheDocument();
  });

  it("shows a toast when the answer could not be sent", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "rdp_cert_prompt_respond") throw new Error("This certificate question already timed out or was answered");
      return [];
    });
    render(<CertificatePromptDialog />);
    show(REQUEST);
    fireEvent.click(screen.getByRole("button", { name: "Trust once" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.queryByText("Trust this certificate?")).not.toBeInTheDocument();
  });
});
