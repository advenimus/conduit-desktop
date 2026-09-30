import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import IdleLockSetting, { idleLockOptions, normalizeIdleMinutes } from "../IdleLockSetting";

afterEach(() => cleanup());

const menu = () => screen.getByRole("combobox", { name: "Lock the vault when idle" }) as HTMLSelectElement;

describe("IdleLockSetting", () => {
  it("shows a stored value the menu does not list as Custom, the way the main process honors it", () => {
    const onChange = vi.fn();
    render(<IdleLockSetting minutes={7} onChange={onChange} />);
    expect(menu().value).toBe("7");
    expect(screen.getByRole("option", { name: "Custom (7 min)" })).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(menu(), { target: { value: "15" } });
    expect(onChange).toHaveBeenCalledWith(15);
  });

  it("lists no Custom entry for a menu value, and Off for anything the main process ignores", () => {
    render(<IdleLockSetting minutes={30} onChange={() => undefined} />);
    expect(menu().value).toBe("30");
    expect(screen.queryByRole("option", { name: /Custom/ })).toBeNull();
    for (const v of [0, -5, 2.5, "10", null, undefined]) expect(normalizeIdleMinutes(v)).toBe(0);
    expect(idleLockOptions(90).map((o) => o.minutes)).toEqual([0, 5, 15, 30, 60, 90]);
    expect(idleLockOptions(10).map((o) => o.minutes)).toEqual([0, 5, 10, 15, 30, 60]);
  });
});
