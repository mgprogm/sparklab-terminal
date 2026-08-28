# Notes (pluggable HTML artifact, OneNote-style) — Design & Implementation Plan

> Status: **design, not implemented.** This document is the decision record to
> review before any code is written. It deliberately mirrors the structure and
> the settled patterns of `docs/KANBAN-PLAN.md` (§0 grounding → D-numbered
> decisions → data model → endpoints → AI access → frontend → phases → testing
> → deferred → open decisions → critical files); it also mirrors the
> **store-splitting** decision from `docs/PM-ARTIFACT-ENHANCEMENTS-PLAN.md`
> (`src/pm-collab.js`), because notes do not fit Kanban's whole-file-rewrite
> store.
>
> Scope: a **OneNote-style hierarchical note-taking tool** — Notebooks →
> Sections → Pages, each page a Markdown document — owned end-to-end by the
> **gateway** (a new `notes.json` tree sidecar + a `notes-pages/` body store +
> `/api/notes/*` REST). The UI is a **self-contained HTML artifact** loaded into
> a modal in the terminal web app via a same-origin sandboxed `<iframe>` —
> "pluggable" = the modal is a thin host seam that points an iframe at a
> swappable HTML document; swap the file, swap the artifact. The same REST API
> is callable by (a) the in-app agent (`apps/agent-service` tools) and (b) an
> external AI CLI (Claude/Codex) over plain HTTP / a stdio MCP server.

A notebook is an ordered list of sections; a section is an ordered list of
pages; a page has a title and a Markdown body and may have child pages
(subpages). The load-bearing operations: **list, get, search, create page,
append to page, edit page, move page, delete** — these are the API contract;
everything else is in service of them.

---

## 0. Grounding (verified against source)

Every decision below anchors to an existing pattern in the repo (mirrors, not
invents):

- **Tree sidecar store**: `apps/terminal-gateway/src/kanban.js` (`data/kanban.json`)
  and `src/registry.js` (`servers.json`) — module-level `store`, `load()` at
  module bottom, atomic `persist()` = `writeFileSync(TMP)` + `renameSync(TMP,
FILE)`, missing/corrupt file → empty store (never crash), test override via env
  (`KANBAN_FILE`, `SERVERS_FILE`). **Synchronous mutators ⇒ each read-modify-
  write-persist is atomic on Node's single thread ⇒ no mutex** (the refinement
  the Kanban build landed vs. its own draft).
- **Split store for bulky/append-heavy data**: `apps/terminal-gateway/src/pm-collab.js`
  is deliberately separate from `src/pm.js` "so comment/attachment volume never
  bloats the whole-file rewrite." Notes reuse this idea: the tree is small and
  rewritten whole; page bodies are the bulk and are stored one file per page.
- **Hierarchy + cycle rejection**: `src/pm.js` — `parentId` (Epic→Story→Subtask)
  and `dependsOn` are validated against a matrix and cycle-checked; deleting a
  parent **orphans** (does not cascade) its children. Notes' subpage `parentId`
  copies this.
- **Routes**: `apps/terminal-gateway/src/server.js` — `handleApi(req,res,url)` is a
  flat if-ladder on `req.method` + `url.pathname.split("/").filter(Boolean)`.
  Origin/CSRF guard runs **only** for `POST/DELETE/PATCH/PUT` **and only when an
  `Origin` header is present**; GET is Origin-exempt. `readJsonObject(req)` caps
  the body; `sendJson(res,code,obj)` writes JSON; 204 = bare `writeHead(204);
end()`. Representative handler: `handleKanban()` at `server.js:1448` — coded
  store errors mapped `not_found→404, stale→409, else→400`.
- **Artifact-bearer auth**: `isArtifactBearerAuthorized(req)` (`server.js:259`)
  accepts `Authorization: Bearer <GATEWAY_API_TOKEN || KANBAN_API_TOKEN>` **only**
  on the artifact prefixes. The prefix allowlist is enumerated in **three**
  places today (`server.js` ~301, ~328, dispatch ~5652) — see Critical Files.
- **Agent tools**: `apps/agent-service/src/tools.ts` — `TOOLS` (OpenAI
  `ChatCompletionTool[]`), `WRITE_TOOLS: Set<string>` gates approval,
  `ONE_TIME_TOOLS: Set<string>` coerces the destructive ones to
  no-allow-always, `describeCall()` builds the approval-card summary,
  `executeTool()` switch runs after approval. Kanban has **no card-delete tool**
  and PM has **no task-delete tool** — both human-only by design (D10 below is
  an explicit, reasoned divergence).
- **External MCP**: `tools/kanban-mcp/server.mjs` — a dependency-free stdio
  JSON-RPC 2.0 MCP server, thin REST client using the bearer token, registered
  with `claude mcp add`. `tools/pm-mcp/` is the sibling. Notes gets
  `tools/notes-mcp/`.
- **Shared types**: `packages/shared-types/src/terminal.ts` — `export const
XSchema = z.object({...})` + `export type X = z.infer<…>`, re-exported from
  `src/index.ts` in a grouped block under a `// REST: …` banner (Kanban block at
  `index.ts:96`).
- **Frontend proxy**: `apps/terminal/next.config.ts` rewrites `/api/:path*` →
  `${NEXT_PUBLIC_GATEWAY_URL}/api/:path*`, so a same-origin iframe's relative
  `fetch("/api/notes/…")` carries the app-origin `gw_session` cookie to the
  gateway. **Verified for Kanban; identical here.**
