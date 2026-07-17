/**
 * RTL tests for SessionSidebar: render list, create dialog opens,
 * delete confirmation flow.
 */
import { TooltipProvider } from "@sparklab/ui/components/ui/tooltip";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { SessionInfo } from "@sparklab/shared-types";

import { SessionSidebar } from "../components/session-sidebar";

function Wrapper({ children }: { children: ReactNode }) {
  return <TooltipProvider>{children}</TooltipProvider>;
}

// Minimal sessions for tests
const sessions: SessionInfo[] = [
  {
    id: "web-alpha",
    name: "alpha",
    createdAt: 1720900000000,
    tags: [],
    currentCommand: "bash",
    attached: false,
  },
  {
    id: "web-beta",
    name: "beta",
    createdAt: 1720900100000,
    tags: [],
    currentCommand: "node index.js",
    attached: true,
  },
];

function renderSidebar(overrides = {}) {
  const props = {
    sessions,
    activeSessionId: "web-alpha",
    collapsed: false,
    onSelectSession: vi.fn(),
    onCreateSession: vi.fn(),
    onDeleteSession: vi.fn(),
    onToggleCollapse: vi.fn(),
    onDialogClose: vi.fn(),
    ...overrides,
  };
  const utils = render(<SessionSidebar {...props} />, { wrapper: Wrapper });
  return { ...utils, props };
}

describe("SessionSidebar", () => {
  describe("rendering session list", () => {
    it("renders all session names", () => {
      renderSidebar();
      expect(screen.getByText("alpha")).toBeInTheDocument();
      expect(screen.getByText("beta")).toBeInTheDocument();
    });

    it("shows current command for sessions with a running job", () => {
      renderSidebar();
      expect(screen.getByText("node index.js")).toBeInTheDocument();
    });

    it("renders empty state when no sessions", () => {
      renderSidebar({ sessions: [] });
      expect(screen.getByText("No sessions yet.")).toBeInTheDocument();
    });
  });

  describe("create dialog", () => {
    it("opens when New button is clicked", async () => {
      const user = userEvent.setup();
      renderSidebar();

      const newButton = screen.getByRole("button", { name: /new/i });
      await user.click(newButton);

      expect(
        screen.getByRole("heading", { name: /new session/i }),
      ).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/session name/i)).toBeInTheDocument();
    });

    it("calls onCreateSession on submit", async () => {
      const user = userEvent.setup();
      const { props } = renderSidebar();

      await user.click(screen.getByRole("button", { name: /new/i }));
      const input = screen.getByPlaceholderText(/session name/i);
      await user.type(input, "my-session");
      await user.click(screen.getByRole("button", { name: /^create$/i }));

      expect(props.onCreateSession).toHaveBeenCalledWith({
        name: "my-session",
      });
    });

    it("calls onCreateSession with undefined for empty name", async () => {
      const user = userEvent.setup();
      const { props } = renderSidebar();

      await user.click(screen.getByRole("button", { name: /new/i }));
      // Submit without typing a name
      await user.click(screen.getByRole("button", { name: /^create$/i }));

      expect(props.onCreateSession).toHaveBeenCalledWith(undefined);
    });
  });

  describe("delete confirmation", () => {
    it("shows confirmation dialog when delete button is clicked", async () => {
      const user = userEvent.setup();
      renderSidebar();

      // Find the delete button for first session
      const deleteButtons = screen.getAllByTitle(/delete session/i);
      await user.click(deleteButtons[0]!);

      expect(
        screen.getByRole("heading", { name: /delete session/i }),
      ).toBeInTheDocument();
      expect(screen.getByText(/delete.*alpha/i)).toBeInTheDocument();
    });

    it("calls onDeleteSession when confirmed", async () => {
      const user = userEvent.setup();
      const { props } = renderSidebar();

      const deleteButtons = screen.getAllByTitle(/delete session/i);
      await user.click(deleteButtons[0]!);

      const deleteAction = screen.getByRole("button", { name: /^delete$/i });
      await user.click(deleteAction);

      expect(props.onDeleteSession).toHaveBeenCalledWith("web-alpha");
    });

    it("does NOT call onDeleteSession when cancelled", async () => {
      const user = userEvent.setup();
      const { props } = renderSidebar();

      const deleteButtons = screen.getAllByTitle(/delete session/i);
      await user.click(deleteButtons[0]!);

      await user.click(screen.getByRole("button", { name: /cancel/i }));

      expect(props.onDeleteSession).not.toHaveBeenCalled();
    });
  });

  describe("collapse", () => {
    it("calls onToggleCollapse when collapse button is clicked", async () => {
      const user = userEvent.setup();
      const { props } = renderSidebar();

      const collapseButton = screen.getByLabelText(/collapse sidebar/i);
      await user.click(collapseButton);

      expect(props.onToggleCollapse).toHaveBeenCalledTimes(1);
    });
  });

  describe("session selection", () => {
    it("calls onSelectSession when clicking an inactive session", async () => {
      const user = userEvent.setup();
      const { props } = renderSidebar({ activeSessionId: "web-alpha" });

      await user.click(screen.getByText("beta"));
      expect(props.onSelectSession).toHaveBeenCalledWith("web-beta");
    });

    it("does not call onSelectSession when clicking the active session", async () => {
      const user = userEvent.setup();
      const { props } = renderSidebar({ activeSessionId: "web-alpha" });

      await user.click(screen.getByText("alpha"));
      expect(props.onSelectSession).not.toHaveBeenCalled();
    });
  });

  describe("per-session mute", () => {
    it("mutes an unmuted session via onUpdateSession({ muted: true })", async () => {
      const user = userEvent.setup();
      const onUpdateSession = vi.fn();
      renderSidebar({ onUpdateSession });

      // Open the first row's actions menu, then click Mute.
      const menuBtn = screen.getAllByTitle("Session actions")[0];
      if (!menuBtn) throw new Error("no session-actions button rendered");
      await user.click(menuBtn);
      await user.click(screen.getByText("Mute notifications"));

      expect(onUpdateSession).toHaveBeenCalledWith({
        id: "web-alpha",
        muted: true,
      });
    });

    it("unmutes a muted session via onUpdateSession({ muted: false })", async () => {
      const user = userEvent.setup();
      const onUpdateSession = vi.fn();
      const base = sessions[0];
      if (!base) throw new Error("fixture missing");
      const muted: SessionInfo[] = [{ ...base, muted: true }];
      renderSidebar({ sessions: muted, onUpdateSession });

      await user.click(screen.getByTitle("Session actions"));
      await user.click(screen.getByText("Unmute notifications"));

      expect(onUpdateSession).toHaveBeenCalledWith({
        id: "web-alpha",
        muted: false,
      });
    });
  });
});
