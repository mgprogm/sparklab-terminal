/**
 * RTL tests for SettingsDialog: renders the four sections, reflects the
 * open-vs-auth-disabled account state, and drives the font-size preference
 * through the real terminal store.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsDialog } from "../components/settings-dialog";
import { useTerminalStore } from "../store";

function renderDialog(overrides = {}) {
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    statusState: "connected" as const,
    statusText: "live",
    sessionCount: 3,
    ...overrides,
  };
  const utils = render(<SettingsDialog {...props} />);
  return { ...utils, props };
}

describe("SettingsDialog", () => {
  beforeEach(() => {
    useTerminalStore.setState({ terminalFontSize: "auto" });
  });
  afterEach(() => {
    useTerminalStore.setState({ terminalFontSize: "auto" });
  });

  it("renders all four section headings", () => {
    renderDialog();
    expect(
      screen.getByRole("heading", { name: /settings/i }),
    ).toBeInTheDocument();
    // Exact case — the sr-only DialogDescription mentions these words in
    // lowercase, so case-insensitive regexes would match twice.
    expect(screen.getByText("Appearance")).toBeInTheDocument();
    expect(screen.getByText("Agent chat")).toBeInTheDocument();
    expect(screen.getByText("Account")).toBeInTheDocument();
    expect(screen.getByText("Connection")).toBeInTheDocument();
  });

  it("shows the fixed agent model and connection details", () => {
    renderDialog();
    expect(screen.getByText("gpt-5.6-sol")).toBeInTheDocument();
    expect(screen.getByText("live")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("sets the terminal font size preference in the store on click", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "16" }));
    expect(useTerminalStore.getState().terminalFontSize).toBe(16);

    await user.click(screen.getByRole("button", { name: "Auto" }));
    expect(useTerminalStore.getState().terminalFontSize).toBe("auto");
  });

  it("shows sign out with a username when authenticated", () => {
    renderDialog({ username: "ada", onLogout: vi.fn() });
    expect(screen.getByText("ada")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /sign out/i }),
    ).toBeInTheDocument();
  });

  it("shows an auth-disabled note in open mode (no onLogout)", () => {
    renderDialog();
    expect(screen.getByText(/auth disabled/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /sign out/i }),
    ).not.toBeInTheDocument();
  });
});
