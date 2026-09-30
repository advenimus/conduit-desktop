import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import OpenNowCard from "../OpenNowCard";
import { focusSession } from "../../../../lib/focusSession";
import type { Session } from "../../../../stores/sessionStore";
import { entry, rowParts } from "../../__tests__/fixtures";
import { seedHomeStores } from "./homeTestStores";

vi.hoisted(() => {
  Object.assign(globalThis, { electron: { invoke: async () => null, on: () => () => undefined } });
});
vi.mock("../../../../lib/focusSession", () => ({ focusSession: vi.fn(() => true) }));

const SESSIONS: Session[] = [
  { id: "__home__", type: "dashboard", title: "Home", status: "connected" },
  { id: "s-web", type: "ssh", title: "web-01", status: "connected", entryId: "e-web" },
  { id: "s-term", type: "local_shell", title: "Terminal", status: "connected" },
  { id: "s-dc", type: "rdp", title: "DC01", status: "connecting", entryId: "e-dc", metadata: { reconnecting: true } },
  { id: "s-vnc", type: "vnc", title: "Build Mac", status: "connecting" },
  { id: "s-site", type: "web", title: "Intranet", status: "disconnected", entryId: "gone" },
  { id: "dashboard::e-web", type: "dashboard", title: "web-01 (Info)", status: "connected", entryId: "e-web" },
  { id: "s-doc", type: "document", title: "Runbook", status: "connected", entryId: "e-doc" },
];

const ENTRIES = [entry({ id: "e-web", name: "web-01", entry_type: "ssh" }), entry({ id: "e-dc", name: "DC01", entry_type: "rdp" })];

beforeEach(() => vi.mocked(focusSession).mockClear());

describe("OpenNowCard", () => {
  it("lists sessions except Home, dashboards and documents, with the status words", () => {
    seedHomeStores({ entries: ENTRIES, sessions: SESSIONS });
    render(<OpenNowCard />);
    const rows = screen.getAllByRole("button");
    expect(rows.map(rowParts)).toEqual([
      { label: "web-01", meta: "Connected" },
      { label: "Terminal", meta: "Connected" },
      { label: "DC01", meta: "Reconnecting..." },
      { label: "Build Mac", meta: "Connecting..." },
      { label: "Intranet", meta: "Disconnected" },
    ]);
    expect(rows[0].querySelector(".text-\\(--c-state-connected\\) svg")).not.toBeNull();
    expect(rows[3].querySelector(".text-\\(--c-state-connecting\\)")).not.toBeNull();
    expect(rows[4].querySelector(".text-\\(--c-state-error\\)")).not.toBeNull();
  });

  it("focuses the session on click", () => {
    seedHomeStores({ entries: ENTRIES, sessions: SESSIONS });
    render(<OpenNowCard />);
    fireEvent.click(screen.getByRole("button", { name: /Terminal/ }));
    expect(focusSession).toHaveBeenCalledWith("s-term");
  });

  it("shows at most eight rows, then the overflow line", () => {
    const many: Session[] = Array.from({ length: 11 }, (_, i) => ({ id: `t${i}`, type: "local_shell", title: `Terminal ${i}`, status: "connected" }));
    seedHomeStores({ sessions: many });
    const { container } = render(<OpenNowCard />);
    expect(within(container).getAllByRole("button")).toHaveLength(8);
    expect(screen.getByText("+3 more")).toHaveClass("text-meta", "text-ink-faint");
  });

  it("hides when only Home and dashboards are open", () => {
    seedHomeStores({ sessions: SESSIONS.slice(0, 1) });
    const { container } = render(<OpenNowCard />);
    expect(container).toBeEmptyDOMElement();
  });
});
