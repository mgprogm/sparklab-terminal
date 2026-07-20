import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ChatHistoryDialog } from "../components/chat-history-dialog";

import type { AgentChatSummary } from "@sparklab/shared-types";

const chats: AgentChatSummary[] = [
  {
    id: "chat-current",
    title: "Investigate deployment logs",
    updatedAt: Date.now() - 60_000,
    messageCount: 4,
    terminalSessionId: "terminal-1",
  },
  {
    id: "chat-older",
    title: "Fix the failing build",
    updatedAt: Date.now() - 3_600_000,
    messageCount: 1,
    terminalSessionId: "terminal-1",
  },
];

function renderDialog(
  overrides: Partial<React.ComponentProps<typeof ChatHistoryDialog>> = {},
) {
  const props: React.ComponentProps<typeof ChatHistoryDialog> = {
    open: true,
    onOpenChange: vi.fn(),
    chats,
    activeChatId: "chat-current",
    terminalName: "api-server",
    onSelect: vi.fn(),
    onDelete: vi.fn(),
    onNew: vi.fn(),
    ...overrides,
  };

  const utils = render(<ChatHistoryDialog {...props} />);
  return { ...utils, props };
}

describe("ChatHistoryDialog", () => {
  it("makes the terminal scope and current conversation explicit", () => {
    renderDialog();

    expect(
      screen.getByRole("heading", { name: "Chat history" }),
    ).toBeInTheDocument();
    expect(screen.getByText("api-server")).toBeInTheDocument();
    expect(screen.getByText("2 conversations")).toBeInTheDocument();
    expect(screen.getByText("Current")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Investigate deployment logs/i }),
    ).toHaveAttribute("aria-current", "true");
  });

  it("starts or resumes a conversation and closes the dialog", async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();

    await user.click(screen.getByRole("button", { name: /Start a new chat/i }));
    expect(props.onNew).toHaveBeenCalledOnce();
    expect(props.onOpenChange).toHaveBeenLastCalledWith(false);

    await user.click(
      screen.getByRole("button", { name: /^Fix the failing build/i }),
    );
    expect(props.onSelect).toHaveBeenCalledWith("chat-older");
    expect(props.onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("deletes the intended chat without selecting it", async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();

    await user.click(
      screen.getByRole("button", {
        name: "Delete chat: Fix the failing build",
      }),
    );

    expect(props.onDelete).toHaveBeenCalledWith("chat-older");
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("explains the empty state in the context of the selected terminal", () => {
    renderDialog({ chats: [], activeChatId: null });

    expect(screen.getByText("No conversations yet")).toBeInTheDocument();
    expect(screen.getByText(/linked only to api-server/i)).toBeInTheDocument();
  });
});
