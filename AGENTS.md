# Repository Guidelines

## Project Structure & Module Organization

This Node.js 24+ pnpm/Turborepo monorepo keeps applications in `apps/`: the Next.js `terminal`, supporting `web` app, JavaScript `terminal-gateway`, TypeScript `agent-service`, and Playwright `e2e` suite. Shared UI, schemas, and tooling live in `packages/`; deployment and architecture material lives in `deploy/` and `docs/`.

Within Next.js apps, keep `src/app/` limited to routing and composition. Put business logic in `src/features/<feature>/`, expose cross-feature APIs through each feature's `index.ts`, and import workspace packages by name (for example, `@sparklab/ui`).

## Build, Test, and Development Commands

- `pnpm install` / `pnpm dev`: install workspaces and start development tasks.
- `pnpm build`: build every app and package.
- `pnpm lint` / `pnpm typecheck` / `pnpm test`: run repository-wide checks.
- `pnpm --filter e2e test`: run Chromium Playwright tests with isolated production servers.
- `pnpm --filter @sparklab/terminal-gateway acceptance`: verify jobs survive gateway disconnects.

Use `pnpm --filter <workspace> <script>` for focused work. See `docs/GETTING-STARTED.md` for ports and environment setup.

## Coding Style & Naming Conventions

Use two-space indentation and Prettier with its Tailwind plugin. TypeScript is strict with `noUncheckedIndexedAccess`; do not weaken shared configs. Use kebab-case filenames, PascalCase components, camelCase identifiers, and `use...` hooks. Keep server data in TanStack Query and UI state in Zustand. The gateway remains JavaScript.

## Testing Guidelines

Place Vitest tests beside code as `*.test.ts(x)` or in feature `__tests__/`; use the React preset for DOM tests. Gateway scripts use real tmux; Playwright specs live in `apps/e2e/specs/`. Add regression tests and run `pnpm turbo lint typecheck test build` before pushing.

## Virtual Browser Changes

Read `docs/VIRTUAL-BROWSER.md` and `docs/AGENT-PROTOCOL.md` first. Browser Use runs lazily through `apps/agent-service/src/browser-runtime.ts`; network policy belongs in `browser-proxy.ts` and `browser-security.ts`. Keep actions one-time approval-only, typed text redacted, screenshots ephemeral and bounded, and the UI read-only. Never expose raw MCP, CDP, JavaScript, filesystem, uploads, or downloads.

## Commit & Pull Request Guidelines

Commitlint enforces Conventional Commits, such as `feat(agent-chat): ...`. Keep commits focused. PRs need a problem/solution summary, linked issues when applicable, test evidence, UI screenshots, and explicit configuration or protocol impacts.

## Security & Configuration

Never commit `.env` files, Azure keys, password hashes, or runtime gateway state. Keep unauthenticated gateways bound to loopback. Use `apps/agent-service/.env.example` and consult `docs/DEPLOYMENT.md` before exposing services.
