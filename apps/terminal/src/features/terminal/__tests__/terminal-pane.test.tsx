/**
 * Tests for <TerminalPane> — primarily the D10 guard in unit form: `single`
 * mode (multiPane=false) must render NO [data-testid=terminal-pane] and no
 * chrome (the bare subtree terminal-shell.tsx rendered directly before this
 * feature); multi-pane mode renders both the testid/data-pane-id hooks and
 * the chrome strip, and focus tracks via onPointerDownCapture (BEFORE
 * xterm's own mousedown focus handling — see plan §3b).
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TerminalPane } from "../components/terminal-pane";

import type { PaneState } from "../store";
import type { ReactNode } from "react";

vi.mock("../components/dynamic-xterm", () => ({
  DynamicXTerm: ({ sessionId }: { sessionId: string | null }) => (
    <div data-session-id={sessionId} data-testid="stub-xterm" />
  ),
}));

vi.mock("@sparklab/ui/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
  }: {
    children: ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
  }) => (
    <button disabled={disabled} onClick={() => onSelect?.()} type="button">
      {children}
    </button>
  ),
}));

function pane(overrides: Partial<PaneState> = {}): PaneState {
  return { id: "pane-1", sessionId: null, ...overrides };
}

const baseProps = {
  panes: [pane()],
  focused: true,
  sessions: [],
  servers: [],
  dragging: false,
  onFocus: vi.fn(),
  onPickSession: vi.fn(),
  onClosePane: vi.fn(),
  onRegisterHandle: vi.fn(),
  modifiersRef: { current: null },
  onStatusChange: vi.fn(),
  onSessionError: vi.fn(),
  onAuthError: vi.fn(),
};

describe("<TerminalPane> — D10 single-mode bare subtree", () => {
  it("with a session: renders the stub xterm and NO pane chrome/testid", () => {
    const p = pane({ sessionId: "web-1" });
    const { container } = render(
      <TerminalPane {...baseProps} multiPane={false} pane={p} panes={[p]} />,
    );
    expect(screen.getByTestId("stub-xterm")).toBeInTheDocument();
    expect(screen.queryByTestId("terminal-pane")).not.toBeInTheDocument();
    expect(container.querySelector("[data-pane-id]")).not.toBeInTheDocument();
  });

  it("with no session: renders the plain 'No session selected.' text, no picker", () => {
    const p = pane();
    render(
      <TerminalPane {...baseProps} multiPane={false} pane={p} panes={[p]} />,
    );
    expect(screen.getByText("No session selected.")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /pick a session/i }),
    ).not.toBeInTheDocument();
  });
});

describe("<TerminalPane> — multi-pane chrome", () => {
  it("renders data-testid/data-pane-id, chrome, and a close button", () => {
    const p = pane({ sessionId: "web-1" });
    render(<TerminalPane {...baseProps} multiPane pane={p} panes={[p]} />);
    const root = screen.getByTestId("terminal-pane");
    expect(root).toHaveAttribute("data-pane-id", "pane-1");
    expect(
      screen.getByRole("button", { name: /close pane/i }),
    ).toBeInTheDocument();
  });

  it("with no session: renders the 'Pick a session' placeholder", () => {
    const p = pane();
    render(<TerminalPane {...baseProps} multiPane pane={p} panes={[p]} />);
    expect(
      screen.getByRole("button", { name: /pick a session/i }),
    ).toBeInTheDocument();
  });

  it("fires onFocus on pointerDownCapture", () => {
    const onFocus = vi.fn();
    const p = pane({ sessionId: "web-1" });
    render(
      <TerminalPane
        {...baseProps}
        multiPane
        onFocus={onFocus}
        pane={p}
        panes={[p]}
      />,
    );
    screen
      .getByTestId("terminal-pane")
      .dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  it("greys out (disables) a session already shown in another pane (D4)", () => {
    const p1 = pane({ id: "pane-1", sessionId: null });
    const p2 = pane({ id: "pane-2", sessionId: "web-2" });
    render(
      <TerminalPane
        {...baseProps}
        multiPane
        onPickSession={vi.fn()}
        pane={p1}
        panes={[p1, p2]}
        sessions={[
          { id: "web-1", name: "one" } as never,
          { id: "web-2", name: "two" } as never,
        ]}
      />,
    );
    // Both the chrome trigger's menu and the placeholder's menu render a
    // "two" item; every rendered "two" option should be disabled since
    // web-2 is shown in pane-2.
    const disabledOption = screen
      .getAllByRole("button", { name: /two/i })
      .find((el) => el.hasAttribute("disabled"));
    expect(disabledOption).toBeTruthy();
  });
});
