/** @vitest-environment node */
import { beforeEach, describe, expect, it } from "vitest";

import { useComputerViewStore } from "../store";

const frame = (revision: number, computerId = "computer-1") => ({
  type: "computer_view" as const,
  computerId,
  revision,
  viewport: { width: 1024, height: 768 },
  status: `revision ${String(revision)}`,
  screenshot: { mediaType: "image/png" as const, data: "aGVsbG8=" },
});

describe("computer view store", () => {
  beforeEach(() => useComputerViewStore.getState().clear());

  it("opens a first view and replaces it with later revisions", () => {
    useComputerViewStore.getState().ingest(frame(1));
    expect(useComputerViewStore.getState()).toMatchObject({
      visible: true,
      view: { revision: 1 },
    });

    useComputerViewStore.getState().ingest(frame(2));
    expect(useComputerViewStore.getState().view?.revision).toBe(2);
  });

  it("ignores duplicate and stale revisions", () => {
    useComputerViewStore.getState().ingest(frame(3));
    useComputerViewStore.getState().ingest(frame(2));
    useComputerViewStore.getState().ingest(frame(3));
    expect(useComputerViewStore.getState().view?.revision).toBe(3);
  });

  it("keeps a hidden view current and supports reopening it", () => {
    useComputerViewStore.getState().ingest(frame(1));
    useComputerViewStore.getState().hide();
    useComputerViewStore.getState().ingest(frame(2));
    expect(useComputerViewStore.getState()).toMatchObject({
      visible: false,
      view: { revision: 2 },
    });
    useComputerViewStore.getState().show();
    expect(useComputerViewStore.getState().visible).toBe(true);
  });

  it("only accepts a current closure and opens a different computer", () => {
    useComputerViewStore.getState().ingest(frame(4));
    useComputerViewStore.getState().ingest({
      type: "computer_closed",
      computerId: "computer-1",
      revision: 3,
    });
    expect(useComputerViewStore.getState().view?.revision).toBe(4);

    useComputerViewStore.getState().ingest(frame(0, "computer-2"));
    expect(useComputerViewStore.getState()).toMatchObject({
      visible: true,
      view: { computerId: "computer-2", revision: 0 },
    });
  });

  it("keeps a close tombstone so a delayed view cannot reopen the desktop", () => {
    useComputerViewStore.getState().ingest(frame(4));
    useComputerViewStore.getState().ingest({
      type: "computer_closed",
      computerId: "computer-1",
      revision: 5,
    });
    useComputerViewStore.getState().ingest(frame(5));
    useComputerViewStore.getState().ingest(frame(4));

    expect(useComputerViewStore.getState()).toMatchObject({
      view: null,
      visible: false,
      revisions: { "computer-1": 5 },
    });
  });
});
