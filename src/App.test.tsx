import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import App from "./App";

describe("App", () => {
  it("renders welcome message", () => {
    render(<App />);
    expect(screen.getByText("Welcome to Conduit")).toBeInTheDocument();
  });

  it("renders New Connection button", () => {
    render(<App />);
    expect(screen.getByText("New Connection")).toBeInTheDocument();
  });

  it("renders sidebar with Conduit title", () => {
    render(<App />);
    expect(screen.getByText("Conduit")).toBeInTheDocument();
  });
});
