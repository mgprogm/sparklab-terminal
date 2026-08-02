# Repository Guidelines

## Project Structure & Module Organization

This Node.js 24+ pnpm/Turborepo monorepo keeps applications in `apps/`: the Next.js `terminal`, supporting `web` app, JavaScript `terminal-gateway`, TypeScript `agent-service`, and Playwright `e2e` suite. Shared UI, schemas, and tooling live in `packages/`; deployment and architecture material lives in `deploy/` and `docs/`.

Within Next.js apps, keep `src/app/` limited to routing and composition. Put business logic in `src/features/<feature>/`, expose cross-feature APIs through each feature's `index.ts`, and import workspace packages by name (for example, `@sparklab/ui`).

## Repository Exploration (graphify)

This repo has a regenerable, gitignored knowledge graph in `graphify-out/`. Use
the following progression to minimize broad searches while keeping conclusions
grounded in the current checkout:

1. Run `pnpm graphify:check`. Treat errors as stale output and semantic
   warnings as unverified documentation coverage.
2. Read `graphify-out/wiki/index.md` to find the relevant generated topic.
3. Read `graphify-out/GRAPH_REPORT.md` for the repository overview, hubs,
   communities, and cross-links.
4. For structural questions such as "what calls X?" or "how does X connect to
   Y?", query `graphify-out/graph.json` or use the `/graphify` skill.
5. Use `rg` for exact symbols, strings, definitions, and current implementation
   details. Source files are authoritative; generated graph and wiki output is
   only a navigation aid and may lag uncommitted or recent changes.

If `graphify-out/` or one of these outputs is missing, say that generated
navigation is unavailable and continue with `rg`. If its report date or
contents predate relevant changes, say that it may be stale and verify all
affected claims in source. For code-only changes, refresh the graph and wiki
with `pnpm graphify:generate`. For documentation or other semantic changes,
perform the full rebuild and certify its semantic baseline:

```bash
set -a; . ~/workspaces/sparklab/graphify/.env; set +a
/home/sparklab/miniconda3/bin/python3.13 \
  ~/workspaces/sparklab/graphify/scripts/graphify_azure.py "$(pwd)" --no-viz
pnpm graphify:generate -- --semantic-current
```

## Build, Test, and Development Commands

- `pnpm install` / `pnpm dev`: install workspaces and start development tasks.
- `pnpm build`: build every app and package.
- `pnpm lint` / `pnpm typecheck` / `pnpm test`: run repository-wide checks.
- `pnpm --filter e2e test`: run Chromium Playwright tests with isolated production servers.
- `pnpm --filter @sparklab/terminal-gateway acceptance`: verify jobs survive gateway disconnects.

Use `pnpm --filter <workspace> <script>` for focused work. See `docs/GETTING-STARTED.md` for ports and environment setup.

## Local Production Deployment

The PM2 `prod-terminal` process serves `NEXT_DIST_DIR=.next-prod`. After any
frontend change, run `./build-prod.sh`; never deploy it with a plain
`pnpm build` or `pnpm --filter @sparklab/terminal build`, because those write
`.next` and leave local production on the old bundle. Do not substitute a manual
`NEXT_DIST_DIR=.next-prod` build: `build-prod.sh` also bakes
`NEXT_PUBLIC_GATEWAY_URL` and `NEXT_PUBLIC_AGENT_URL` from `PUBLIC_ORIGIN`.
Without them, remote clients try `localhost:3007/3009` and both WebSockets fail.
Before restarting, confirm `.next-prod/static/chunks` contains the configured
public origin and contains neither fallback. Then restart the affected PM2
services. After restarting `prod-terminal`, verify that the page chunk served
over both local HTTP and the public origin matches the chunk referenced by
`apps/terminal/.next-prod/server/app/index.html`; PM2 being online alone does
not prove that the new frontend bundle is active. See `docs/LOCAL-PROD.md`.

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
