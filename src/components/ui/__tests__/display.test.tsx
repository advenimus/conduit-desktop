import { describe, it, expect, vi, afterEach } from "vitest";
import { createRef } from "react";
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

  it("forwards ref, className and data-* hooks to one root element, with or without text", () => {
    const iconOnly = createRef<HTMLSpanElement>();
    const withText = createRef<HTMLSpanElement>();
    render(
      <>
        <Spinner ref={iconOnly} className="text-accent" data-cv-busy="icon" />
        <Spinner ref={withText} text="Opening..." data-cv-busy="text" />
      </>,
    );
    expect(iconOnly.current).toBe(document.querySelector('[data-cv-busy="icon"]'));
    expect(iconOnly.current?.className).toContain("text-accent");
    expect(iconOnly.current?.querySelector("svg")).not.toBeNull();
    expect(withText.current).toBe(document.querySelector('[data-cv-busy="text"]'));
    expect(withText.current).toHaveTextContent("Opening...");
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

  it("the count badge has the spec 4.12 metrics", () => {
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

  it("onFilled swaps the border and text for white, for a hint inside a filled button", () => {
    render(<Kbd onFilled>Ctrl+N</Kbd>);
    const cls = screen.getByText("Ctrl+N").className.split(" ");
    expect(cls).toEqual(expect.arrayContaining(["border-white/40", "text-white"]));
    expect(cls).not.toContain("border-control");
    expect(cls).not.toContain("text-ink-muted");
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

  it("has no close button unless onDismiss is set", () => {
    render(<Callout title="Heads up">Sync is paused.</Callout>);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("with onDismiss, ends with a small Dismiss button that calls it", () => {
    const onDismiss = vi.fn();
    const onStart = vi.fn();
    const { container } = render(
      <Callout size="sm" title="Try Pro free for 30 days" onDismiss={onDismiss} actions={<Button size="sm" onClick={onStart}>Start Free Trial</Button>} />,
    );
    const dismiss = screen.getByRole("button", { name: "Dismiss" });
    expect(dismiss).toHaveAttribute("title", "Dismiss");
    expect(dismiss.className).toContain("size-5");
    expect(container.firstElementChild?.lastElementChild).toBe(dismiss);

    fireEvent.click(dismiss);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("takes a dismissLabel and keeps the danger error hook", () => {
    const onDismiss = vi.fn();
    render(
      <Callout tone="danger" onDismiss={onDismiss} dismissLabel="Hide this error">
        That password did not work.
      </Callout>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Hide this error" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(document.querySelector("p[data-cv-error]")).toHaveTextContent("That password did not work.");
  });
});

describe("Banner", () => {
  it("keeps role=status, span.flex-1 with data-cv-banner-text and exact button labels (B14, B15)", () => {
    const onReview = vi.fn();
    render(
      <Banner tone="warn" actions={[{ label: "Review", onClick: onReview, primary: true }, { label: "Not Now", onClick: () => {} }]}>
        3 changes need review
      </Banner>,
    );
    const banner = screen.getByRole("status");
    const text = banner.querySelector("span.flex-1");
    expect(text).toHaveAttribute("data-cv-banner-text");
    expect(text).toHaveTextContent("3 changes need review");
    const labels = [...banner.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(labels).toEqual(["Review", "Not Now"]);
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(onReview).toHaveBeenCalled();
    expect(banner.className).toContain("bg-warning-bg");
  });

  it("draws actions as small buttons, filled where primary (D-27), inside the 26px row", () => {
    render(
      <Banner tone="lock" actions={[{ label: "Use here instead", onClick: () => {}, primary: true }, { label: "Later", onClick: () => {}, disabled: true }]}>
        This vault is open on another device.
      </Banner>,
    );
    const primary = screen.getByRole("button", { name: "Use here instead" }).className.split(" ");
    const secondary = screen.getByRole("button", { name: "Later" });
    expect(primary).toEqual(expect.arrayContaining(["h-control-sm", "bg-btn-primary", "ml-2"]));
    expect(primary).not.toContain("underline");
    expect(secondary.className.split(" ")).toEqual(expect.arrayContaining(["h-control-sm", "bg-(--c-btn-secondary-bg)"]));
    expect(secondary).toBeDisabled();
  });

  it('status={false} leaves out role="status" for the offline banners', () => {
    render(
      <Banner tone="warn" icon="wifiOff" status={false} align="center" actions={[{ label: "Reconnect", onClick: () => {} }]}>
        Offline: working with cached features.
      </Banner>,
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
  });

  it('align="center" centers icon, text and actions as one group, the text not growing', () => {
    const { container } = render(
      <Banner tone="warn" status={false} align="center" actions={[{ label: "Reconnect", onClick: () => {} }]}>
        Offline
      </Banner>,
    );
    const row = container.firstElementChild as HTMLElement;
    expect(row.className.split(" ")).toContain("justify-center");
    const text = row.querySelector("[data-cv-banner-text]") as HTMLElement;
    expect(text.className.split(" ")).not.toContain("flex-1");
    expect(row.querySelector("span.flex-1")).toBeNull();
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

  it("stays 26px tall: the 5 + 16 + 5 text line fills it, so the divider is drawn inside instead of added", () => {
    render(<Banner tone="info">Info</Banner>);
    const classes = screen.getByRole("status").className.split(" ");
    expect(classes).toContain("min-h-(--c-banner-h)");
    expect(classes).toContain("shadow-[inset_0_-1px_0_var(--c-divider)]");
    expect(classes).not.toContain("border-b");
    expect(screen.getByText("Info").className.split(" ")).toEqual(expect.arrayContaining(["py-[5px]", "leading-4"]));
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

  it("SettingsRow titleAside sits right after the title, outside its label, and keeps the switch a direct child (B39)", () => {
    render(
      <SettingsRow
        title="Cloud Backup"
        titleAside={<span data-testid="badge">Pro and Team</span>}
        toggle={<Switch checked={false} onChange={() => {}} data-cv-toggle="cloud" />}
      />,
    );
    const label = [...document.querySelectorAll("label")].find((l) => l.textContent === "Cloud Backup") as HTMLLabelElement;
    expect(label).toBeTruthy();
    const badge = screen.getByTestId("badge");
    expect(label.contains(badge)).toBe(false);
    expect(label.nextElementSibling).toBe(badge);
    const row = label.closest("[data-cv-toggle-row]") as HTMLElement;
    expect(row.querySelector(":scope > button")).toHaveAttribute("data-cv-toggle", "cloud");
  });

  it("SettingsRow titleAside also follows a plain title", () => {
    render(<SettingsRow title="Idle lock" titleAside={<span data-testid="aside">Pro</span>} />);
    expect(screen.getByText("Idle lock").nextElementSibling).toBe(screen.getByTestId("aside"));
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

  it("wraps its action row, draws an action's icon and eases the progress fill", () => {
    render(
      <ToastCard
        type="info"
        toastId="t2"
        title="Update Ready"
        actions={[
          { id: "a", label: "Restart Now", icon: "refresh", onClick: () => {} },
          { id: "b", label: "Later", onClick: () => {} },
        ]}
        progress={{ percent: 30 }}
      />,
    );
    const restart = screen.getByRole("button", { name: "Restart Now" });
    expect(restart.parentElement?.className.split(" ")).toContain("flex-wrap");
    expect(restart.querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Later" }).querySelector("svg")).toBeNull();
    const fill = document.querySelector('[data-toast="t2"] [style]') as HTMLElement;
    expect(fill.className.split(" ")).toEqual(expect.arrayContaining(["transition-[width]", "duration-150", "ease-linear"]));
  });
});
