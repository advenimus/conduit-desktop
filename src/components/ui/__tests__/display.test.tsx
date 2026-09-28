import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import {
  Badge,
  Banner,
  Button,
  Callout,
  Card,
  CountBadge,
  EmptyState,
  Kbd,
  SectionHeader,
  SettingsRow,
  Spinner,
  Switch,
  ToastCard,
} from "..";

afterEach(cleanup);

describe("Spinner", () => {
  it("is decorative by default and never role=status", () => {
    const { container } = render(<Spinner />);
    const svg = container.querySelector("svg") as SVGElement;
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg.getAttribute("class")).toContain("animate-spin");
    expect(container.querySelector("[role=status]")).toBeNull();
  });

  it("with a label it is an image with that name", () => {
    render(<Spinner label="Loading vault" />);
    expect(screen.getByRole("img", { name: "Loading vault" })).toBeInTheDocument();
  });

  it("with text it renders the text as visible text next to the icon (B35)", () => {
    const { container } = render(<Spinner text="Looking for copies..." />);
    expect(screen.getByText("Looking for copies...")).toBeVisible();
    expect(container.textContent).toBe("Looking for copies...");
    expect(container.querySelector("[role=status]")).toBeNull();
  });

  it("renders at 12, 16 or 24", () => {
    const { container } = render(<Spinner size={24} />);
    expect(container.querySelector("svg")).toHaveAttribute("width", "24");
  });
});

describe("Badge and CountBadge", () => {
  it("each tone uses its token pair", () => {
    render(
      <>
        <Badge>Neutral</Badge>
        <Badge tone="accent">Accent</Badge>
        <Badge tone="warning">Warning</Badge>
        <Badge tone="danger">Danger</Badge>
        <Badge tone="success">Success</Badge>
      </>,
    );
    expect(screen.getByText("Neutral").className).toContain("bg-selected");
    expect(screen.getByText("Accent").className).toContain("bg-badge");
    expect(screen.getByText("Warning").className).toContain("bg-warning-bg");
    expect(screen.getByText("Danger").className).toContain("text-danger");
    expect(screen.getByText("Success").className).toContain("text-success");
    expect(screen.getByText("Neutral").className).toContain("text-badge");
  });

  it("the count badge has VS Code's metrics", () => {
    render(<CountBadge count={7} />);
    const cls = screen.getByText("7").className;
    for (const c of ["min-w-[18px]", "min-h-[18px]", "px-[5px]", "py-[3px]", "rounded-full", "text-badge", "font-normal", "leading-[11px]", "bg-badge"]) {
      expect(cls).toContain(c);
    }
  });

  it("caps a large count", () => {
    render(<CountBadge count={250} max={99} />);
    expect(screen.getByText("99+")).toBeInTheDocument();
  });
});

describe("Kbd", () => {
  it("renders a kbd element", () => {
    render(<Kbd>Ctrl+P</Kbd>);
    expect(screen.getByText("Ctrl+P").tagName).toBe("KBD");
  });
});

describe("Callout", () => {
  it("danger callouts put their text in p[data-cv-error] (B8)", () => {
    render(<Callout tone="danger">That password did not work.</Callout>);
    const error = document.querySelector("[data-cv-error]");
    expect(error?.tagName).toBe("P");
    expect(error).toHaveTextContent("That password did not work.");
  });

  it("other tones have no error hook, and actions are small buttons", () => {
    const onRetry = vi.fn();
    render(
      <Callout tone="info" title="Heads up" actions={<Button size="sm" onClick={onRetry}>Retry</Button>}>
        Sync is paused.
      </Callout>,
    );
    expect(document.querySelector("[data-cv-error]")).toBeNull();
    expect(screen.getByText("Heads up").className).toContain("font-semibold");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalled();
  });
});

describe("Banner", () => {
  it("keeps role=status, span.flex-1 with data-cv-banner-text and exact link-button labels (B14, B15)", () => {
    const onReview = vi.fn();
    render(
      <Banner tone="warn" actions={[{ label: "Review", onClick: onReview }, { label: "Not Now", onClick: () => {} }]}>
        3 changes need review
      </Banner>,
    );
    const banner = screen.getByRole("status");
    const text = banner.querySelector("span.flex-1");
    expect(text).toHaveAttribute("data-cv-banner-text");
    expect(text).toHaveTextContent("3 changes need review");
    const labels = [...banner.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(labels).toEqual(["Review", "Not Now"]);
    expect(banner.querySelector("button")?.className).toContain("underline");
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(onReview).toHaveBeenCalled();
    expect(banner.className).toContain("bg-warning-bg");
  });

  it("info and lock tones use the neutral selected background", () => {
    render(
      <>
        <Banner tone="info">Info</Banner>
        <Banner tone="lock">Locked</Banner>
      </>,
    );
    for (const el of screen.getAllByRole("status")) expect(el.className).toContain("bg-selected");
  });
});

describe("containers", () => {
  it("Card is a well with a 6px radius", () => {
    render(<Card>Inside</Card>);
    const cls = screen.getByText("Inside").className;
    expect(cls).toContain("rounded-md");
    expect(cls).toContain("bg-well");
  });

  it("SectionHeader stays an h3 with the exact title", () => {
    render(<SectionHeader title="Multi-device sync" description="Keep your vault on every device" />);
    expect(screen.getByRole("heading", { level: 3, name: "Multi-device sync" })).toBeInTheDocument();
  });

  it("EmptyState shows its title, description and action", () => {
    render(<EmptyState icon="folder" title="No entries" description="Add one to get started" action={<Button>New Entry</Button>} />);
    expect(screen.getByText("No entries")).toBeInTheDocument();
    expect(screen.getByText("Add one to get started")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New Entry" })).toBeInTheDocument();
  });

  it("SettingsRow with a toggle keeps the label and the switch as a direct child of the toggle row (B22, B39)", () => {
    const onChange = vi.fn();
    render(
      <SettingsRow title="Local Backup" description="Keep copies on this device" toggle={<Switch checked={false} onChange={onChange} data-cv-toggle="local" />} />,
    );
    const label = [...document.querySelectorAll("label")].find((l) => l.textContent === "Local Backup") as HTMLLabelElement;
    expect(label).toBeTruthy();
    const row = label.closest(".justify-between") as HTMLElement;
    expect(row).toHaveAttribute("data-cv-toggle-row");
    const toggle = row.querySelector(":scope > button");
    expect(toggle).toHaveAttribute("data-cv-toggle", "local");
    expect(toggle).toHaveAttribute("role", "switch");
    fireEvent.click(label);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("SettingsRow without a toggle shows the title, the description and the control", () => {
    render(
      <SettingsRow title="Idle lock" description="Lock after a while">
        <span>control</span>
      </SettingsRow>,
    );
    expect(screen.getByText("Idle lock").className).toContain("font-semibold");
    expect(screen.getByText("control")).toBeInTheDocument();
  });
});

describe("ToastCard", () => {
  it("keeps data-toast, shows title, message, actions and a close button", () => {
    const onAction = vi.fn();
    const onClose = vi.fn();
    render(
      <ToastCard
        type="success"
        toastId="t1"
        title="Saved"
        message="Your vault was saved."
        actions={[{ id: "open", label: "Open", onClick: onAction }]}
        progress={{ percent: 40 }}
        onClose={onClose}
      />,
    );
    const card = document.querySelector('[data-toast="t1"]') as HTMLElement;
    expect(card.className).toContain("max-w-[450px]");
    expect(screen.getByText("Saved").className).toContain("font-semibold");
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(onAction).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onClose).toHaveBeenCalled();
  });
});
