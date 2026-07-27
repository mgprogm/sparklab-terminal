import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { BrowserViewOverlay } from "../components/browser-view-overlay";
import { useBrowserViewStore } from "../store";

import { useAgentStore } from "@/features/agent-chat";
import { useBrowserHandoffStore } from "@/features/browser-handoff";

describe("BrowserViewOverlay", () => {
  beforeEach(() => {
    useBrowserViewStore.getState().clear();
    useBrowserHandoffStore.getState().clear();
    useAgentStore.setState({ status: "idle", connected: true });
  });

  it("moves focus off the covered terminal and hides on request", async () => {
    const terminalInput = document.createElement("textarea");
    document.body.appendChild(terminalInput);
    terminalInput.focus();

    useBrowserViewStore.getState().ingest({
      type: "browser_view",
      browserId: "browser-1",
      revision: 1,
      url: "https://example.com/",
      title: "Example",
      viewport: { width: 1280, height: 720 },
      screenshot: { mediaType: "image/png", data: "iVBORw0KGgo=" },
    });

    render(<BrowserViewOverlay />);
    const back = screen.getByRole("button", { name: "Back to terminal" });
    expect(back).toHaveFocus();
    expect(screen.getByRole("region", { name: "Browser view" })).toBeVisible();

    await userEvent.click(back);
    expect(screen.queryByRole("region", { name: "Browser view" })).toBeNull();
    terminalInput.remove();
  });

  it("shows the isolation warning before requesting control", async () => {
    useBrowserViewStore.getState().ingest({
      type: "browser_view",
      browserId: "browser-1",
      revision: 1,
      url: "https://example.com/login?oauth_secret=hidden#token",
      title: "Sign in",
      viewport: { width: 1280, height: 720 },
      screenshot: { mediaType: "image/png", data: "iVBORw0KGgo=" },
    });
    render(<BrowserViewOverlay />);
    expect(screen.queryByText(/oauth_secret|#token/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Take control" }));
    expect(
      screen.getByText(
        /Existing logins and cookies from your personal browser are not shared/,
      ),
    ).toBeVisible();
    expect(screen.getByText(/Clipboard, paste, file upload/)).toBeVisible();
  });

  it("keeps reconnecting and exhausted connection states distinct", () => {
    useBrowserViewStore.getState().ingest({
      type: "browser_view",
      browserId: "browser-1",
      revision: 1,
      url: "https://example.com/",
      title: "Example",
      viewport: { width: 1280, height: 720 },
      screenshot: { mediaType: "image/png", data: "iVBORw0KGgo=" },
    });
    useBrowserHandoffStore.setState({
      state: "human_active",
      connectionState: "reconnecting",
    });
    render(<BrowserViewOverlay />);
    expect(
      screen.getByText(/Reconnecting — agent remains paused/),
    ).toBeVisible();

    act(() => useBrowserHandoffStore.setState({ connectionState: "closed" }));
    expect(
      screen.getByText(/Connection lost — browser session closing/),
    ).toBeVisible();
  });
});
