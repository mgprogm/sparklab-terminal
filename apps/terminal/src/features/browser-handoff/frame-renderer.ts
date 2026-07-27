export interface DecodedFrame {
  width: number;
  height: number;
  close: () => void;
}

/**
 * Decodes at most one frame at a time and retains only the newest frame that
 * arrives while a decode is running. Every completed decode is painted so a
 * continuous stream cannot starve the canvas while pending frames are skipped.
 */
export class LatestFrameRenderer {
  private pending: Blob | null = null;
  private decoding = false;
  private disposed = false;

  constructor(
    private readonly decode: (frame: Blob) => Promise<DecodedFrame>,
    private readonly render: (frame: DecodedFrame) => void,
  ) {}

  enqueue(frame: Blob): void {
    if (this.disposed) return;
    this.pending = frame;
    void this.drain();
  }

  dispose(): void {
    this.disposed = true;
    this.pending = null;
  }

  private async drain(): Promise<void> {
    if (this.decoding || this.disposed) return;
    const frame = this.pending;
    if (!frame) return;
    this.pending = null;
    this.decoding = true;

    try {
      const decoded = await this.decode(frame);
      try {
        if (!this.disposed) this.render(decoded);
      } finally {
        decoded.close();
      }
    } catch {
      // A corrupt/transient frame must not stop later valid frames.
    } finally {
      this.decoding = false;
      if (this.pending && !this.disposed) void this.drain();
    }
  }
}
