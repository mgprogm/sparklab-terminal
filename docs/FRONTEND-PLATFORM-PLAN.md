# Frontend Platform Plan: Turborepo + Next.js, with Web-Terminal Migration

Status: **approved for implementation** (2026-07-14).
Implementation happens on branch `feat/monorepo-platform`; `master` keeps the Phase-1 vanilla-JS app until the Phase-4 cut-over gates pass.

## Fixed stack (do not re-litigate)

- Framework: Next.js (App Router) + React
- Language: TypeScript, strict mode
- Server state: TanStack Query · Client state: Zustand
- UI: shadcn/ui + Tailwind CSS · Forms: React Hook Form + Zod
- Monorepo: Turborepo + pnpm workspaces
- Testing: Vitest + React Testing Library + Playwright (E2E)

## Decisions taken (defaults; revisit if needed)

1. **Grow this repo in place** into the monorepo (no new repo). Work on `feat/monorepo-platform`.
2. **Node 24** (`.nvmrc`, `engines`) — matches the host and the existing node-pty build.
3. **Tailwind v4** (CSS-first config) in `packages/ui`.
4. **Origin strategy**: dev uses `NEXT_PUBLIC_GATEWAY_URL` pointing at the gateway port (CORS on gateway for REST; WS direct). Prod recommendation: single-origin reverse proxy (Caddy/nginx) — documented, not implemented yet.
5. `exactOptionalPropertyTypes`: **deferred** (strict + `noUncheckedIndexedAccess` + `noImplicitOverride` + `verbatimModuleSyntax` from day one).
6. **Gateway stays plain JS**, moved verbatim; TS conversion is a later, separate task.
7. Package scope: **`@sparklab/*`**.

## 1. Monorepo layout

```
claude-web-terminal/            # this repo becomes the workspace root
├── apps/
│   ├── web/                    # main product (Next.js)
│   ├── terminal/               # migrated web terminal (Next.js)
│   ├── terminal-gateway/       # existing Node gateway, moved verbatim
│   └── e2e/                    # Playwright project
├── packages/
│   ├── ui/                     # shadcn/ui components + Tailwind preset
│   ├── config-typescript/      # shared tsconfig bases (base/nextjs/react-library/node)
│   ├── config-eslint/          # shared flat ESLint configs
│   ├── config-vitest/          # shared vitest presets (base + react)
│   └── shared-types/           # Zod schemas: REST payloads + WS control frames
├── docs/                       # this plan + DESIGN-SYSTEM.md
├── turbo.json
├── pnpm-workspace.yaml
├── package.json                # workspace root: turbo, prettier, husky, lint-staged only
├── .nvmrc                      # 24
└── .npmrc                      # engine-strict=true
```

`turbo.json` pipeline: `build` (dependsOn `^build`), `lint`, `typecheck`, `test`, `dev` (persistent, no cache), `e2e` (no cache).

Package creation order: config-typescript → config-eslint → config-vitest → ui → shared-types.

## 2. Next.js app structure — feature/domain-based

`app/` is routing ONLY (`layout.tsx`, `page.tsx`, `loading.tsx`, `error.tsx`). All logic lives in features:

```
apps/<app>/src/
├── app/                        # routes compose features; no business logic
├── features/<feature>/
│   ├── components/             # feature-private UI
│   ├── hooks/                  # incl. TanStack Query hooks
│   ├── api.ts                  # fetchers, Zod-parsed at the boundary
│   ├── store.ts                # Zustand slice (client/UI state only)
│   ├── schemas.ts              # Zod schemas + z.infer types
│   └── index.ts                # ONLY public surface for cross-feature imports
├── components/                 # app-level shared composition of @sparklab/ui
├── lib/                        # query-client.ts, fetch wrapper, utils
├── stores/                     # truly global Zustand stores only
└── styles/globals.css
```

Rules: no business logic in `page.tsx`; cross-feature imports only via `index.ts`; `@/*` → `src/*`; workspace packages imported by name, never by relative path.

## 3. Tooling baseline

