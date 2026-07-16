"use client";

import { Fingerprint } from "lucide-react";

import { usePressAndHold } from "../hooks/use-press-and-hold";

/**
 * Mobile stealth-reveal affordance for the login screen.
 *
 * A full-screen, touch-only overlay: pressing and holding for HOLD_MS reveals
 * the login form (the touch counterpart to Ctrl+Space on desktop). A ring fills
 * over the hold duration so the gesture is discoverable and gives live progress.
 *
 * Gated to coarse pointers purely in CSS (`pointer-coarse:` variants), so it is
 * `display:none` + `pointer-events:none` on desktop — no JS media query, no
 * hydration flash, and desktop behavior is untouched (a mouse can never trigger
 * the hold because the overlay doesn't receive pointer events there).
 *
 * Palette matches the login screen's own hardcoded canvas (this pre-auth screen
 * deliberately doesn't use the app theme tokens).
 */

const HOLD_MS = 3000;
const RING_RADIUS = 34;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function HoldToReveal({ onReveal }: { onReveal: () => void }) {
  const { holding, handlers } = usePressAndHold({
    onComplete: onReveal,
    durationMs: HOLD_MS,
  });

  return (
    <div
      {...handlers}
      role="button"
      tabIndex={-1}
      aria-label="Press and hold for three seconds to reveal the login form"
      className="pointer-coarse:pointer-events-auto pointer-coarse:flex pointer-events-none fixed inset-0 z-10 hidden touch-none select-none flex-col items-center justify-center gap-5"
      style={{ WebkitTouchCallout: "none", WebkitUserSelect: "none" }}
    >
      <div className="relative flex size-[88px] items-center justify-center">
        <svg
          className="absolute inset-0 -rotate-90"
          viewBox="0 0 80 80"
          aria-hidden="true"
        >
          {/* Track */}
          <circle
            cx="40"
            cy="40"
            r={RING_RADIUS}
            fill="none"
            stroke="#4a443f"
            strokeWidth="3"
          />
          {/* Progress — fills over HOLD_MS while holding, eases back on release */}
          <circle
            cx="40"
            cy="40"
            r={RING_RADIUS}
            fill="none"
            stroke="#c9c0ad"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            style={{
              strokeDashoffset: holding ? 0 : RING_CIRCUMFERENCE,
              transition: holding
                ? `stroke-dashoffset ${HOLD_MS}ms linear`
                : "stroke-dashoffset 300ms ease-out",
            }}
          />
        </svg>
        <Fingerprint
          aria-hidden="true"
          className={`size-8 transition-colors duration-300 ${
            holding ? "text-[#f7f5f0]" : "text-[#8a827a]"
          }`}
        />
      </div>
      <p className="text-sm font-medium tracking-wide text-[#8a827a]">
        {holding ? "Keep holding…" : "Press and hold to sign in"}
      </p>
    </div>
  );
}
