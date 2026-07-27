// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { LatestFrameRenderer } from "../frame-renderer";

import type { DecodedFrame } from "../frame-renderer";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const decoded = (width: number): DecodedFrame => ({
  width,
  height: 1,
  close: vi.fn(),
});

describe("LatestFrameRenderer", () => {
  it("keeps one decode in flight and skips directly to the newest frame", async () => {
    const first = deferred<DecodedFrame>();
    const latest = deferred<DecodedFrame>();
    const decode = vi
      .fn<(frame: Blob) => Promise<DecodedFrame>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(latest.promise);
    const render = vi.fn();
    const renderer = new LatestFrameRenderer(decode, render);
    const frame1 = new Blob(["1"]);
    const frame2 = new Blob(["2"]);
    const frame3 = new Blob(["3"]);

    renderer.enqueue(frame1);
    renderer.enqueue(frame2);
    renderer.enqueue(frame3);
    expect(decode).toHaveBeenCalledTimes(1);

    const firstBitmap = decoded(1);
    first.resolve(firstBitmap);
    await Promise.resolve();
    await Promise.resolve();
    expect(render).toHaveBeenCalledWith(firstBitmap);
    expect(firstBitmap.close).toHaveBeenCalledOnce();
    expect(decode).toHaveBeenLastCalledWith(frame3);

    const latestBitmap = decoded(3);
    latest.resolve(latestBitmap);
    await Promise.resolve();
    await Promise.resolve();
    expect(render).toHaveBeenLastCalledWith(latestBitmap);
    expect(render).toHaveBeenCalledTimes(2);
    expect(latestBitmap.close).toHaveBeenCalledOnce();
  });
});