- **Host modal + wiring**: `components/kanban-dialog.tsx` (controlled
  `open`/`onOpenChange`, `@sparklab/ui` `Dialog*`, one `<iframe>`), opened from
  `terminal-shell.tsx` (ghost icon `Button` + `Tooltip`, always-enabled cluster
  at `terminal-shell.tsx:585`+), flag in `store.ts` (`kanbanOpen`, ephemeral,
  **not** persisted), URL-synced via `useUrlFlagSync("kanban", …)`.
- **Tailwind `sm:` gotcha** (from `CLAUDE.md`, Munder Difflin note): a wide
  `DialogContent` needs **both** a bare `max-w-[…]` and an `sm:max-w-[…]`, or
  the primitive's default `sm:max-w-lg` wins at desktop widths.

---

## 1. Architectural decisions (settle before implementation)

**D1 — Ownership: the gateway, not agent-service.** Notes state is gateway-owned
(like sessions, servers, Kanban, PM): the browser reaches it same-origin via
`/api`, the gateway already enforces auth/Origin, and `agent-service` is an
independent lifetime that must not become the store of record. `agent-service`
touches Notes **only** as a REST client, so the gateway stays the single
enforcement point.

**D2 — Storage is SPLIT: a tree file + a per-page body store.** This is the
central divergence from Kanban's D2 (one `kanban.json` rewritten whole on every
mutation). Kanban gets away with it because a card is a one-liner. A note page
body is the bulk of the data, and a debounced autosave (D12) would re-serialize
**every page of every notebook** on each keystroke-batch. So, mirroring
`pm-collab.js`:

- **`data/notes.json`** — the tree only: notebooks, sections, page **metadata**
  (title, tags, `parentId`, revs, timestamps), and the ordering arrays. Small;
  rewritten whole via the atomic `writeFileSync(TMP)+renameSync` pattern.
- **`data/notes-pages/<pageId>.md`** — one file per page body. A body save
  touches exactly one small file, `writeFileSync(TMP)+renameSync` — still
  synchronous, so D3's "no mutex" reasoning is unaffected.
- Test override: `NOTES_FILE` (tree) + `NOTES_PAGES_DIR` (bodies). `data/` is
  already `.gitignore`d wholesale.

**Write-ordering across the two files (must be coded exactly this way).** Two
different invariants: create/delete must fail toward an **orphan blob** (a body
file with no tree reference — harmless, swept on next `load()`); **update must
fail toward a false conflict, never a false accept** (a stale writer must always
be rejected, never silently admitted against an already-updated body).

| op              | order                                                           | on a crash between the two steps                                                                          |
| --------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| create page     | write body file **then** splice id into `section.pageIds`       | orphan `.md`, no tree reference — swept on next `load()`                                                  |
| delete page     | splice id out of the tree **then** `unlink` the body file(s)    | orphan `.md` — never a tree entry pointing at a missing body                                              |
| **update body** | **bump `page.rev` in the tree first, then write the body file** | rev is ahead of the body ⇒ the next writer 409s and is forced to reload — no stale write is ever accepted |

Rationale for the update order: `page.rev` **is** the compare-and-set. If the
body were written first and `rev` bumped second, a crash in between leaves the
tree at the old `rev` while the body is already changed — a second writer
holding that same old `rev` passes the check and silently overwrites the first
writer's committed body (the exact discard D4 exists to prevent). Bumping `rev`
first closes that window at the cost of a benign transient: `getPage` reads
`rev` from the tree and `body` from the file, so a reader can briefly see a
`rev` one ahead of the body it returns. Harmless for the only consumer that
matters (the editor just 409s on its next autosave and reloads); documented here
because it is the price of the correct ordering.

`load()` sweeps `notes-pages/` for `.md` files no tree page references and
removes them (best-effort, logged).

**D3 — Concurrency: a two-tier `rev`, no mutex.**

- **`page.rev`** (per page, integer) — bumped **only** on a change to that
  page's `title` or `body`. Carried by `PATCH /api/notes/pages/:id`;
  mismatch → **409 `stale`** with the current page (body included).
- **`notebook.rev`** (per notebook, integer) — bumped on any **structural**
  change: section add/rename/reorder/delete, page add/move/delete. Carried by
  the two structural move routes; mismatch → **409 `stale`** with the current
  notebook tree.
- Two revs so the agent appending to page A never 409s the human renaming a
  section, and vice-versa. Every mutator stays fully synchronous (read → modify
  → `writeFileSync` → return), so a read-modify-write is atomic without a mutex —
  same reasoning as `kanban.js` / `registry.js`.

**D4 — A page-body 409 is SURFACED, never auto-retried.** Deliberate divergence
from Kanban's D5, where the MCP/agent client refetches and **retries a stale
`move` once**. That is safe for `move` because `moveCard` is a splice
**re-derived** from fresh server state — replaying it just re-applies the same
intent. A page-body `PATCH` is a **blind overwrite**: auto-retrying it against a
fresh `rev` silently discards whatever the other writer just saved. So:

- Structural moves (`sections/:id/move`, `pages/:id/move`) — MAY retry-once on
  409, like Kanban. The MCP server does this for the caller.
- Page-body `PATCH` — the 409 is returned to the caller with the current page;
  no client (artifact, agent, MCP) ever silently retries it. The artifact shows
  a non-destructive conflict banner (D12); the agent surfaces the conflict to
  the model.

**D5 — Single ordering authority; `parentId` is a containment edge, not an
order.** Restates Kanban's D4 and extends it:

