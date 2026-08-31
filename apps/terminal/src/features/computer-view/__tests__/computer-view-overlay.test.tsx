import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { ComputerViewOverlay } from "../components/computer-view-overlay";
import { useComputerViewStore } from "../store";

const viewFrame = (revision: number, computerId = "computer-1") => ({
  type: "computer_view" as const,
  computerId,
  revision,
  viewport: { width: 1024, height: 768 },
  status: `revision ${String(revision)}`,
  screenshot: {
    mediaType: "image/png" as const,
    data: revision % 2 === 0 ? "ZXZlbg==" : "b2Rk",
  },
});

describe("ComputerViewOverlay", () => {
  beforeEach(() => {
    useComputerViewStore.getState().clear();
  });

  it("renders the overlay when a computer_view frame is ingested", () => {
    useComputerViewStore.getState().ingest(viewFrame(1));

    render(<ComputerViewOverlay />);

    expect(screen.getByRole("region", { name: "Computer view" })).toBeVisible();
    expect(
      screen.getByAltText(
        "Read-only snapshot of the agent's virtual computer desktop",
      ),
    ).toBeVisible();
  });

  it("hides on 'Back to terminal' but keeps the view current", async () => {
    useComputerViewStore.getState().ingest(viewFrame(1));

    render(<ComputerViewOverlay />);
    await userEvent.click(
      screen.getByRole("button", { name: "Back to terminal" }),
    );

    expect(screen.queryByRole("region", { name: "Computer view" })).toBeNull();
    expect(useComputerViewStore.getState().visible).toBe(false);
    expect(useComputerViewStore.getState().view?.revision).toBe(1);
  });

  it("keeps updating a hidden view with later revisions without reopening it", () => {
    useComputerViewStore.getState().ingest(viewFrame(1));
    useComputerViewStore.getState().hide();
    useComputerViewStore.getState().ingest(viewFrame(2));

    render(<ComputerViewOverlay />);

    expect(screen.queryByRole("region", { name: "Computer view" })).toBeNull();
    expect(useComputerViewStore.getState().visible).toBe(false);
    expect(useComputerViewStore.getState().view?.revision).toBe(2);
  });

  it("records a close tombstone so a stale view cannot reopen or replace it", () => {
    useComputerViewStore.getState().ingest(viewFrame(3));
    useComputerViewStore.getState().ingest({
      type: "computer_closed",
      computerId: "computer-1",
      revision: 5,
    });
    // A view at a revision below the tombstone is dropped entirely.
    useComputerViewStore.getState().ingest(viewFrame(4));

    render(<ComputerViewOverlay />);

    expect(screen.queryByRole("region", { name: "Computer view" })).toBeNull();
    expect(useComputerViewStore.getState()).toMatchObject({
      view: null,
      visible: false,
      revisions: { "computer-1": 5 },
    });
  });
});
