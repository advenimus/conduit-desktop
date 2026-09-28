import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import UpgradeBanner from "../UpgradeBanner";

afterEach(cleanup);

describe("UpgradeBanner", () => {
  it("renders on Callout with the message and the call to action", () => {
    const onCta = vi.fn();
    const { container } = render(<UpgradeBanner message="Connection limit reached (10/10)" ctaLabel="Upgrade to Pro" onCta={onCta} />);
    const callout = container.firstElementChild as HTMLElement;
    expect(callout.className).toContain("bg-info-bg");
    expect(callout).toHaveTextContent("Connection limit reached (10/10)");
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to Pro →" }));
    expect(onCta).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("shows a dismiss button only with onDismiss", () => {
    const onDismiss = vi.fn();
    render(<UpgradeBanner message="m" ctaLabel="Upgrade" onCta={() => {}} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
