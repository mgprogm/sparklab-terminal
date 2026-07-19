/** @vitest-environment node */
import { beforeEach, describe, expect, it } from "vitest";

import { useBrowserViewStore } from "../store";

const frame = (revision: number, browserId = "browser-1") => ({
  type: "browser_view" as const,
  browserId,
  revision,
  url: `https://example.com/${String(revision)}`,
  title: `Revision ${String(revision)}`,
  viewport: { width: 1280, height: 720 },
  screenshot: { mediaType: "image/png" as const, data: "aGVsbG8=" },
});

describe("browser view store", () => {
  beforeEach(() => useBrowserViewStore.getState().clear());

  it("opens a first view and replaces it with later revisions", () => {
    useBrowserViewStore.getState().ingest(frame(1));
    expect(useBrowserViewStore.getState()).toMatchObject({
      visible: true,
      view: { revision: 1 },
    });

    useBrowserViewStore.getState().ingest(frame(2));
    expect(useBrowserViewStore.getState().view?.revision).toBe(2);
  });

  it("ignores duplicate and stale revisions", () => {
    useBrowserViewStore.getState().ingest(frame(3));
    useBrowserViewStore.getState().ingest(frame(2));
    useBrowserViewStore.getState().ingest(frame(3));
    expect(useBrowserViewStore.getState().view?.revision).toBe(3);
  });

  it("keeps a hidden view current and supports reopening it", () => {
    useBrowserViewStore.getState().ingest(frame(1));
    useBrowserViewStore.getState().hide();
    useBrowserViewStore.getState().ingest(frame(2));
    expect(useBrowserViewStore.getState()).toMatchObject({
      visible: false,
      view: { revision: 2 },
    });
    useBrowserViewStore.getState().show();
    expect(useBrowserViewStore.getState().visible).toBe(true);
  });

  it("only accepts a current closure and opens a different browser", () => {
    useBrowserViewStore.getState().ingest(frame(4));
    useBrowserViewStore.getState().ingest({
      type: "browser_closed",
      browserId: "browser-1",
      revision: 3,
    });
    expect(useBrowserViewStore.getState().view?.revision).toBe(4);

    useBrowserViewStore.getState().ingest(frame(0, "browser-2"));
    expect(useBrowserViewStore.getState()).toMatchObject({
      visible: true,
      view: { browserId: "browser-2", revision: 0 },
    });
  });

  it("keeps a close tombstone so a delayed view cannot reopen the browser", () => {
    useBrowserViewStore.getState().ingest(frame(4));
    useBrowserViewStore.getState().ingest({
      type: "browser_closed",
      browserId: "browser-1",
      revision: 5,
    });
    useBrowserViewStore.getState().ingest(frame(5));
    useBrowserViewStore.getState().ingest(frame(4));

    expect(useBrowserViewStore.getState()).toMatchObject({
      view: null,
      visible: false,
      revisions: { "browser-1": 5 },
    });
  });
});
