import { describe, it, expect, vi, afterEach } from "vitest";
import { createRef, useState } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { FormField, PasswordInput, SearchInput, Select, Slider, Textarea, TextInput } from "..";

afterEach(cleanup);

// What ui-forms.mjs fillLabeledInPage does: the label whose first span equals the text, then its control.
function harnessControl(labelText: string): Element | null {
  const label = [...document.querySelectorAll("label")].find((l) => (l.querySelector("span")?.textContent ?? "").trim() === labelText);
  return label?.querySelector("input, textarea, select") ?? null;
}

describe("FormField", () => {
  it("nests the control inside the label after a first span that holds the label text", () => {
    render(
      <FormField label="Master password" description="At least 12 characters" error="Too short">
        <PasswordInput value="" onChange={() => {}} placeholder="Enter master password" />
      </FormField>,
    );
    const input = harnessControl("Master password");
    expect(input).toBe(screen.getByPlaceholderText("Enter master password"));
    expect(input?.closest("label")?.firstElementChild?.tagName).toBe("SPAN");
    const error = document.querySelector("[data-cv-error]");
    expect(error?.tagName).toBe("P");
    expect(error).toHaveTextContent("Too short");
    expect(screen.getByText("At least 12 characters")).toBeInTheDocument();
  });

  it("keeps the description and the error out of the label: they describe the control instead of naming it", () => {
    render(
      <FormField label="Host" description="A name or an IP address" error="Enter a host">
        <TextInput value="" onChange={() => {}} aria-describedby="extra" />
      </FormField>,
    );
    const input = screen.getByRole("textbox", { name: "Host" });
    expect(input).toHaveAttribute("aria-invalid", "true");
    const describedBy = (input.getAttribute("aria-describedby") ?? "").split(" ");
    expect(describedBy[0]).toBe("extra");
    expect(describedBy.slice(1).map((id) => document.getElementById(id)?.textContent)).toEqual(["A name or an IP address", "Enter a host"]);
    expect(document.querySelector("label [data-cv-error], label p")).toBeNull();
    expect(document.querySelector("[data-cv-error]")?.tagName).toBe("P");
  });

  it("sets no aria-invalid or aria-describedby when there is nothing to describe", () => {
    render(
      <FormField label="Host">
        <TextInput value="" onChange={() => {}} />
      </FormField>,
    );
    const input = screen.getByRole("textbox", { name: "Host" });
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(input).not.toHaveAttribute("aria-describedby");
  });

  it("forwards ref, className and data-* hooks to its root", () => {
    const ref = createRef<HTMLDivElement>();
    render(
      <FormField ref={ref} label="Vault name" className="col-span-2" data-cv-vault-name="">
        <TextInput value="" onChange={() => {}} />
      </FormField>,
    );
    expect(ref.current).toBe(document.querySelector("[data-cv-vault-name]"));
    expect(ref.current?.className).toContain("col-span-2");
    expect(ref.current?.contains(screen.getByRole("textbox", { name: "Vault name" }))).toBe(true);
  });

  it("works with Select and Textarea as the control", () => {
    render(
      <>
        <FormField label="Engine">
          <Select value="a" onChange={() => {}}>
            <option value="a">A</option>
          </Select>
        </FormField>
        <FormField label="Notes">
          <Textarea value="" onChange={() => {}} />
        </FormField>
      </>,
    );
    expect(harnessControl("Engine")?.tagName).toBe("SELECT");
    expect(harnessControl("Notes")?.tagName).toBe("TEXTAREA");
  });
});

describe("TextInput", () => {
  it("is 26px with 13px text and an explicit font size", () => {
    render(<TextInput aria-label="Host" />);
    const cls = screen.getByRole("textbox").className;
    expect(cls).toContain("h-control");
    expect(cls).toContain("text-body");
  });

  it("invalid sets aria-invalid and the danger border", () => {
    render(<TextInput aria-label="Host" invalid />);
    const input = screen.getByRole("textbox");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input.className).toContain("border-danger");
    expect(input.className).not.toContain("border-input-border");
  });

  it("forwards ref and pads for the leading and trailing slots", () => {
    const ref = createRef<HTMLInputElement>();
    render(<TextInput ref={ref} aria-label="Host" leading={<svg data-testid="lead" />} trailing={<svg data-testid="trail" />} />);
    const input = screen.getByRole("textbox");
    expect(ref.current).toBe(input);
    expect(input.className).toContain("pl-8");
    expect(input.className).toContain("pr-8");
    expect(screen.getByTestId("lead")).toBeInTheDocument();
    expect(screen.getByTestId("trail")).toBeInTheDocument();
  });
});

describe("PasswordInput", () => {
  it("toggles visibility with Show password / Hide password", () => {
    render(<PasswordInput aria-label="Password" value="secret" onChange={() => {}} />);
    const input = screen.getByLabelText("Password");
    expect(input).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(input).toHaveAttribute("type", "text");
    fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(input).toHaveAttribute("type", "password");
  });
});

describe("SearchInput", () => {
  it("shows a Clear search button only when not empty and clears and refocuses", () => {
    function Harness() {
      const [value, setValue] = useState("");
      return <SearchInput aria-label="Search entries" placeholder="Search entries..." value={value} onChange={setValue} />;
    }
    render(<Harness />);
    const input = screen.getByRole("textbox", { name: "Search entries" });
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    fireEvent.change(input, { target: { value: "web" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(input).toHaveValue("");
    expect(document.activeElement).toBe(input);
  });
});

describe("Select", () => {
  it("keeps its aria-label and is a native select", () => {
    const onChange = vi.fn();
    render(
      <Select aria-label="Lock the vault when idle" value="5" onChange={onChange}>
        <option value="5">5 minutes</option>
        <option value="15">15 minutes</option>
      </Select>,
    );
    const select = document.querySelector('select[aria-label="Lock the vault when idle"]') as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect(select.className).toContain("appearance-none");
    fireEvent.change(select, { target: { value: "15" } });
    expect(onChange).toHaveBeenCalled();
  });
});

describe("Slider", () => {
  it("renders a native range with its min, mid and max labels", () => {
    render(<Slider aria-label="Scale" min={75} max={150} value={100} onChange={() => {}} marks={["75%", "100%", "150%"]} />);
    expect(screen.getByRole("slider", { name: "Scale" })).toHaveAttribute("type", "range");
    expect(screen.getByText("75%")).toBeInTheDocument();
    expect(screen.getByText("150%")).toBeInTheDocument();
  });
});
