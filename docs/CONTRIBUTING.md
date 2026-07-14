# Contributing

## Code organization: features, not file types

Next.js apps use feature/domain folders. `app/` directories are **routing only** (`layout.tsx`, `page.tsx`, `loading.tsx`, `error.tsx`) — they compose features and hold no business logic.

```
apps/<app>/src/
├── app/                      # routes only
├── features/<feature>/
│   ├── components/           # feature-private UI
│   ├── hooks/                # incl. TanStack Query hooks
│   ├── api.ts                # fetchers — Zod-parse at the boundary
│   ├── store.ts              # Zustand slice (client/UI state only)
│   ├── schemas.ts            # Zod schemas + z.infer types
│   └── index.ts              # the ONLY public surface
├── components/               # app-level shared composition of @sparklab/ui
├── lib/                      # query-client, fetch wrapper, utils
└── stores/                   # truly global Zustand stores only
```

Rules:

- Cross-feature imports go through the feature's `index.ts` only.
- Import workspace packages by name (`@sparklab/ui`), never by relative path across packages.
- Path alias `@/*` → `src/*` inside each app.

## State rules

- **Server data lives in TanStack Query, never in Zustand.** Zustand is for UI/client state (selection, collapsed panels, wizard steps). Use `persist` middleware instead of hand-rolled localStorage.
- Query keys come from per-feature factories (see `apps/web/src/lib/query-keys.ts`); mutations invalidate via the same factories.
- `QueryClient` is created in `useState` inside a client Providers component — never at module level.

## Forms

One Zod schema per form in the feature's `schemas.ts`; `useForm({ resolver: zodResolver(schema) })`; submit through a TanStack mutation; map server errors with `setError`.

## UI components

- Shared primitives live in `packages/ui` (shadcn-generated, checked in, editable). Add new ones by running `pnpm dlx shadcn@latest add <component>` **inside `packages/ui`**.
- Consuming apps need the package in `transpilePackages` (next.config.ts) and its source covered by Tailwind `@source` globs — a broken glob silently drops styles.
- Tailwind v4, CSS-first: theme tokens live in `packages/ui/src/styles/globals.css`.

## TypeScript & linting

- All configs extend the shared packages (`@sparklab/config-typescript`, `@sparklab/config-eslint`, `@sparklab/config-vitest`). Don't fork settings per-app; change the shared config if a rule needs to move.
- Strict mode plus `noUncheckedIndexedAccess` is on everywhere — do not weaken a tsconfig to make code pass.
- Next.js apps typecheck via `tsconfig.check.json` (excludes `.next/types`, which only exists after a build).

## The terminal feature: special rules

The terminal client has invariants that look like refactoring opportunities but aren't — read [TERMINAL-PROTOCOL.md](TERMINAL-PROTOCOL.md) first. In short:

- `connection.ts` stays a class outside React. Don't convert it to hooks.
- `xterm.tsx` must never re-render on terminal output; session switching swaps the Connection, never remounts the Terminal.
- Binary WS frames stay binary; no string decoding mid-pipeline.
- The gateway (`apps/terminal-gateway`) is plain JS on purpose; don't TypeScript-ify it as a drive-by.
- Never `tmux kill-session` outside the DELETE endpoint.

## Commits & hooks

- **Conventional commits** enforced by commitlint (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`, with optional scope, e.g. `feat(terminal): …`).
- Pre-commit runs lint-staged (prettier on staged files); eslint runs per-workspace via `turbo lint`.
- Work on feature branches; `master`/`main` goes through PRs and CI.

## Before you push

```bash
pnpm turbo lint typecheck test build   # must be fully green
pnpm --filter e2e test                 # if you touched terminal/gateway code
```

See [TESTING.md](TESTING.md) for which suites map to which kinds of change.
