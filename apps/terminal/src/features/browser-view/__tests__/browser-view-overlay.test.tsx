import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { BrowserViewOverlay } from "../components/browser-view-overlay";
import { useBrowserViewStore } from "../store";

describe("BrowserViewOverlay", () => {
  beforeEach(() => useBrowserViewStore.getState().clear());

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
});
