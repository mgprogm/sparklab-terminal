import type { HandoffInput } from "./protocol";

const WHEEL_INTERVAL_MS = 50;
const MAX_WHEEL_DELTA = 2000;

type PointerMove = Extract<HandoffInput, { type: "pointer" }> & {
  action: "move";
};
type Wheel = Extract<HandoffInput, { type: "wheel" }>;

interface SchedulerClock {
  requestAnimationFrame: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame: (handle: number) => void;
  setTimeout: (
    callback: () => void,
    delay: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
}

const browserClock: SchedulerClock = {
  requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
  cancelAnimationFrame: (handle) => window.cancelAnimationFrame(handle),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle),
};

const clampWheel = (value: number) =>
  Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, value));

/** Coalesces noisy input while flushing it before ordered click/key events. */
export class HandoffInputScheduler {
  private move: PointerMove | null = null;
  private wheel: Wheel | null = null;
  private animationFrame: number | null = null;
  private wheelTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly output: (input: HandoffInput) => void,
    private readonly clock: SchedulerClock = browserClock,
  ) {}

  send(input: HandoffInput): void {
    if (input.type === "pointer" && input.action === "move") {
      this.move = input as PointerMove;
      if (this.animationFrame === null) {
        this.animationFrame = this.clock.requestAnimationFrame(() => {
          this.animationFrame = null;
          this.flushMove();
        });
      }
      return;
    }

    if (input.type === "wheel") {
      this.wheel = this.wheel
        ? {
            type: "wheel",
            x: input.x,
            y: input.y,
            deltaX: clampWheel(this.wheel.deltaX + input.deltaX),
            deltaY: clampWheel(this.wheel.deltaY + input.deltaY),
          }
        : input;
      if (this.wheelTimer === null) {
        this.wheelTimer = this.clock.setTimeout(() => {
          this.wheelTimer = null;
          this.flushWheel();
        }, WHEEL_INTERVAL_MS);
      }
      return;
    }

    // Down/up and keyboard events must never overtake the location/scroll that
    // immediately preceded them.
    this.flushPending();
    this.output(input);
  }

  dispose(): void {
    if (this.animationFrame !== null)
      this.clock.cancelAnimationFrame(this.animationFrame);
    if (this.wheelTimer !== null) this.clock.clearTimeout(this.wheelTimer);
    this.animationFrame = null;
    this.wheelTimer = null;
    this.move = null;
    this.wheel = null;
  }

  private flushPending(): void {
    if (this.animationFrame !== null) {
      this.clock.cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    if (this.wheelTimer !== null) {
      this.clock.clearTimeout(this.wheelTimer);
      this.wheelTimer = null;
    }
    this.flushMove();
    this.flushWheel();
  }

  private flushMove(): void {
    if (!this.move) return;
    const move = this.move;
    this.move = null;
    this.output(move);
  }

  private flushWheel(): void {
    if (!this.wheel) return;
    const wheel = this.wheel;
    this.wheel = null;
    this.output(wheel);
  }
}
