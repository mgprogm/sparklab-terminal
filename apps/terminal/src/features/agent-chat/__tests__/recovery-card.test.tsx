import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { RecoveryCard } from "../components/recovery-card";

describe("RecoveryCard", () => {
  it("requires explicit verification or cancellation", async () => {
    const onResolve = vi.fn();
    render(
      <RecoveryCard
        entry={{
          kind: "recovery",
          id: "recovery-1",
          text: "A tool outcome is unknown.",
          state: "pending",
        }}
        onResolve={onResolve}
      />,
    );

    expect(screen.getByText("Verify before continuing")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Verify & continue" }),
    );
    expect(onResolve).toHaveBeenCalledWith("verified");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onResolve).toHaveBeenCalledWith("cancelled");
  });
});
