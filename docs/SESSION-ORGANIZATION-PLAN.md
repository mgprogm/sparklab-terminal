# Session organization plan: Org → Project grouping

> **Status: MVP implemented 2026-07-15** (gateway fields + PATCH, shared
> types, grouped sidebar tree, dialogs, tests — the "Later" list below is
> still open). Sessions gain two optional metadata fields, `org` and
> `project`, and the sidebar groups sessions into a two-level collapsible
> tree. This doc was the implementation spec and stands as the decision
> record.

## Problem

The sidebar is a flat, chronological list. With more than a handful of
sessions there is no way to tell which belong to which piece of work. The
ask: tag each session with a two-level hierarchy — **organization →
project** — and group the sidebar accordingly.

## Model decision: structured fields, not free-form tags

The ask is a fixed two-level hierarchy, so it is modeled as two structured
fields — `org` and `project` — rather than encoding `"acme/checkout"` into
the existing (reserved, always-empty) `tags` array. Grouping logic stays
trivial, validation is explicit, and `tags` stays reserved for flat labels
later (e.g. `prod`, `debug`).

**Groups are derived, not entities.** There is no org/project registry, no
create-org endpoint, no empty groups to manage. An org exists exactly while
at least one session carries it; the metadata sidecar's existing
`pruneToExisting()` makes the whole thing self-cleaning when sessions die.
This keeps the "tmux is the source of truth, metadata is a sidecar"
principle intact.

Validation rules (enforced by the gateway):

- Both fields optional. `project` is only valid when `org` is set — a
  project cannot float outside the hierarchy (400 otherwise).
- Values are trimmed; 1–32 chars after trim; must not contain `/` (reserved
  as the display separator). Exact-match grouping (no case folding).
- Sessions with no `org` fall into an **Ungrouped** section in the UI.

## Gateway changes (`apps/terminal-gateway`, plain JS)

- **`src/metadata.js`**: the per-session record grows optional `org` and
  `project` strings. The existing upsert / prune / atomic-write machinery
  handles them without new code.
- **`POST /api/sessions`** accepts optional `org` and `project` (validated
  as above) alongside `name` / `cwd`, stored in the metadata sidecar.
- **New `PATCH /api/sessions/:id`** with body `{ name?, org?, project? }` —
  metadata-only, never touches tmux, so it is safe on a live attached
  session. This also delivers **session rename**, which the UI currently
  lacks. Semantics: fields absent from the body are unchanged; `org: null`
  clears org **and** project; `project: null` clears project. Same
  validation as create; 404 for unknown sessions; auth like all session
  CRUD.
- **`GET /api/sessions`** returns `org` and `project` (both
  `string | null`).

## Shared types (`packages/shared-types/src/terminal.ts`)

- `CreateSessionRequestSchema` += `org?`, `project?`.
- `SessionInfoSchema` += `org: z.string().nullable().optional()`,
  `project: z.string().nullable().optional()` — optional so older gateways
  still parse.
- New `UpdateSessionRequestSchema` for PATCH
  (`{ name?, org?: string | null, project?: string | null }`).

## Sidebar UI (`apps/terminal/src/features/terminal`)

```
  SESSIONS                      [+]
  ▾ Acme Corp                          ← org header (Building2 icon, count)
    ▾ checkout                    3    ← project header (Folder icon)
      ● web-a1b2   npm run dev
      ○ web-c3d4   vim
    ▸ payments                   1
  ▾ Personal
      ● web-e5f6   htop               ← org with sessions but no project
  ▸ Ungrouped                    2    ← always last
```

- **Two-level collapsible tree** in `session-list.tsx`. Org headers and
  project sub-headers are small `text-muted-foreground` rows with a
  chevron, count, and indent; session rows render exactly as today
  underneath. Icons from lucide (`Building2` for org, `Folder` for project,
  `size-3.5`); colors/spacing from existing theme tokens per `DESIGN.md` —
  no new palette, no ad-hoc hex.
- **Grouping is a pure function** `SessionInfo[] → tree` (orgs A→Z,
  Ungrouped last; projects A→Z within org; sessions by `createdAt` within
  their group) — unit-tested in isolation.
- **Collapse state** lives in the zustand terminal store (persisted), keyed
  by `org` and `org/project`, so folding survives reloads.
- **Active-session guarantee:** grouping never hides the active session —
  selecting a session inside a collapsed group (including via the
  `?session=` deep link) auto-expands its ancestors.
- **New-session dialog** gains two optional **comboboxes** (type-ahead over
  org/project values derived from the current session list; free text
  creates a new org/project on the fly). Each org/project header exposes a
  hover "new session here" action that opens the dialog prefilled with that
  group — the natural way to grow a group.
- **Move/rename:** a hover ⋯ menu on each session row → "Rename / Move
  to…" opens a small dialog backed by `PATCH /api/sessions/:id` (new
  `useUpdateSession` mutation in `use-sessions.ts`, invalidating the
  sessions query).
- **Collapsed 52px rail:** unchanged flat list (no room for hierarchy);
  tooltips gain an `org / project` line.
- **Mobile:** free — the drawer reuses `SessionList`, so grouping appears
  there automatically.

## What deliberately doesn't change

- **No URL params** for org/project — session ids stay globally unique and
  `?session=` is untouched.
- **Agent Chat:** `list_sessions` picks up the new fields through the
  gateway response automatically; a `create_session` org/project argument
  is a later nicety, not MVP.
- **Composition with [MULTI-SERVER-PLAN.md](MULTI-SERVER-PLAN.md):**
  `serverId` (where a session runs) and org/project (what it is for) are
  orthogonal. Org/project stays the primary sidebar grouping; when
  Connected Servers lands, the server renders as a small badge on the
  session row — not a third nesting level. Three-deep trees in a 248px
  sidebar would be misery.

## Phasing

**MVP**

- Metadata fields + validation; `POST` extras; `PATCH /api/sessions/:id`;
  `GET` returns the fields; shared-types schemas.
- Grouped sidebar tree with persisted collapse + auto-expand of the active
  session's group.
- New-session dialog comboboxes; per-group "new session here"; row
  rename/move menu.
- Tests: gateway validation (create + PATCH) in the standalone node test
  style; unit tests for the grouping function and collapse/auto-expand
  store logic.

**Later**

- Drag-and-drop between groups; sidebar filter box; per-project default
  `cwd`; agent `create_session` org/project args; per-org accent dot.
