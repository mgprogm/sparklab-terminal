/**
 * RTL tests for SettingsDialog: the four section tabs, switching between them,
 * the open-vs-auth-disabled account state, and driving the font-size
 * preference through the real terminal store.
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
    useTerminalStore.setState({
      terminalFontSize: "auto",
      settingsSection: "appearance",
    });
  });
  afterEach(() => {
    useTerminalStore.setState({
      terminalFontSize: "auto",
      settingsSection: "appearance",
    });
  });

  it("renders the five section tabs", () => {
    renderDialog();
    expect(
      screen.getByRole("heading", { name: /settings/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Agent" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Account" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Connection" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Servers" })).toBeInTheDocument();
  });

  it("shows the appearance tab by default and sets font size on click", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "16" }));
    expect(useTerminalStore.getState().terminalFontSize).toBe(16);

    await user.click(screen.getByRole("button", { name: "Auto" }));
    expect(useTerminalStore.getState().terminalFontSize).toBe("auto");
  });

  it("reveals the fixed agent model only on the Agent tab", async () => {
    const user = userEvent.setup();
    renderDialog();

    expect(screen.queryByText("gpt-5.6-sol")).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Agent" }));
    expect(screen.getByText("gpt-5.6-sol")).toBeInTheDocument();
  });

  it("shows connection details on the Connection tab", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("tab", { name: "Connection" }));
    expect(screen.getByText("live")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("shows sign out with a username on the Account tab", async () => {
    const user = userEvent.setup();
    renderDialog({ username: "ada", onLogout: vi.fn() });

    await user.click(screen.getByRole("tab", { name: "Account" }));
    expect(screen.getByText("ada")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /sign out/i }),
    ).toBeInTheDocument();
  });

  it("shows an auth-disabled note in open mode on the Account tab", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("tab", { name: "Account" }));
    expect(screen.getByText(/auth disabled/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /sign out/i }),
    ).not.toBeInTheDocument();
  });
});