- `Notebook.sectionIds[]` is the sole order authority for sections.
- `Section.pageIds[]` is the sole **flat** order authority for pages in that
  section. A page record carries **no** `sectionId` and **no** `order`;
  `getNotebook()` derives `sectionId` + `depth` for consumers but never
  persists them.
- `page.parentId` (nullable) is a pure **containment/indent** edge for the
  subpage tree — it does **not** encode order. The render walks `pageIds[]` in
  order and indents each page by its `parentId` depth (OneNote behaves this
  way).
- **Moving a page moves its whole subtree contiguously**: `movePage` splices the
  page and every transitive child out of `pageIds[]` as one contiguous run and
  splices the run back in at the target, so the walk-and-indent stays coherent.
- `parentId` is cycle-checked on every set (`createPage`, `movePage`) exactly
  the way `src/pm.js` checks its `parentId` — a would-be cycle → **400**.

**D6 — "Pluggable" = one artifact behind one host seam, NOT a plugin
framework.** Verbatim intent of Kanban's D6. The UI is a **single
self-contained HTML file** at `apps/terminal/public/notes/app.html` (inline
CSS+JS, zero external deps, zero external requests). A thin `NotesDialog`
renders `<iframe src="/notes/app.html" sandbox="allow-scripts allow-same-origin
allow-forms allow-modals">`. Same-origin ⇒ relative `fetch("/api/notes/…")`
carries the `gw_session` cookie through the confirmed proxy — no new auth
surface, no cross-origin, no CDN. `allow-forms`/`allow-modals` are required for
the artifact's `<form>` submits and `window.confirm()` guards. **`sandbox` here
is DOM/CSS/JS isolation for pluggability, not a security boundary** (a
same-origin frame can drop its own sandbox; it is first-party code regardless).
A generalized multi-artifact registry is **explicitly deferred** (§8) and shared
with Kanban's identical deferral.

