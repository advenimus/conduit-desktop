import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import PickerCredentialList from "../PickerCredentialList";
import { META, stubScrollIntoView } from "./fixtures";

stubScrollIntoView();

afterEach(cleanup);

function mount(credentials = META) {
  const onSelect = vi.fn();
  const view = render(<PickerCredentialList credentials={credentials} onSelect={onSelect} />);
  return { onSelect, ...view };
}

function rows(): HTMLButtonElement[] {
  return screen.getAllByRole("button") as HTMLButtonElement[];
}

describe("PickerCredentialList", () => {
  it("focuses the search field, a TextInput with today's placeholder and no added clear button", () => {
    mount();
    const search = screen.getByPlaceholderText("Search credentials...");
    expect(search).toHaveFocus();
    expect(search).toHaveClass("h-control", "bg-input");
    fireEvent.change(search, { target: { value: "dom" } });
    expect(screen.queryByRole("button", { name: /clear/i })).toBeNull();
  });

  it("renders each credential as a ListRow button with today's texts", () => {
    mount();
    expect(rows().map((r) => r.textContent)).toEqual([
      "Domain Adminadmin·ACME#prod#ad#tier0",
      "Deploy KeydeploySSH Key",
      "Lab Box",
    ]);
    const [admin, deploy, lab] = rows();
    expect(admin).toHaveAttribute("type", "button");
    expect(admin).not.toHaveTextContent("#extra");
    expect(deploy.querySelector(".text-badge")).toHaveTextContent("SSH Key");
    expect(lab).toHaveClass("h-row");
  });

  it("marks the keyboard selection with data-selected and moves it with the arrows", () => {
    const { onSelect } = mount();
    const search = screen.getByPlaceholderText("Search credentials...");
    expect(rows()[0]).toHaveAttribute("data-selected");
    expect(rows()[0]).toHaveClass("bg-selected");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(rows()[0]).not.toHaveAttribute("data-selected");
    expect(rows()[1]).toHaveAttribute("data-selected");
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("c2");
    fireEvent.mouseEnter(rows()[2]);
    expect(rows()[2]).toHaveAttribute("data-selected");
    fireEvent.click(rows()[0]);
    expect(onSelect).toHaveBeenLastCalledWith("c1");
  });

  it("filters by name, username, domain and tag, and shows the empty texts", () => {
    mount();
    const search = screen.getByPlaceholderText("Search credentials...");
    fireEvent.change(search, { target: { value: "tier0" } });
    expect(rows().map((r) => r.textContent?.startsWith("Domain Admin"))).toEqual([true]);
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.getByText("No matches")).toBeInTheDocument();
    cleanup();
    mount([]);
    expect(screen.getByText("No credentials")).toBeInTheDocument();
  });

  it("carries no legacy accent or palette classes", () => {
    const { container } = mount();
    expect(container.innerHTML).not.toMatch(/conduit-\d|text-\[10px\]|uppercase|hover:bg-well/);
  });
});
