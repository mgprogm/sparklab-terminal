# @sparklab/shared-types

Zod schemas and inferred TypeScript types for the terminal gateway wire protocol (REST + WebSocket control frames).

## Consumption model: source export (no build step)

This package exports TypeScript source directly (`"exports"` points at `src/index.ts`). Consumers must use a bundler or toolchain that can resolve `.ts` imports (Next.js, Vite, tsup, etc.). There is no `build` script and no `dist/` output.

**Why:** The package is workspace-internal (`"private": true`) and every consumer in this monorepo already has a TypeScript-capable bundler. A tsc build step would add CI time and a `^build` dependency edge for zero benefit. If the package is ever published to a registry, add a build step that emits `dist/` with declarations.

## Scripts

- `pnpm run typecheck` -- runs `tsc --noEmit` to validate the source.
