import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BrowserViewOverlay } from "../components/browser-view-overlay";
import { useBrowserViewStore } from "../store";

import { useAgentStore } from "@/features/agent-chat";
import { useBrowserHandoffStore } from "@/features/browser-handoff";

const handoffConnectionMocks = vi.hoisted(() => {
  class MockBrowserHandoffConnection {
    static instances: MockBrowserHandoffConnection[] = [];
    disposed = false;
    connect = vi.fn();
    dispose = vi.fn(() => {
      this.disposed = true;
    });
    send = vi.fn();
    setFrameHandler = vi.fn();
    setInputAckHandler = vi.fn();

    constructor(
      readonly credentials: unknown,
      readonly callbacks: unknown,
    ) {
      MockBrowserHandoffConnection.instances.push(this);
    }
  }
  return { MockBrowserHandoffConnection };
});

// Real BrowserHandoffConnection opens a live WebSocket in connect(); these
// tests only need to observe how the overlay's connect effect constructs and
// tears down connections around a one-time-token exchange, so the transport
// itself is replaced.
vi.mock("@/features/browser-handoff/connection", () => ({
  BrowserHandoffConnection: handoffConnectionMocks.MockBrowserHandoffConnection,
}));

describe("BrowserViewOverlay", () => {
  beforeEach(() => {
    useBrowserViewStore.getState().clear();
    useBrowserHandoffStore.getState().clear();
    useAgentStore.setState({ status: "idle", connected: true });
    handoffConnectionMocks.MockBrowserHandoffConnection.instances = [];
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

  it("recovers Done and Cancel controls after a reload loses the view", () => {
    useBrowserHandoffStore.getState().ingestControl({
      type: "browser_handoff_state",
      browserId: "browser-1",
      handoffId: "handoff-1",
      state: "human_active",
      expiresAt: Date.now() + 60_000,
      hardExpiresAt: Date.now() + 300_000,
    });

    render(<BrowserViewOverlay />);

    expect(screen.getByRole("region", { name: "Browser view" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Done — return to agent" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Cancel browser session" }),
    ).toBeVisible();
    expect(
      screen.getByText(/Interactive control is unavailable after reload/),
    ).toBeVisible();
  });

  it("keeps the handoff connection alive after the one-time token is consumed", () => {
    // Regression test: BrowserHandoffConnection nulls the one-time token via
    // consumeToken() the instant the socket authenticates. The overlay's
    // connect effect used to depend on that token, so the auth-success
    // callback re-ran the effect and disposed the very socket that had just
    // authenticated — leaving the "take control" view solid white with a
    // dead connection and no visible error (the bug reported live).
    useBrowserHandoffStore.setState({
      browserId: "browser-1",
      handoffId: "handoff-1",
      token: "secret-token",
      resume: false,
      state: "human_active",
      connectionState: "connecting",
    });

    render(<BrowserViewOverlay />);

    const { instances } = handoffConnectionMocks.MockBrowserHandoffConnection;
    expect(instances).toHaveLength(1);
    const connection = instances[0]!;
    expect(connection.connect).toHaveBeenCalledTimes(1);

    // Simulate BrowserHandoffConnection's onAuthenticated callback, which
    // calls consumeToken() once the socket has authenticated.
    act(() => {
      useBrowserHandoffStore.getState().consumeToken();
    });

    expect(connection.dispose).not.toHaveBeenCalled();
    expect(instances).toHaveLength(1);
  });

  it("offers cancellation but not Done for a recovered pending handoff", () => {
    useBrowserHandoffStore.getState().ingestControl({
      type: "browser_handoff_state",
      browserId: "browser-1",
      handoffId: "handoff-1",
      state: "pending",
      expiresAt: Date.now() + 30_000,
    });

    render(<BrowserViewOverlay />);

    expect(
      screen.getByRole("button", { name: "Cancel browser session" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Done — return to agent" }),
    ).toBeNull();
  });
});
