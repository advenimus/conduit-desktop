import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { render, screen, cleanup } from "@testing-library/react";
import {
  Button,
  Checkbox,
  ChoiceCard,
  ChoiceGroup,
  IconButton,
  ListRow,
  Radio,
  RadioGroup,
  SearchInput,
  SegmentedControl,
  Select,
  Switch,
  Tabs,
  TextInput,
} from "..";

afterEach(cleanup);

interface FocusRule {
  selectors: string[];
  offset: string;
}

// The global focus rules (spec 2.7) as base.css declares them, so the test follows the stylesheet.
function focusRules(): FocusRule[] {
  const css = fs.readFileSync(path.resolve(__dirname, "../../../styles/base.css"), "utf8");
  const rules = [...css.matchAll(/:where\(([^{]+?)\):focus-visible\s*\{([^}]*)\}/g)];
  return rules.map(([, list, body]) => ({
    selectors: splitTopLevel(list),
    offset: /outline-offset:\s*([^;]+);/.exec(body)?.[1].trim() ?? "",
  }));
}

function splitTopLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of list) {
    if (ch === "(" || ch === "[") depth += 1;
    if (ch === ")" || ch === "]") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

// Both rules have zero specificity, so the last rule that matches wins.
function focusOffset(el: Element): string | null {
  const matching = focusRules().filter((rule) => rule.selectors.some((sel) => el.matches(sel)));
  return matching.length > 0 ? matching[matching.length - 1].offset : null;
}

describe("focus ring offsets (spec 2.7)", () => {
  it("reads both focus rules from base.css", () => {
    expect(focusRules().map((r) => r.offset)).toEqual(["-1px", "2px"]);
  });

  it("text buttons get the 2px outside ring", () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toHaveAttribute("data-cv-text-button");
    expect(focusOffset(button)).toBe("2px");
  });

  it("checkboxes and radios get the 2px outside ring", () => {
    render(
      <>
        <Checkbox checked={false} onChange={() => {}}>
          Remember
        </Checkbox>
        <RadioGroup aria-label="Style" value="a" onChange={() => {}}>
          <Radio value="a">Custom</Radio>
        </RadioGroup>
      </>,
    );
    expect(focusOffset(screen.getByRole("checkbox"))).toBe("2px");
    expect(focusOffset(screen.getByRole("radio"))).toBe("2px");
  });

  it("every other focusable primitive keeps the inset ring", () => {
    render(
      <>
        <IconButton icon="close" label="Close" />
        <TextInput aria-label="Name" />
        <Select aria-label="Pick">
          <option>One</option>
        </Select>
        <Switch checked={false} onChange={() => {}} label="Toggle" />
        <Tabs aria-label="Views" items={[{ value: "a", label: "A" }]} value="a" onChange={() => {}} />
        <SegmentedControl aria-label="Mode" options={[{ value: "dark", label: "Dark" }]} value="dark" onChange={() => {}} />
        <ChoiceGroup aria-label="Pack" value="x" onChange={() => {}}>
          <ChoiceCard value="x" label="X" />
        </ChoiceGroup>
        <ListRow onClick={() => {}}>Row</ListRow>
      </>,
    );
    const inset = [
      screen.getByRole("button", { name: "Close" }),
      screen.getByRole("textbox", { name: "Name" }),
      screen.getByRole("combobox", { name: "Pick" }),
      screen.getByRole("switch"),
      screen.getByRole("tab"),
      screen.getAllByRole("radio")[0],
      screen.getAllByRole("radio")[1],
      screen.getByRole("button", { name: "Row" }),
    ];
    for (const el of inset) expect([el.outerHTML.slice(0, 60), focusOffset(el)]).toEqual([el.outerHTML.slice(0, 60), "-1px"]);
  });

  it("the search field shows focus on its wrapper; its bare input draws no ring of its own", () => {
    render(<SearchInput aria-label="Search entries" value="" onChange={() => {}} />);
    const input = screen.getByRole("textbox", { name: "Search entries" });
    expect(input).toHaveAttribute("data-bare");
    expect(focusOffset(input)).toBeNull();
    expect(input.parentElement?.className).toContain("focus-within:outline-(--c-focus)");
  });

  it("the ring appears at once: no primitive animates outline-color", () => {
    // Tailwind v4's transition-colors includes outline-color, so a new ring would fade in from the text color.
    const { container } = render(
      <>
        <Button>One</Button>
        <IconButton icon="plus" label="Add" />
        <Switch checked={false} onChange={() => {}} label="Toggle" />
      </>,
    );
    for (const el of Array.from(container.querySelectorAll("button"))) {
      expect(el.className).not.toContain("transition-colors");
      expect(el.className).toContain("transition-[color,background-color,border-color]");
    }
  });

  it("no primitive removes the outline with outline-none", () => {
    const { container } = render(
      <>
        <Button>One</Button>
        <IconButton icon="plus" label="Add" />
        <TextInput aria-label="Two" />
        <SearchInput aria-label="Three" value="x" onChange={() => {}} />
        <ListRow onClick={() => {}}>Four</ListRow>
      </>,
    );
    expect(container.querySelector(".outline-none")).toBeNull();
  });
});