**D7 — Notes is gateway-global, not session/server-scoped.** Notebooks are not
tied to a tmux session or a connected server; they are the gateway's own
notebook store. The header button is **always enabled** (no "active session /
reachable server" gate, unlike file-explorer/git) — same as Kanban (D7) / PM /
Agentic.

**D8 — External-AI access: bearer token + a stdio MCP server.**
`/api/notes/*` is added to the artifact-prefix allowlist that
`isArtifactBearerAuthorized` already gates, so it accepts
`Authorization: Bearer <GATEWAY_API_TOKEN>` (the shared artifact token;
`KANBAN_API_TOKEN` remains the back-compat fallback). CLI requests carry no
`Origin`, so the CSRF guard is a no-op for them. A new `tools/notes-mcp/server.mjs`
(dependency-free stdio JSON-RPC, thin REST client — a near-copy of
`tools/kanban-mcp/server.mjs`) exposes the tools to any MCP-capable CLI.

**D9 — Agent approval tiers, inverted from the naive reading.** The obvious
mapping ("writes need approval, deletes need one-time") gets the risk backwards
for notes: a blind `notes_update_page(body)` at allow-always can **silently
destroy pages of human writing**, whereas deleting an empty scratch page cannot.
So:

- **Reads** (`notes_list`, `notes_get_notebook`, `notes_get_page`,
  `notes_search`) — not in `WRITE_TOOLS`, auto.
- **Additive / structural writes** (`notes_create_notebook`,
  `notes_create_section`, `notes_create_page`, `notes_append_to_page`,
  `notes_move_page`) — in `WRITE_TOOLS`, **allow-always permitted**.
  `notes_append_to_page` is the tool the agent actually needs (journaling,
  capturing findings) and is **server-atomic and additive** — it cannot clobber
  (see §3), so it carries no `rev` and needs no per-call gate.
- **Full-body replace** (`notes_update_page` — sets `title`/`body` wholesale) —
  coerced **one-time** via `ONE_TIME_TOOLS`, like `run_codex`. Overwriting an
  existing page's body is destructive and must be confirmed each time.
- **Destructive structural** (`notes_delete_page`, `notes_delete_section`,
  `notes_delete_notebook`) — coerced **one-time**.

**D10 — `notes_delete_page` exists as a tool (one-time). Explicit divergence
from precedent.** Kanban ships **no** `kanban_delete_card` tool and PM ships
**no** `pm_delete_task` tool — card/task deletion is human-only in both. Notes
diverges: a notebook accretes many disposable pages (web clips, scratch capture,
dead drafts) and routing every one through the human is friction that the
"one precious card" model does not have. Mitigations that make this acceptable:
`notes_delete_page` is **coerced one-time** (never allow-always), it defaults to
`mode:"orphan"` (children are promoted, not cascaded — see §2), and the tree
sweep in D2 means an accidental delete leaves the body `.md` recoverable until
the next `load()`. `notes_delete_notebook` / `notes_delete_section` stay
one-time as well. If review rejects this, fall back to the Kanban/PM rule:
no page-delete tool, human-only in the artifact.

**D11 — Body format is Markdown; the artifact renders a hand-rolled subset.**
The source of truth stored in `<pageId>.md` is raw Markdown. The chat panel's
`react-markdown` renderer is **not available** inside the artifact (an isolated
document with no bundler, and D6 forbids a CDN). So the artifact ships a small
hand-rolled formatter — same philosophy as the streaming inline formatter in
`components/chat-message.tsx` — covering headings, bold/italic, inline code,
fenced code, lists, links, blockquotes, and `---`. Editing is on the raw
Markdown in a `<textarea>`; a Preview toggle shows the rendered subset. Full
CommonMark fidelity is **deferred** (§8). This keeps the artifact truly
self-contained.

**D12 — Autosave is a debounced `rev`-guarded PATCH; a 409 shows a
non-destructive banner, never a silent retry.** The editor debounces ~800 ms
after the last keystroke and `PATCH`es `{ notebookId, body, rev }`. On 200 it
adopts the new `rev`. On **409 `stale`** it stops autosaving and shows an inline
banner — _"This page changed elsewhere"_ — with two explicit buttons:
**Reload** (discard local edits, load the server body) and **Overwrite**
(re-`PATCH` with the server's fresh `rev`). This is D4 enforced at the UI.

**Overwrite must name what it destroys.** D9 calls `notes_append_to_page`
"cannot clobber" — true of the stored body, _not_ of an editor holding unsaved
text. Sequence: the editor holds `rev N` with local edits → the agent appends →
`rev N+1` → the editor's autosave 409s → the user clicks Overwrite → the editor
PATCHes its local buffer, which never contained the appended block, and the
append is gone. So the Overwrite button is labelled _"Overwrite — discards the
other change"_ and the banner shows the server body (or a diff) alongside the
local text before the user commits. Reload is always the safe default and is
visually primary.

---

## 2. Data model

### `data/notes.json` (tree only)

```jsonc
{
  "notebooks": {
    "nb-<uuid>": {
      "id": "nb-<uuid>",
      "name": "Engineering",
      "tags": ["work"],
      "rev": 12, // D3: structural rev — sections/pages add/move/remove
      "createdAt": 1750000000000,
      "updatedAt": 1750000500000,
      "sectionIds": ["sec-a", "sec-b"], // D5: sole section order authority
      "sections": {
        "sec-a": {
          "id": "sec-a",
          "name": "Design notes",
          "pageIds": ["pg-1", "pg-2", "pg-3"], // D5: sole flat page order authority
          "createdAt": 1750000000000,
          "updatedAt": 1750000400000,
        },
        "sec-b": {
          "id": "sec-b",
          "name": "Meetings",
          "pageIds": [],
          "createdAt": 0,
          "updatedAt": 0,
        },
      },
      "pages": {
        // map by id; NO sectionId, NO order (D5). parentId is a containment edge only.
        "pg-1": {
          "id": "pg-1",
          "title": "Notes tool plan",
          "tags": [],
          "parentId": null,
          "rev": 5, // D3: per-page rev — title/body only
          "createdAt": 1750000000000,
          "updatedAt": 1750000450000,
          // body lives in data/notes-pages/pg-1.md (D2)
        },
        "pg-2": {
          "id": "pg-2",
          "title": "Open questions",
          "tags": [],
          "parentId": "pg-1",
          "rev": 1,
          "createdAt": 0,
          "updatedAt": 0,
        },
      },
    },
  },
}
```

### `data/notes-pages/<pageId>.md` (bodies)

Raw UTF-8 Markdown, one file per page. No front-matter (metadata lives in the
tree). Absent file ⇒ empty body.

### `src/notes.js` API (all mutators synchronous ⇒ atomic; each persists)

| function                                                              | notes                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `load()`                                                              | reads tree + sweeps orphan `.md` (D2)                                                                                                                                                                                                                                                                                                                                                                       |
| `listNotebooks()`                                                     | → summaries `{id,name,tags,rev,updatedAt,sectionCount,pageCount}`                                                                                                                                                                                                                                                                                                                                           |
| `getNotebook(id)`                                                     | → full tree; sections ordered, each with ordered `pageIds`; `pages` as an array with **derived** `sectionId` + `depth`; **no bodies**                                                                                                                                                                                                                                                                       |
| `getPage(nbId, pageId)`                                               | → page metadata + `body` (reads the `.md`) + `rev`                                                                                                                                                                                                                                                                                                                                                          |
| `search(q, {limit})`                                                  | → `[{notebookId, notebookName, sectionId, pageId, title, snippet}]` — case-insensitive substring over titles + bodies (D2 note: reads N body files)                                                                                                                                                                                                                                                         |
| `createNotebook({name,tags?})`                                        | seeds one section `"Notes"` + one empty page `"Untitled page"` (OneNote-like first-open)                                                                                                                                                                                                                                                                                                                    |
| `updateNotebook(id,{name?,tags?})`                                    | structural rev bump                                                                                                                                                                                                                                                                                                                                                                                         |
| `deleteNotebook(id)`                                                  | unlink every page body, then delete tree entry                                                                                                                                                                                                                                                                                                                                                              |
| `createSection(nbId,{name})`                                          | append to `sectionIds`; structural rev                                                                                                                                                                                                                                                                                                                                                                      |
| `updateSection(nbId,secId,{name})`                                    | rename; structural rev                                                                                                                                                                                                                                                                                                                                                                                      |
| `moveSection(nbId,secId,{toIndex,expectedRev})`                       | reorder; 409 `stale` on rev mismatch                                                                                                                                                                                                                                                                                                                                                                        |
| `deleteSection(nbId,secId,{mode})`                                    | `mode:"block"` (default; refuse if non-empty → `not_empty` → **422**) \| `"cascade"` (delete pages + bodies). **Deliberate divergence from PM**, whose column delete offers `block\|relocate`; Notes has no "relocate pages to another section" mode in v1 (a section's pages are a coherent set — the user moves them or discards them explicitly). No last-section guard (D5 / §5d empty-notebook state). |
| `createPage(nbId,{sectionId,title?,parentId?,body?})`                 | D2 order: write body then splice id in after the parent's subtree; `parentId` cycle-checked; page `rev:1`; structural rev                                                                                                                                                                                                                                                                                   |
| `updatePage(nbId,pageId,{title?,body?,tags?,expectedRev})`            | per-page rev optimistic concurrency; 409 `stale` → `{error:"stale", page}` (body included); **never auto-retried** (D4); **rev bump precedes the body write** (D2 — fail toward a false conflict)                                                                                                                                                                                                           |
| `appendToPage(nbId,pageId,{markdown})`                                | server-atomic: read body, append `"\n\n"+markdown`, write, bump page `rev`. No `expectedRev` — additive, cannot clobber (D9)                                                                                                                                                                                                                                                                                |
| `movePage(nbId,pageId,{toSectionId,toIndex,toParentId?,expectedRev})` | subtree moved contiguously (D5); `toParentId` cycle-checked; 409 `stale` on notebook rev mismatch; MAY be retried once by the caller (D4)                                                                                                                                                                                                                                                                   |
| `deletePage(nbId,pageId,{mode})`                                      | `mode:"orphan"` (default; children promoted — a child's `parentId` becomes the deleted page's `parentId`) \| `"cascade"`; D2 order: splice out of tree then unlink body/bodies; structural rev                                                                                                                                                                                                              |

Coded errors (mapped to HTTP by the route handler): `not_found→404`,
`stale→409`, `not_empty→422`, `cycle→400`, everything else `→400`.

---

## 3. Backend endpoints (`/api/notes/*` in `server.js`)

New `handleNotes(req,res,url)` branch, dispatched from `handleApi` where
`parts[1] === "notes"` (mirror `handleKanban` at `server.js:1448`). Reads are
GET (Origin-exempt); writes carry the Origin/CSRF guard automatically. Auth =
`gw_session` cookie **or** the artifact bearer (D8) — `/api/notes` added to the
existing `isArtifactBearerAuthorized` prefix allowlist (all sites listed in
Critical Files).

### Read routes (GET — Origin-exempt)

| Route                                          | Returns                                       |
| ---------------------------------------------- | --------------------------------------------- |
| `GET /api/notes/notebooks`                     | `{ notebooks: NotebookSummary[] }` — **list** |
| `GET /api/notes/notebooks/:nbId`               | `Notebook` (tree, no bodies); 404 if unknown  |
| `GET /api/notes/notebooks/:nbId/pages/:pageId` | `PageContent` (metadata + `body` + `rev`)     |
| `GET /api/notes/search?q=…&limit=…`            | `{ results: SearchHit[] }`                    |

### Write routes (state-changing — Origin-checked)

| Route                                      | Body                                                   | Result                                                                     |
| ------------------------------------------ | ------------------------------------------------------ | -------------------------------------------------------------------------- |
| `POST /api/notes/notebooks`                | `{name, tags?}`                                        | 201 `Notebook` — **create**                                                |
| `PATCH /api/notes/notebooks/:nbId`         | `{name?, tags?}`                                       | 200 `Notebook`                                                             |
| `DELETE /api/notes/notebooks/:nbId`        | —                                                      | 204 — **delete**                                                           |
| `POST /api/notes/notebooks/:nbId/sections` | `{name}`                                               | 201 `Notebook`                                                             |
| `PATCH /api/notes/sections/:secId`         | `{notebookId, name}`                                   | 200 `Notebook`                                                             |
| `POST /api/notes/sections/:secId/move`     | `{notebookId, toIndex, rev}`                           | 200 `Notebook`; 409 `{error:"stale", notebook}`                            |
| `DELETE /api/notes/sections/:secId`        | `{notebookId, mode?}` (query or body)                  | 204; **422 `not_empty`** if `mode:"block"` and non-empty                   |
| `POST /api/notes/notebooks/:nbId/pages`    | `{sectionId, title?, parentId?, body?}`                | 201 `PageContent`                                                          |
| `PATCH /api/notes/pages/:pageId`           | `{notebookId, title?, body?, tags?, rev}`              | 200 `PageContent`; **409 `{error:"stale", page}`** — never auto-retry (D4) |
| `POST /api/notes/pages/:pageId/append`     | `{notebookId, markdown}`                               | 200 `PageContent` — server-atomic, no `rev` (D9)                           |
| `POST /api/notes/pages/:pageId/move`       | `{notebookId, toSectionId, toIndex, toParentId?, rev}` | 200 `Notebook`; 409 `{error:"stale", notebook}`; 400 `cycle`               |
| `DELETE /api/notes/pages/:pageId`          | `{notebookId, mode?}` (query or body)                  | 204                                                                        |

Errors: 400 malformed/validation/`cycle`, 401 unauthorized, 403 forbidden
origin, 404 unknown notebook/section/page, 409 `stale` (+ current
`page`/`notebook`), 422 `not_empty`, 413 body too large.

### Zod schemas — add to `packages/shared-types/src/terminal.ts`

`NotesPageSchema` (tree metadata), `NotesPageContentSchema` (metadata + `body` +
`rev`), `NotesSectionSchema`, `NotesNotebookSchema`, `NotesNotebookSummarySchema`,
`NotesListResponseSchema`, `NotesSearchHitSchema`, `NotesSearchResponseSchema`,
`CreateNotebookRequestSchema`, `UpdateNotebookRequestSchema`,
`CreateSectionRequestSchema`, `UpdateSectionRequestSchema`,
`MoveSectionRequestSchema`, `DeleteSectionRequestSchema`,
`CreatePageRequestSchema`, `UpdatePageRequestSchema`, `AppendPageRequestSchema`,
`MovePageRequestSchema`, `DeletePageRequestSchema`, plus `type` aliases;
re-export from `src/index.ts` under a `// REST: Notes /api/notes/*` banner.

---

## 4. AI access

### 4a. In-app agent (`apps/agent-service/src/tools.ts` + `gateway-client.ts`)

Add `gateway-client.ts` methods (`listNotebooks`, `getNotebook`, `getPage`,
`searchNotes`, `createNotebook`, `deleteNotebook`, `createSection`,
`createPage`, `updatePage`, `appendToPage`, `movePage`, `deletePage`,
`deleteSection`) on the existing `call()` primitive. Add tools:

| tool                                                                                                            | tier (D9)                        |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `notes_list`, `notes_get_notebook`, `notes_get_page`, `notes_search`                                            | read — auto                      |
| `notes_create_notebook`, `notes_create_section`, `notes_create_page`, `notes_append_to_page`, `notes_move_page` | `WRITE_TOOLS`, allow-always      |
| `notes_update_page` (full title/body replace)                                                                   | `WRITE_TOOLS` + `ONE_TIME_TOOLS` |
| `notes_delete_page`, `notes_delete_section`, `notes_delete_notebook`                                            | `WRITE_TOOLS` + `ONE_TIME_TOOLS` |

`describeCall()` case + `executeTool()` case per tool. `notes_move_page`'s
executor fetches the notebook first to supply `rev` and retries once on 409
(D4 — safe, it is a re-derived splice). `notes_update_page`'s executor fetches
the page for `rev`, sends once, and **surfaces a 409 to the model** (no retry).
`notes_append_to_page` needs no `rev`.

### 4b. External AI (Claude/Codex CLI) — REST + MCP (D8)

`tools/notes-mcp/server.mjs` — a near-copy of `tools/kanban-mcp/server.mjs`
(dependency-free stdio JSON-RPC 2.0, `NOTES_API_TOKEN`/`GATEWAY_API_TOKEN`
bearer, `NOTES_BASE_URL` default `http://127.0.0.1:3107`). Tools mirror 4a. The
`notes_move_page` MCP impl does the GET-attempt-retry-once-on-409 dance so the
model never tracks `rev`; `notes_update_page` does **not** retry. Plus a
`tools/notes-mcp/README.md` with the `claude mcp add notes -- node …` recipe.

Raw REST example:

```bash
curl -s -H "Authorization: Bearer $GATEWAY_API_TOKEN" \
  https://<host>/api/notes/notebooks
curl -s -X POST -H "Authorization: Bearer $GATEWAY_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"notebookId":"nb-…","markdown":"- deployed at 14:03 UTC"}' \
  https://<host>/api/notes/pages/pg-…/append
```

---

## 5. Frontend

### 5a. Store (`features/terminal/store.ts`)

Add `notesOpen: boolean` + `setNotesOpen(open)`, initialized `false`,
**excluded from persist** (mirror `kanbanOpen`/`pmOpen`/`explorerOpen`).

### 5b. Header button (`components/terminal-shell.tsx`)

Ghost icon `Button` (lucide `NotebookText`, `size-3.5`) in the always-enabled
artifact cluster beside the Kanban/PM/Agentic buttons, in a `Tooltip`
("Notes"). **Always enabled** (D7). `onClick={() => setNotesOpen(true)}`. Sync
`?notes` via `useUrlFlagSync("notes", notesOpen, setNotesOpen)`. Mount
`<NotesDialog open={notesOpen} onOpenChange={setNotesOpen} />` once.

### 5c. Host modal (`components/notes-dialog.tsx`)

Thin controlled `Dialog`, `DialogContent` sized wider than Kanban's reading cap
because the artifact is a three-pane workspace: `className="flex h-[88vh]
flex-col … max-w-[88vw] sm:max-w-[88vw]"` (**both** `max-w` forms — the `sm:`
gotcha). Body is one iframe:

```tsx
<iframe
  src="/notes/app.html"
  title="Notes"
  sandbox="allow-scripts allow-same-origin allow-forms allow-modals" // D6: isolation, not security
  className="h-full w-full border-0"
/>
```

No React notes logic in the app — it all lives in the artifact.

### 5d. The artifact (`apps/terminal/public/notes/app.html`)

One self-contained file: inline `<style>` + `<script>`, no imports, zero
external requests, DESIGN.md palette hardcoded (documented exception to the
Tailwind-tokens rule, same as Kanban — the artifact has no access to the app
theme). `textContent`-only DOM. Layout:

- **Left rail** — notebooks list (`GET /notebooks`) + "New notebook"; below it,
  the sections of the selected notebook + "New section". Rename via inline edit;
  delete via `window.confirm()`. Section reorder = up/down buttons in v1 (calls
  `sections/:id/move`), not drag. **Empty-notebook state**: because D5 allows
  deleting a notebook's last section (a deliberate divergence from PM, which
  guards the last column), the middle/right panes must render a "no sections
  yet — create one" placeholder rather than assuming a section is always
  selected.
- **Middle column** — the page tree of the selected section: `pageIds[]` walked
  in order, each row indented by `parentId` depth (D5). "New page" and "New
  subpage". Move a page = a "Move to…" dropdown (section + position), like
  Kanban's click-to-move; no drag in v1.
- **Right pane** — the editor: a `<textarea>` on the raw Markdown body + a
  Preview toggle rendering the D11 subset. Autosave per D12 (debounced
  `rev`-guarded PATCH; 409 → non-destructive Reload/Overwrite banner). Title is
  an `<input>` that saves on blur (also `rev`-guarded).
- **Search** — a top box hitting `GET /search?q=`; clicking a hit opens that
  notebook/section/page. Snippets render as **`textContent` only**, never
  through the D11 formatter — a snippet cut mid-fence or mid-list would render
  as garbage.

---

## 6. Phased implementation checklist

1. **Backend** (lowest interpretation risk — do first): `src/notes.js` (the
   split tree + body store, D2 write-ordering, D3 two-tier rev, D5 subtree
   move + cycle-check), shared-types schemas, `/api/notes/*` routes,
   `/api/notes` added to every artifact-bearer allowlist site, and the
   agentic-registry wiring (`{id:"notes"}` + `targetType` enum, §9.3).
2. **Gateway test** `test/notes-endpoints.js` (`test:notes`) — see §7. Gate
   before UI.
3. **Agent tools** — `gateway-client.ts` methods, `tools.ts` (D9/D10 tiers),
   `describeCall`, `executeTool`, `tools.test.ts` cases; `tools/notes-mcp/`.
4. **Frontend** — store slice, header button, `notes-dialog.tsx`, `?notes` flag.
5. **Artifact** `public/notes/app.html` — the three-pane workspace.
   **Checkpoint with the user before this step** (the UI is where
   interpretation risk lives — same as Kanban §6).
6. Docs: `docs/TERMINAL-PROTOCOL.md` (+ `docs/AGENT-PROTOCOL.md`) Notes section;
   update `CLAUDE.md` status + Layout + the `packages/shared-types` inventory.

---

## 7. Testing (`apps/terminal-gateway/test/notes-endpoints.js`, run `test:notes`)

Standalone node script (repo convention: real gateway, `throw` asserts,
PASS/FAIL, `NOTES_FILE` + `NOTES_PAGES_DIR` pointed at temp dirs). Cases:

- **Tree CRUD** — notebook/section/page create/list/get/rename/delete; the
  seeded first section + page on `createNotebook`.
- **D2 two-file write ordering** — after `createPage`, the `.md` exists **and**
  the id is in `pageIds`; after `deletePage`, the id is gone from `pageIds`
  **and** the `.md` is unlinked; kill the process between the two writes (or
  simulate) and assert `load()` sweeps the orphan `.md` and never yields a tree
  page with a missing body.
- **D3/D4 page-body rev** — a `PATCH` with a stale `rev` → 409 `{error:"stale",
page}` carrying the current body; assert the client made **exactly one**
  request (no auto-retry); a `PATCH` with the fresh `rev` → 200.
- **D3 structural rev** — a `sections/:id/move` / `pages/:id/move` with a stale
  notebook `rev` → 409 `{error:"stale", notebook}`; fresh → 200. Structural
  move on a stale rev while a **page-body** PATCH is in flight does **not**
  cross-409 (the two revs are independent).
- **D5 subtree move** — move a page that has children across sections; assert
  the children move contiguously and keep their relative order and `parentId`.
- **D5 cycle** — `movePage`/`createPage` setting `parentId` to a descendant →
  400 `cycle`.
- **`deletePage` orphan vs cascade** — `orphan` promotes children (their
  `parentId` ← the deleted page's `parentId`) and keeps their bodies;
  `cascade` unlinks the whole subtree's bodies.
- **`deleteSection` block vs cascade** — `block` on a non-empty section → 422
  `not_empty`; `cascade` removes pages + bodies.
- **`append`** — additive, no `rev`, concurrent appends from two callers both
  land (no lost update), `rev` bumps twice.
- **search** — substring over title + body, `snippet` around the match, `limit`
  respected, reads bodies from `NOTES_PAGES_DIR`.
- **CSRF** — missing/foreign `Origin` → 403 on writes; GET exempt.
- **Bearer** — valid `GATEWAY_API_TOKEN`, no cookie → 200; bad token → 401;
  bearer rejected on a non-artifact prefix.
- **404s** for unknown notebook/section/page; **413** oversized body.

Plus `apps/agent-service/src/tools.test.ts`: the new tools' schemas and approval
tiers — `notes_append_to_page` **not** in `ONE_TIME_TOOLS`, `notes_update_page`

- `notes_delete_*` **in** it; `notes_move_page` executor retries once on 409 and
  `notes_update_page` executor does not.

---

## 8. Deliberately deferred (post-v1)

- **Freeform canvas, ink/handwriting, drawing, OCR, audio/video notes** — the
  defining OneNote features that do not fit a terminal-app artifact. Out.
- **Full CommonMark / rich WYSIWYG editing** — v1 is a `<textarea>` on raw
  Markdown + the D11 rendered subset.
- **Real-time collaborative editing (CRDT/OT)** — v1 is `rev` + conflict banner
  (D12); the repo is single-user today.
- **Page version history / snapshots / undo beyond the editor's own.**
- **Backlinks, `[[wiki-links]]` between pages, tag-as-navigation, graph view.**
- **Section groups** (OneNote's nested sections) — v1 is a flat
  Notebook→Section→Page + subpages.
- **Export** (Markdown archive / PDF / `.one`), **import**, templates,
  page pinning/favorites, "Quick Notes" unfiled capture bucket.
- **Full-text search index** — v1 is a linear scan over body files (D2); fine
  for single-user scale, revisit if notebooks grow large.
- **Per-notebook / per-user access control** — v1: any authenticated user sees
  all notebooks (same as Kanban/PM).
- **Multi-artifact registry / host chrome** — shared with Kanban's §8 deferral.
- **Real-time push of tree changes to open viewers** — v1 refetches on focus /
  after own writes; the `rev`/409 loop keeps writers correct.

---

## 9. Open decisions — RESOLVED (2026-08-28)

These were the only choices that change v1 **scope**. All four are now settled;
the rest of the doc already reflects them.

1. **Binary attachments / embedded images in v1 — OUT.** v1 pages are text
   Markdown only. Post-v1 path if it comes up: a separate
   `data/notes-attachments/<notebookId>/{index.jsonl,<attId>}` sidecar (mirror
   `pm-collab.js` — opaque names, JSONL index), `POST
/api/notes/pages/:id/attachments` (multipart, size-capped), `GET
/api/notes/attachments/:attId`, Markdown references by that URL. **Never**
   inline base64 in `notes.json` or a `.md`. Listed in §8.

2. **Subpages (`parentId`) in v1 — IN.** Core to the OneNote model and cheap
   (`src/pm.js` hierarchy + cycle-check + orphan-on-delete is a direct
   template; D5 specifies the contiguous-subtree move). D5/D10's subtree
   clauses stand.

3. **Notes joins the agentic run engine's artifact MCP registry in v1 — YES.**
   Notes is a first-class agentic `targetType` alongside `pm` and `kanban`
   from day one (not retrofitted later like they would have been). This adds
   **four coordinated edits**, now folded into Critical Files → Edited (no
   longer conditional): the registry array + `targetType` filter in
   `server.js`, and the `targetType` enum in `shared-types` at both sites.
   The `test:agentic` suite gets a case asserting `notes` is an accepted
   `targetType` and a rejected-unknown-type case still fails closed.

4. **Agent gets `notes_delete_page` — YES, coerced one-time** (D10). A
   deliberate, documented divergence from Kanban/PM (card/task delete is
   human-only there); mitigated by one-time approval + `mode:"orphan"` default
   - the `load()` body-sweep leaving an accidental delete recoverable.

---

## Critical files

**New:**

- `apps/terminal-gateway/src/notes.js` — the split store: `data/notes.json`
  tree + `data/notes-pages/<pageId>.md` bodies (D2). Synchronous mutators, two
  revs (D3), subtree move + `parentId` cycle-check (D5).
- `apps/terminal-gateway/test/notes-endpoints.js` — `test:notes` (add the script
  to `apps/terminal-gateway/package.json`).
- `apps/terminal/src/features/terminal/components/notes-dialog.tsx` — host modal.
- `apps/terminal/public/notes/app.html` — the pluggable Notes artifact.
- `tools/notes-mcp/server.mjs` + `tools/notes-mcp/README.md` — external MCP
  (near-copy of `tools/kanban-mcp/`).

**Edited:**

- `apps/terminal-gateway/src/server.js` —
  - `import notes from "./notes.js"` and a `handleNotes(req,res,url)` branch
    dispatched at `parts[1] === "notes"` (near the `handleKanban` dispatch
    ~`server.js:5673`).
  - **Add `"notes"` to every artifact-bearer prefix allowlist** — there are
    **three** today and missing one yields a route that 401s only on the CLI
    path: the `(prefix) => prefix === "pm" || prefix === "kanban"` check
    (~~`server.js:301`), the `(parts[1] === "pm" || parts[1] === "kanban")`
    check (~~`server.js:328`), and the dispatch clause `parts[1] === "kanban" ||
parts[1] === "pm" || parts[1] === "agentic"` (~`server.js:5652`).
  - The generic Origin/CSRF guard already fires on `POST/PATCH/PUT/DELETE` for
    any prefix, so `/api/notes/*` writes are covered with no per-route change.
    (Verified against the guard at `server.js` top-of-`handleApi`; noted so the
    implementer does not re-add it.)
- `packages/shared-types/src/terminal.ts` + `src/index.ts` — the `Notes*`
  schema/type block under a `// REST: Notes /api/notes/*` banner.
- `apps/agent-service/src/tools.ts` — `TOOLS` entries, `WRITE_TOOLS` +
  `ONE_TIME_TOOLS` membership (D9/D10), `describeCall()` + `executeTool()` cases.
- `apps/agent-service/src/gateway-client.ts` — the `notes*` REST methods.
- `apps/agent-service/src/tools.test.ts` — schema + approval-tier assertions.
- `apps/terminal/src/features/terminal/store.ts` — `notesOpen` / `setNotesOpen`
  (not persisted).
- `apps/terminal/src/features/terminal/components/terminal-shell.tsx` — header
  button (lucide `NotebookText`), `useUrlFlagSync("notes", …)`, mount
  `<NotesDialog>`.
- `apps/terminal-gateway/.env.example` — note `GATEWAY_API_TOKEN` already covers
  `/api/notes/*`; add `NOTES_FILE` / `NOTES_PAGES_DIR` as documented test knobs.
- `docs/TERMINAL-PROTOCOL.md`, `docs/AGENT-PROTOCOL.md`, `CLAUDE.md` — Notes
  section + status + Layout inventory.

**Agentic registry wiring (§9.3 resolved YES — no longer conditional):**

- `apps/terminal-gateway/src/server.js` — add `{ id: "notes", name: "Notes" }`
  to the artifact registry array `[{ id:"pm", … }, { id:"kanban", … }]`
  (~~`server.js:2616`) and add `"notes"` to the `targetType` filter
  (~~`server.js:2830`).
- `packages/shared-types/src/terminal.ts` — extend `targetType: z.enum(["pm",
"kanban"])` → `z.enum(["pm", "kanban", "notes"])` at **both** ~line 1245 and
  ~line 1547.
- `apps/terminal-gateway/test/agentic-endpoints.js` — a case asserting `notes`
  is an accepted `targetType`, and the existing unknown-`targetType` rejection
  still holds.