- Shared tsconfig bases in `@sparklab/config-typescript`: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`, `isolatedModules`, `moduleResolution: "bundler"`.
- Every workspace has a `typecheck` script (`tsc --noEmit`).
- Prettier at root only, with `prettier-plugin-tailwindcss`.
- ESLint 9 flat configs from `@sparklab/config-eslint`; each workspace has a tiny `eslint.config.mjs` re-export.
- husky + lint-staged (pre-commit: eslint --fix + prettier on staged) + commitlint (conventional commits).

## 4. Core library wiring

- **TanStack Query**: `QueryClient` created in `useState` inside a `'use client'` `Providers` component (never module-level). Per-feature query-key factories. Default `staleTime` ≥ 30s.
- **Zustand**: server data NEVER lives in Zustand — UI/client state only. Per-feature store files exporting hooks; selectors at call sites; `persist` middleware replaces hand-rolled localStorage.
- **shadcn/ui + Tailwind in `packages/ui`**: owns the Tailwind preset/tokens, `globals.css`, generated components (checked in, editable), `cn()`, `components.json`. Apps use `transpilePackages: ["@sparklab/ui"]` and content globs/`@source` covering `packages/ui/src`.
- **RHF + Zod**: one schema per form in `schemas.ts`; `zodResolver`; submit → mutation; server errors via `setError`.

## 5. Testing

- Vitest + RTL via `@sparklab/config-vitest` (jsdom, jest-dom setup). Unit: schemas, utils, hooks (with QueryClientProvider wrapper), component behavior.
- Playwright in `apps/e2e`; `webServer` boots the apps; E2E = user journeys only.
- **The tmux smoke/acceptance scripts move with the gateway and stay as-is** (`apps/terminal-gateway/test/`) — they are the load-bearing job-survival tests. Do not rewrite them into Playwright.

## 6. CI/CD outline

GitHub Actions: setup-node from `.nvmrc` + pnpm cache → `pnpm install --frozen-lockfile` → `pnpm turbo lint typecheck test build` (one invocation, cached) → separate Playwright job (needs `tmux` on the runner; upload traces on failure). Turborepo remote caching and `--affected` filtering as the repo grows.

## 7. Web-terminal migration (the careful part)

**Gateway moves untouched** to `apps/terminal-gateway/` (`src/server.js`, `src/metadata.js`, `test/*`, its `package.json`). Invariants stay owned by it: `encoding: null` ptys, binary WS frames, `pty.kill()`-only teardown, `tmux kill-session` only in explicit DELETE. Static serving of the old `public/` stays during transition; deleted only after Phase-4 gates.

**New frontend `apps/terminal/`**, `features/terminal/`:

- `connection.ts` — port the `Connection` class from `public/app.js` **almost verbatim to TypeScript, outside React**. Keep the class; do not translate its lifecycle (single live connection, `noReconnect` guard, heartbeat, backoff) into hooks.
- `components/XTerm.tsx` — safety rules:
  - `'use client'` + `next/dynamic(..., { ssr: false })` — xterm must never SSR.
  - Terminal in `useRef`; created once in an effect with `[]` deps; StrictMode-safe cleanup fully disposes Connection + terminal.
  - The component **never re-renders on terminal output**; stable callback props; session switch via imperative handle, not remount. FitAddon + ResizeObserver in the same effect; WebGL addon in try/catch.
  - Invariants preserved: `ws.binaryType = 'arraybuffer'`; `freshConnect` → `term.reset()` on first binary frame after (re)connect; keystrokes `TextEncoder` → binary frames; JSON text frames only for control (`resize`, `ping`/`pong`, `exit`).
- `hooks/use-sessions.ts` — TanStack Query replaces setInterval polling (`refetchInterval: 3000`); create/delete = mutations with invalidation. `activeSessionId` + `sidebarCollapsed` in Zustand with `persist`. "Active session vanished → fall back" as an effect over query data.
- `packages/shared-types/src/terminal.ts` — Zod schemas for REST payloads and JSON control frames, imported by the frontend (gateway optionally later).
- Modals → shadcn `Dialog`/`AlertDialog`; return focus to the terminal on close.

**Vendoring**: `scripts/vendor-xterm.js` becomes unnecessary — xterm, addons, CSS, and fonts are npm-imported and bundled into `/_next/static` (no CDN, offline/CSP-safe). Add a CI check that the built output has no external script/font URLs.

**Cut-over gates (must ALL pass before deleting `public/app.js` + vendor script):**

1. `smoke` + `acceptance` scripts still PASS from `apps/terminal-gateway/`.
2. Thai (multibyte) input round-trips uncorrupted.
3. Reconnect after gateway restart shows a clean redraw (no stacked stale content).
4. A job keeps running across tab close and resumes live.
5. vim/htop redraw correctly on reattach.
6. Multi-viewer resize follows the latest active client.

## 8. Phased rollout

| Phase                      | Scope                                                                         | Owner | Est.        |
| -------------------------- | ----------------------------------------------------------------------------- | ----- | ----------- |
| 0 — Restructure + scaffold | Move gateway to `apps/terminal-gateway`; root workspace files; `shared-types` | BE    | 2–3 days    |
| 1 — Foundation             | config packages, `packages/ui`, `apps/web`, providers/patterns                | FE    | 3–5 days    |
| 2 — Terminal app           | `apps/terminal`: XTerm.tsx, Connection port, sessions via Query               | FE    | 1–1.5 weeks |
| 3 — Test harness           | Vitest everywhere, `apps/e2e` Playwright, CI workflow                         | QA    | 1 week      |
| 4 — Parity cut-over        | All gates pass; delete old `public/` frontend + vendor script                 | QA    | 3–4 days    |
| 5 — Hardening              | Gateway auth/WSS (own roadmap, unblocked by shared types)                     | BE    | ongoing     |

## Risks

- **React StrictMode double-mount** → two tmux attach ptys in dev. Cleanup must fully dispose; test explicitly. Most likely place to break the one-live-connection invariant.
- **Careless props on XTerm.tsx** → remount → reattach storms. Guard with memo/refs + a test that types during a sidebar toggle.
- **WS proxying**: Next rewrites don't proxy WS reliably → env-pointed gateway in dev, reverse proxy in prod.
- **tmux on CI** for terminal E2E.
- **shadcn transpile/content-glob drift** silently drops styles → visual smoke test.
