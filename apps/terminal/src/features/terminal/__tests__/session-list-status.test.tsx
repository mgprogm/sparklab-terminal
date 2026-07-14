import { SessionInfoSchema, type SessionInfo } from "@sparklab/shared-types";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SessionList } from "../components/session-list";

import type { ReactNode } from "react";

vi.mock("@sparklab/ui/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@sparklab/ui/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@sparklab/ui/components/ui/alert-dialog", () => ({
  AlertDialog: ({ children }: { children: ReactNode }) => <>{children}</>,
  AlertDialogAction: ({ children }: { children: ReactNode }) => (
    <button>{children}</button>
  ),
  AlertDialogCancel: ({ children }: { children: ReactNode }) => (
    <button>{children}</button>
  ),
  AlertDialogContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogDescription: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogFooter: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogTitle: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@sparklab/ui/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogFooter: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@sparklab/ui/components/ui/button", () => ({
  Button: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));

function renderList(sessions: SessionInfo[]) {
  return render(
    <SessionList
      sessions={sessions}
      activeSessionId={null}
      onSelectSession={vi.fn()}
      onCreateSession={vi.fn()}
      onDeleteSession={vi.fn()}
    />,
  );
}

describe("B2 session status badges", () => {
  it("shows viewer count when attachedClients > 0", () => {
    renderList([
      {
        id: "web-a",
        name: "alpha",
        createdAt: null,
        tags: [],
        currentCommand: "",
        attached: true,
        attachedClients: 2,
        lastActivity: undefined,
      },
    ]);

    expect(screen.getByText("2 viewers")).toBeInTheDocument();
  });

  it("shows idle time when only lastActivity present", () => {
    renderList([
      {
        id: "web-a",
        name: "alpha",
        createdAt: null,
        tags: [],
        currentCommand: "",
        attached: true,
        lastActivity: Math.floor(Date.now() / 1000) - 7200,
      },
    ]);

    expect(screen.getByText(/idle 2h/)).toBeInTheDocument();
  });

  it("shows nothing for sessions without new fields (old gateway compat)", () => {
    renderList([
      {
        id: "web-a",
        name: "alpha",
        createdAt: null,
        tags: [],
        currentCommand: "",
        attached: false,
      },
    ]);

    expect(screen.queryByText(/viewer|idle/)).not.toBeInTheDocument();
  });

  it("SessionInfo schema accepts items with and without the new fields", () => {
    const base = {
      id: "web-a",
      name: "a",
      createdAt: null,
      tags: [],
      currentCommand: "",
      attached: false,
    };

    expect(() => SessionInfoSchema.parse(base)).not.toThrow();
    expect(() =>
      SessionInfoSchema.parse({
        ...base,
        attachedClients: 3,
        lastActivity: 1720000000,
      }),
    ).not.toThrow();
  });
});
