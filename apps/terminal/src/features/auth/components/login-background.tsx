"use client";

import { useEffect, useRef } from "react";

/**
 * Mouse-interactive dot-field background for the login screen.
 *
 * A grid of muted warm dots breathes slowly on its own; dots near the
 * pointer are pushed away and brighten toward the ink color, easing back
 * when the pointer leaves. Honors prefers-reduced-motion by rendering a
 * single static frame.
 */

const GRID_GAP = 34;
const DOT_RADIUS = 1.1;
const INFLUENCE_RADIUS = 160;
const REPEL_STRENGTH = 26;
const EASE = 0.08;

// Warm palette from DESIGN.md: hairline base → body-tone highlight.
const BASE_RGB = [63, 58, 54] as const; // #3f3a36
const GLOW_RGB = [201, 192, 173] as const; // #c9c0ad

type Dot = {
  originX: number;
  originY: number;
  x: number;
  y: number;
  phase: number;
};

export function LoginBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    let dots: Dot[] = [];
    let width = 0;
    let height = 0;
    let rafId = 0;
    const pointer = { x: -1e4, y: -1e4 };

    const rebuild = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      dots = [];
      const offsetX = ((width % GRID_GAP) - GRID_GAP) / 2;
      const offsetY = ((height % GRID_GAP) - GRID_GAP) / 2;
      for (let y = offsetY; y < height + GRID_GAP; y += GRID_GAP) {
        for (let x = offsetX; x < width + GRID_GAP; x += GRID_GAP) {
          dots.push({
            originX: x,
            originY: y,
            x,
            y,
            phase: (x * 0.7 + y * 1.3) % (Math.PI * 2),
          });
        }
      }
    };

    const draw = (time: number) => {
      ctx.clearRect(0, 0, width, height);
      const t = time * 0.001;

      for (const dot of dots) {
        // Ambient breathing drift, independent of the pointer.
        const driftX = reducedMotion ? 0 : Math.sin(t * 0.6 + dot.phase) * 2;
        const driftY = reducedMotion
          ? 0
          : Math.cos(t * 0.45 + dot.phase * 1.7) * 2;

        let targetX = dot.originX + driftX;
        let targetY = dot.originY + driftY;

        const dx = dot.originX - pointer.x;
        const dy = dot.originY - pointer.y;
        const dist = Math.hypot(dx, dy);
        let glow = 0;

        if (dist < INFLUENCE_RADIUS) {
          const falloff = 1 - dist / INFLUENCE_RADIUS;
          glow = falloff * falloff;
          const push = (REPEL_STRENGTH * glow) / Math.max(dist, 1);
          targetX += dx * push;
          targetY += dy * push;
        }

        dot.x += (targetX - dot.x) * EASE;
        dot.y += (targetY - dot.y) * EASE;

        const r = BASE_RGB[0] + (GLOW_RGB[0] - BASE_RGB[0]) * glow;
        const g = BASE_RGB[1] + (GLOW_RGB[1] - BASE_RGB[1]) * glow;
        const b = BASE_RGB[2] + (GLOW_RGB[2] - BASE_RGB[2]) * glow;

        ctx.beginPath();
        ctx.arc(dot.x, dot.y, DOT_RADIUS + glow * 1.4, 0, Math.PI * 2);
        ctx.fillStyle = `rgb(${r | 0}, ${g | 0}, ${b | 0})`;
        ctx.fill();
      }
    };

    const loop = (time: number) => {
      draw(time);
      rafId = requestAnimationFrame(loop);
    };

    const onPointerMove = (event: PointerEvent) => {
      pointer.x = event.clientX;
      pointer.y = event.clientY;
    };
    const onPointerLeave = () => {
      pointer.x = -1e4;
      pointer.y = -1e4;
    };

    rebuild();
    if (reducedMotion) {
      draw(0);
    } else {
      rafId = requestAnimationFrame(loop);
    }

    window.addEventListener("resize", rebuild);
    window.addEventListener("pointermove", onPointerMove);
    document.documentElement.addEventListener("pointerleave", onPointerLeave);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", rebuild);
      window.removeEventListener("pointermove", onPointerMove);
      document.documentElement.removeEventListener(
        "pointerleave",
        onPointerLeave,
      );
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none fixed inset-0"
    />
  );
}
