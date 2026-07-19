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
});
