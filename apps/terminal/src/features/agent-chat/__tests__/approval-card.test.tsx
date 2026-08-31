import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ApprovalCard } from "../components/approval-card";

describe("ApprovalCard browser actions", () => {
  it("offers a one-time browser approval without auto-approve", async () => {
    const onRespond = vi.fn();
    render(
      <ApprovalCard
        entry={{
          kind: "approval",
          id: "approval-1",
          tool: "browser_act",
          summary: "Navigate to example.com",
          input: { action: "navigate", url: "https://example.com" },
          state: "pending",
        }}
        onRespond={onRespond}
      />,
    );

    expect(screen.getByText("Browser approval needed")).toBeInTheDocument();
    expect(screen.queryByText(/Auto-approve/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Approve once/ }));
    expect(onRespond).toHaveBeenCalledWith("allow");
  });

  it("shows the exact capture path and overwrite warning", async () => {
    const onRespond = vi.fn();
    render(
      <ApprovalCard
        entry={{
          kind: "approval",
          id: "approval-capture",
          tool: "browser_capture",
          summary: "capture browser screen to /tmp/captures/page.png",
          input: {
            session_id: "web-one",
            path: "/tmp/captures/page.png",
          },
          state: "pending",
        }}
        sessionName="work"
        onRespond={onRespond}
      />,
    );

    expect(
      screen.getByText("Save the current browser screen"),
    ).toBeInTheDocument();
    expect(screen.getByText("/tmp/captures/page.png")).toBeInTheDocument();
    expect(screen.getByText("work")).toBeInTheDocument();
    expect(
      screen.getByText(/writes or overwrites the file once/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Auto-approve/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Approve once/ }));
    expect(onRespond).toHaveBeenCalledWith("allow");
  });
});

describe("ApprovalCard computer actions", () => {
  it("labels a click by kind, not the generic 'type into' fallback, and offers no auto-approve", async () => {
    const onRespond = vi.fn();
    render(
      <ApprovalCard
        entry={{
          kind: "approval",
          id: "approval-computer-click",
          tool: "computer_act",
          summary: "click computer element 0",
          input: { kind: "click", element_index: 0, snapshot_id: "snap-1" },
          state: "pending",
        }}
        onRespond={onRespond}
      />,
    );

    expect(screen.getByText("Computer approval needed")).toBeInTheDocument();
    expect(screen.getByText("click on the computer")).toBeInTheDocument();
    expect(screen.getByText("click computer element 0")).toBeInTheDocument();
    expect(screen.queryByText(/type into/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Auto-approve/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Approve once/ }));
    expect(onRespond).toHaveBeenCalledWith("allow");
  });

  it("labels a type_text action correctly and never renders the typed text", async () => {
    const onRespond = vi.fn();
    render(
      <ApprovalCard
        entry={{
          kind: "approval",
          id: "approval-computer-type",
          tool: "computer_act",
          summary: "type into computer element 2: [redacted]",
          input: { kind: "type_text", element_index: 2, text: "secret" },
          state: "pending",
        }}
        onRespond={onRespond}
      />,
    );

    expect(screen.getByText("type into the computer")).toBeInTheDocument();
    expect(
      screen.getByText("type into computer element 2: [redacted]"),
    ).toBeInTheDocument();
    expect(screen.queryByText("secret")).not.toBeInTheDocument();
  });

  it("shows the destination path for a computer_capture and its terminal session badge", async () => {
    const onRespond = vi.fn();
    render(
      <ApprovalCard
        entry={{
          kind: "approval",
          id: "approval-computer-capture",
          tool: "computer_capture",
          summary: "capture computer screen to /tmp/desktop.png",
          input: { session_id: "web-one", path: "/tmp/desktop.png" },
          state: "pending",
        }}
        sessionName="work"
        onRespond={onRespond}
      />,
    );

    expect(screen.getByText("save a computer screenshot")).toBeInTheDocument();
    expect(screen.getByText("/tmp/desktop.png")).toBeInTheDocument();
    expect(screen.getByText("work")).toBeInTheDocument();
    expect(screen.queryByText(/Auto-approve/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Approve once/ }));
    expect(onRespond).toHaveBeenCalledWith("allow");
  });
});
