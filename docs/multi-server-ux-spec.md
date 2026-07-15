# Multi-server ("Connected Servers") — UX / interaction spec

> **Scope: MVP only.** This is the buildable interaction + visual spec for the
> five frontend surfaces named in `docs/MULTI-SERVER-PLAN.md` → _Frontend_.
> "Later" items (agent server argument, key-gen helper, per-server shell) are
> out of scope. The FE agent should not have to make visual decisions; where a
> choice existed it is made here.
>
> **Visual source of truth:** `DESIGN.md` (Warp-inspired warm near-charcoal) via
> the existing Tailwind theme tokens. **Do not hardcode hex.** Every color below
> is an existing token already used in `session-list.tsx` / `settings-dialog.tsx`.
> Icons: `lucide-react` at `size-3.5` / `size-3` (matching current rows).
> Primitives: `@sparklab/ui` (`Button`, `Dialog`, `AlertDialog`, `Input`,
> `Label`, `Select`, `Tooltip`, `Separator`, `ScrollArea`).

---

## 0. The one load-bearing rule (read first)

**"Couldn't ask" ≠ "asked, and it's gone."** A server the gateway cannot reach
over SSH is **unreachable**, not **dead**. Its sessions are still running on the
remote tmux; the gateway just can't see them this moment. Therefore:

- Unreachable servers and their sessions are **never removed** from the sidebar.
- Unreachable state is rendered in **muted** tones (`bg-muted-foreground`,
  `text-muted-foreground`, `opacity-60`) — **never** the error/destructive color
  (`bg-destructive`). Destructive red means "we asked tmux and it's gone / this
  action kills a job." Reachability failure is not that.
- This mirrors the backend contract in the plan: `pruneToExisting()` must
  distinguish "not in `tmux ls`" (prune) from "couldn't run `tmux ls`" (keep,
  grey out). The UI's muted-not-red treatment is the visible half of that rule.

---

## 1. Reused status-dot / badge vocabulary (do not invent new colors)

The session status dot already exists in `session-list.tsx` and the connection
dot in `settings-dialog.tsx`. **Server reachability reuses them 1:1:**

| Meaning                                       | Token                 | Where it exists today            |
| --------------------------------------------- | --------------------- | -------------------------------- |
| Reachable server (`status: "ok"`)             | `bg-chart-1`          | running-job dot, "connected" dot |
| Unreachable server (`status: "unreachable"`)  | `bg-muted-foreground` | idle-shell dot                   |
| Checking / first probe (`status: "checking"`) | `bg-chart-2`          | "reconnecting" dot               |
| Session running a job                         | `bg-chart-1`          | unchanged                        |
| Session idle shell                            | `bg-muted-foreground` | unchanged                        |

Dot geometry is the existing `size-[7px] shrink-0 rounded-full`. **Never use
`bg-destructive` for a reachability state** (see §0).

---

## 2. Data contract this UI renders against (confirm with backend agent)

> These are the shapes the FE **assumes**. They are named in
> `docs/MULTI-SERVER-PLAN.md` but not yet in `packages/shared-types`. Do **not**
> invent wire fields — **confirm the exact schema with the gateway/backend agent
> before building.** This section pins what the UI depends on so nothing is
> guessed silently.

**`ServerInfo`** (from `GET /api/servers`, one per registry entry):

```ts
interface ServerInfo {
  id: string; // "local" | "build01" | …
  name: string; // "This machine" | "Build server"
  type: "local" | "ssh";
  host?: string; // ssh only
  user?: string; // ssh only
  port?: number; // ssh only, default 22
  status: "ok" | "unreachable" | "checking"; // client may add "checking"
}
```

**Session → server mapping (the ripple to flag).** Today rows compare
`s.id === activeSessionId` (see `session-list.tsx` line ~284) and the store's
`activeSessionId` is a bare `web-<uuid>`. The plan makes session identity
**`<serverId>/web-<uuid>`**. To keep row selection correct, the UI needs one of:

- **Preferred:** `SessionInfo` gains a `serverId: string` field (default
  `"local"`), and the UI composes the qualified id `` `${s.serverId}/${s.id}` ``
  for selection, deep-linking, and the WS `?server=` param. Bare `s.id` stays
  `web-<uuid>` so the local single-server path is byte-identical to today.

Whichever the backend chooses, **the qualified id used for `activeSessionId`,
the `?session=` deep link, and row-equality must be the same string.** Confirm
this with the backend agent; do not ship a mismatch (it silently breaks the
active-row highlight and vanish-fallback).

---

## 3. Surface 1 — Sidebar grouped by server

### 3.1 Nesting

Server sits **above** the existing org→project tree. Full hierarchy:

```
Server header            (new — this spec)
└─ Org header            (existing renderOrgHeader)
   └─ Project header     (existing renderProjectHeader)
      └─ Session row     (existing renderSessionRow)
```

`grouping.ts` is **unchanged**. The new layer wraps it: partition sessions by
`serverId`, then call `groupSessions()` on each server's subset. Suggested
helper (FE, alongside `grouping.ts`):

```ts
interface ServerGroup {
  server: ServerInfo;
  tree: SessionTree;
  sessionCount: number;
}
function groupByServer(sessions, servers): ServerGroup[];
```

**Server sort order:** `local` first, then ssh servers A–Z by `name`.
Unreachable servers keep their position (do **not** sink to the bottom — the user
looks for them where they always are).

### 3.2 The single-server rule (nothing changes for local-only users)

**If `servers.length <= 1` (only `local`): render NO server header at all.** The
sidebar renders exactly as it does today — the org→project tree (or the flat
list when nothing is grouped). This is the compatibility guarantee: a user who
never adds a server sees a pixel-identical sidebar.

Server headers appear **only once a second server exists**, and then for _all_
servers including `local` (so `local`'s sessions don't float header-less).

### 3.3 Server header row (multi-server only)

Sits at the outer indent (no left padding; org/project/session keep their
existing `pl-4` / `pl-8` steps _relative to the server_, i.e. add one indent
level below the server header). Layout mirrors `renderOrgHeader`:

```
┌─────────────────────────────────────────────┐
│ ▸  ▣  Build server        ● 3   [＋]         │   ← reachable
│ ▸  ▣  Old box   unreachable ○ 2  [＋(off)]    │   ← unreachable
└─────────────────────────────────────────────┘
  │  │   │            badge   │  count  new-session (hover)
  │  │   name
  │  Server icon
  chevron (collapse)
```

Element-by-element:

- **Chevron** — `ChevronRight` (collapsed) / `ChevronDown` (expanded),
  `size-3 shrink-0`. Toggles collapse (§3.6).
- **Server icon** — lucide `Server`, `size-3.5 shrink-0`. (Do **not** reuse
  `Building2`; that stays the org icon one level down.)
- **Name** — `text-xs font-medium uppercase tracking-wider` (same class as the
  org header label), `min-w-0 truncate`. Color `text-muted-foreground`, hover
  `text-secondary-foreground` (identical to org header).
- **Reachability dot** — `size-[7px] rounded-full`, color per §1
  (`bg-chart-1` ok / `bg-muted-foreground` unreachable / `bg-chart-2` checking).
  Place it immediately left of the count. `title` = the tooltip copy in §5.
- **"unreachable" badge** — only when `status === "unreachable"`. A lightweight
  text chip, **not** a heavy pill: `text-[10px] uppercase tracking-wider
text-muted-foreground border border-border rounded-pill px-1.5 py-px`.
  Label: `unreachable`. Pair with a lucide `Unplug` `size-3` to its left is
  optional; if included, keep it `text-muted-foreground`.
- **Session count** — `text-muted-foreground ml-auto text-[10px] tabular-nums`
  (identical to org header count). This counts _all_ sessions under the server,
  reachable or not.
- **New-session `＋`** — lucide `Plus` `size-3`, appears on
  `group-hover/server:opacity-100` (same reveal pattern as the org header `＋`).
  Opens the Create dialog prefilled with this `serverId` (§3.5).
  **DISABLED when the server is unreachable** — you cannot create a session on a
  machine the gateway can't reach. Render at `opacity-40 cursor-not-allowed`,
  `title` = `Can't create a session — {name} is unreachable.`

Collapse key namespacing: see §3.6.

### 3.4 Session rows under an unreachable server (safety-critical)

`renderSessionRow` gains an `unreachable` flag derived from the row's server.
When the server is unreachable:

- Wrap the row content at **`opacity-60`** (still legible, clearly de-emphasized).
- The row stays **fully clickable** (§0 — the session is alive; the user may
  select it and the pane will attempt to reconnect; see §7).
- Append a small **`unreachable`** chip to line 2 of the row, in the same slot
  and style as the existing "idle 5m" / "1 viewer" status text:
  `text-muted-foreground text-xs`. Do not add a colored dot; the row's own
  status dot already goes `bg-muted-foreground` because the gateway reports no
  live command for an unreachable session (and that is correct — muted, not red).
- **Tooltip** (wrap the row trigger; also applies in the collapsed rail):
  `This server is unreachable. The session is still running there — the gateway
just can't reach {serverName} right now.`

Never hide or remove the row.

### 3.5 Create dialog gains a server selector

The existing New-session `Dialog` in `session-list.tsx` gets one new field at the
**top** of the form (above the name input):

- **Multi-server (`servers.length > 1`):** a `Select` (`@sparklab/ui`) labeled
  `Server`. Options = reachable servers (label = `name`, value = `id`).
  Unreachable servers appear **disabled** in the list with a trailing
  `— unreachable` suffix. Default = the prefill from the header `＋`, else
  `local`. Icon in the trigger: `Server` `size-3.5`.
- **Single-server:** the field is **hidden** entirely (implicit `local`) — the
  dialog is byte-identical to today.

When the header `＋` prefills a server, and the org header `＋`/project header `＋`
prefill org/project, both prefills coexist (server from the server header, org/
project from whichever sub-header was used — a sub-header `＋` implies its parent
server). Wire `serverId` into `CreateSessionParams` (`onCreateSession`).

Everything else in the create dialog (name / org / project / datalists) is
unchanged.

### 3.6 Collapse state & keys (avoid cross-server collisions)

`collapsedGroups` is a persisted `Record<string, boolean>` keyed today by `org`
(or `__ungrouped__`) and `org/project`. Two servers can both have an org named
"Acme" → the bare key `"Acme"` would collapse both. Rule:

- **Single-server mode: keep bare keys unchanged.** This preserves the user's
  existing persisted collapse state untouched — part of the "nothing changes"
  guarantee.
- **Multi-server mode: namespace every group key by `serverId`.**
  - Server header key: `server:<serverId>`
  - Org key: `<serverId>::<orgKey>` (orgKey = org name or `__ungrouped__`)
  - Project key: `<serverId>::<orgKey>/<project>`
- `expandAncestors` (store) must additionally expand the **server** ancestor
  (`server:<serverId>`) when a session becomes active, so selecting a session
  can never leave it hidden inside a collapsed server. Extend its signature to
  take the session's `serverId`.

Default (key absent) = expanded, as today. When the first extra server is added,
namespaced keys are fresh → everything starts expanded, which is the desired
first-run-of-multi-server experience.

### 3.7 Collapsed rail (icon-only, desktop)

The collapsed rail stays a **flat list of session dots** — do **not** render
server headers in the 52px rail (no room). Changes:

- Each row's tooltip (already shown only when collapsed) gains a **server-name
  line** at the top when `servers.length > 1`, above the existing org/project
  line. Order: `serverName` → `org / project` → (name is line 1 already).
- Unreachable sessions in the rail keep the `opacity-60` treatment and the §3.4
  tooltip.

No new controls in the rail; "Add server" and per-server create live in the
expanded sidebar and the settings tab.

---

## 4. Surface 2 — "Add server" dialog

Reachable from **two** entry points, both opening the _same_ dialog component:

1. The sidebar — a small **"Add server"** action. Placement: a ghost button in
   the Sessions header row is cramped; instead add it as the last row of the
   sidebar server list region **only in multi-server mode**, OR (simplest,
   recommended) rely on the Servers settings tab as the primary entry and add a
   `Plus`-icon ghost button next to the "Servers" concept. **MVP decision:** the
   primary entry point is the **Servers settings tab** (§5). Additionally, when
   `servers.length > 1`, show an **"Add server"** ghost row at the very bottom of
   the sidebar's server list (above the account footer): full-width, left-aligned,
   `text-muted-foreground hover:text-secondary-foreground text-xs`, lucide
   `Plus size-3.5` + label `Add server`. This keeps a one-click path without
   crowding the Sessions header.

### 4.1 Layout

Standard `@sparklab/ui` `Dialog` (same chrome as the New-session dialog):

```
┌──────────────────────────────────────────┐
│ Add server                                 │
├──────────────────────────────────────────┤
│ Name        [ Build server            ]    │
│ Host        [ 10.0.0.12               ]    │
│ User        [ deploy                  ]    │
│ Port        [ 22        ]                  │
│ Identity file (optional)                   │
│             [ ~/.ssh/gateway_ed25519  ]    │
│                                            │
│ [ Test connection ]   ✓ Connected. …       │  ← inline result
│                                            │
│                      [ Cancel ] [ Add ]    │
└──────────────────────────────────────────┘
```

Fields use `Input` + `Label` exactly like the create dialog's org/project rows
(`Label` = `text-muted-foreground text-xs`, `space-y-1.5` per field,
`space-y-3` between).

| Field         | Required | Default | Placeholder                   | Notes                                                                                              |
| ------------- | -------- | ------- | ----------------------------- | -------------------------------------------------------------------------------------------------- |
| Name          | yes      | —       | `Build server`                | Display label only. `maxLength={48}`.                                                              |
| Host          | yes      | —       | `10.0.0.12 or build.internal` | hostname or IP.                                                                                    |
| User          | yes      | —       | `deploy`                      | SSH user.                                                                                          |
| Port          | no       | `22`    | `22`                          | integer 1–65535; `inputMode="numeric"`.                                                            |
| Identity file | no       | —       | `~/.ssh/id_ed25519`           | Path on the gateway host. Key-based auth only — **no password field ever** (per plan trust model). |

### 4.2 Validation (inline, on submit / blur)

- **Name / Host / User empty** → field-level message under the input,
  `text-destructive text-xs`:
  - Name: `Give the server a name.`
  - Host: `Enter the host — a hostname or IP.`
  - User: `Enter the SSH user.`
- **Port out of range** → `Port must be between 1 and 65535.`
- The **Add** button is disabled until Name, Host, User are non-empty.
- No password field exists, so there is nothing to validate there.

### 4.3 "Test connection" button

Round-trips `ssh <host> true` via the gateway (implementation: a
`POST /api/servers/test` or `?test=1` — backend's call). It is **optional** —
Add never requires a passing test (a server can be added while briefly down).

States (button = `variant="outline" size="sm"`, result text to its right):

| State   | Button                                                          | Inline result                                                                                                         |
| ------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| idle    | `Test connection`                                               | —                                                                                                                     |
| testing | `Testing…` + spinning `Loader2 size-3.5 animate-spin`, disabled | `text-muted-foreground text-xs`: `Testing connection…`                                                                |
| ok      | `Test connection`                                               | `CircleCheck size-3.5 text-chart-1` + `text-chart-1 text-xs`: `Connected. The gateway reached {host} over SSH.`       |
| failed  | `Test connection`                                               | `CircleAlert size-3.5 text-destructive` + `text-destructive text-xs`: the gateway's reason, prefixed. Examples below. |

Failure copy (show the gateway's reason; these are the fallbacks / prefixes):

- Unreachable host/port: `Couldn't reach {host}:{port}. Check the host and port.`
- Auth rejected: `SSH refused the key. Check the user and identity file path.`
- Host key / other: `Connection failed: {reason}.`

Editing any field after a result **clears** the inline result back to idle
(stale result must not mislead).

### 4.4 Add CTA & submit states

- Primary button label: **`Add server`** (`Button` default variant — the
  off-white primary CTA).
- On click: disable both buttons, label → `Adding…` with `Loader2` spinner.
- Success: close dialog, the server appears in the sidebar (once >1 server, the
  server headers appear) and in the Servers tab; its status dot shows
  `checking` (`bg-chart-2`) until the first `GET /api/servers` reachability
  probe resolves.
- Failure: keep dialog open, show a form-level error above the footer,
  `text-destructive text-xs`: `Couldn't add the server. {reason}`.

---

## 5. Surface 3 — Servers settings tab

A **fifth** tab in `settings-dialog.tsx`, deep-linked `?settings=servers`.

### 5.1 Fitting the existing tabbed structure

- Add `"servers"` to `SETTINGS_SECTIONS` in `store.ts` (this also feeds
  `isSettingsSection` and the deep-link guard — no other change needed there).
  **Order:** append after `connection` → `[appearance, agent, account,
connection, servers]`. (Alternatively place it directly after `connection` if
  a connectivity grouping reads better; either is fine — do not reorder the
  first four.)
- Add a `TABS` entry: `{ key: "servers", label: "Servers", icon: Server }`
  (lucide `Server`, `size-3.5`, matching the other tab icons).

**Tab-bar width check (must verify, do not skip):** the tab bar is 5×`flex-1`
inside `DialogContent max-w-md` (~448px). Four tabs sit ~112px each; a fifth
drops them to ~89px. `Appearance` + icon + gaps is the widest label (~80px), so
it should still fit without truncation — **but verify at build.** If any label
truncates: switch the tab labels to `text-[11px]` (all tabs, uniformly) or drop
the icon on the narrowest — **do not rename the existing four tabs.**

### 5.2 Tab content

Reuses the `Section` wrapper (`px-4 py-3.5`). Structure:

```
Servers                              [ + Add server ]     ← header row
─────────────────────────────────────────────────────
●  This machine            local                          ← local, no remove
   (no host)
─────────────────────────────────────────────────────
●  Build server            deploy@10.0.0.12:22   [ 🗑 ]
○  Old box   unreachable   admin@10.0.0.9:22     [ 🗑 ]
```

- **Header row:** `Servers` label (`text-foreground text-sm`) on the left; an
  **`Add server`** button on the right (`Button variant="outline" size="sm"` +
  `Plus size-3.5`) opening the §4 dialog.
- **Server rows** (`flex items-center justify-between py-1.5`, hairline
  `border-border` dividers via `divide-y` or bottom borders):
  - Left: reachability **dot** (§1) + **name** (`text-foreground text-sm`).
    Below or trailing: connection detail in `text-muted-foreground text-xs`:
    `local` for the local row (no host); `` `${user}@${host}:${port}` `` for ssh.
  - When unreachable: add the same **`unreachable`** chip as §3.3.
  - Right: **remove** button — lucide `Trash2 size-3.5`,
    `text-muted-foreground hover:text-destructive`, `title="Remove server"`.
    **The local row has NO remove button** (`local` is not removable).
- **Local row** always shows `bg-chart-1` (reachable by definition) and is
  always first.

### 5.3 Remove flow (AlertDialog — reuse the delete pattern)

Removing a server is **not** killing its jobs. Use an `AlertDialog` (same shape
as the session-delete dialog):

- Title: `Remove server`
- Body: `Remove "{name}"? This only removes it from your list. Any sessions
running on it keep running — you just won't see them here until you add the
server back.`
- Confirm button: `Remove` (`variant` styled like the destructive session
  delete: `bg-destructive text-destructive-foreground`). Cancel = `Cancel`.

> Rationale for the copy: removal is reversible and **non-destructive to jobs**
> (unlike session delete, which the copy elsewhere calls out as "kills the
> running job"). The distinction must be explicit so a user doesn't fear losing
> work.

### 5.4 States

- **Loading** (`GET /api/servers` in flight, first load): a single muted line
  `text-muted-foreground text-sm`: `Loading servers…` (or 2–3 skeleton rows
  using `bg-accent/40 animate-pulse` at row height). Keep it lightweight.
- **Error** (fetch failed): `text-muted-foreground text-sm`:
  `Couldn't load servers.` with a `Button variant="ghost" size="sm"` `Retry`.
- **Only local (no ssh servers added):** show the local row, then a hint line
  `text-muted-foreground text-xs mt-2.5`:
  `Add a server to run sessions on another machine over SSH.` (Mirrors the
  Appearance section's explanatory footnote style.)
- Reachability updates live: the same polling cadence as sessions (~3s) so dots
  flip ok↔unreachable without a manual refresh. `checking` shows only for a
  server whose first probe hasn't returned.

---

## 6. Surface 4 — Unreachable ≠ dead (consolidated rule)

This is specified inline where it renders (§3.3 server header, §3.4 session
rows, §5.2 settings row) — consolidated here as the acceptance checklist:

1. Unreachable server + its sessions **remain in the sidebar** (never pruned).
2. Server header: `bg-muted-foreground` dot + `unreachable` chip.
3. Session rows: `opacity-60`, still clickable, `unreachable` chip, §3.4 tooltip.
4. Colors are **muted, never `bg-destructive`** — reachability failure is not a
   dead session.
5. **Creating** on an unreachable server is disabled (header `＋` off; the
   create-dialog `Select` shows it disabled) — you cannot start work on a machine
   the gateway can't reach. _Existing_ sessions stay clickable; only _new_
   creation is blocked.

---

## 7. Surface 5 — Deep link + clicking a greyed session (pane behavior)

### 7.1 Deep link (FE implementation — noted, not specced in detail)

`?session=<serverId>/<id>` (e.g. `?session=build01/web-1a2b…`). Extend
`use-session-url-sync.ts` to parse/emit the qualified id. The single-server case
stays `?session=web-…` iff the qualified id degrades to bare `web-…` for `local`
— **match whatever qualified-id convention §2 lands on** (URL string must equal
the `activeSessionId` string). Implementation is the FE agent's; this spec only
fixes the format and the equality requirement.

### 7.2 What the terminal pane shows for a clicked unreachable/failing session

Because §3.4 keeps the row clickable, define the pane result so it is never a
blank terminal. When the WS attach to a session on an unreachable server fails
(the gateway surfaces a _distinguishable_ exit reason per plan failure-mode #3),
the pane shows a centered overlay (reuse the terminal's existing
disconnected/reconnecting overlay chrome, muted styling — **not** destructive):

- Icon: lucide `Unplug` `size-8 text-muted-foreground`.
- Line 1 (`text-foreground text-sm`): `Can't reach {serverName}.`
- Line 2 (`text-muted-foreground text-xs`): `The session is still running there.
Reconnecting…`

This must be **visually distinct** from an ordinary gateway disconnect
(which is a transient "Reconnecting…" without the "still running there"
reassurance), so the user understands the job is safe. The existing reconnect
loop in `connection.ts` handles the retries; this spec only fixes the copy and
that it uses muted, not destructive, tones.

---

## 8. How it degrades to today (single-server) — summary

| Aspect                   | Only `local` exists                                         | ≥ 2 servers                          |
| ------------------------ | ----------------------------------------------------------- | ------------------------------------ |
| Server headers           | **Not rendered**                                            | Rendered for all servers incl. local |
| Sidebar tree             | Exactly today (org→project or flat)                         | Same tree nested under each server   |
| Collapse keys            | Bare (`org`, `org/project`) — existing persisted state kept | serverId-namespaced                  |
| Create dialog            | No server field (implicit `local`)                          | Server `Select` at top               |
| Collapsed rail tooltip   | No server line                                              | Server-name line added               |
| Deep link                | `?session=web-…`                                            | `?session=<serverId>/web-…`          |
| "Add server" sidebar row | Hidden                                                      | Shown at bottom of server list       |
| Servers settings tab     | Present (shows local + "add a server" hint)                 | Present                              |

The Servers settings tab is the **only** always-visible new surface; everything
in the sidebar is invisible until a second server is added — so a user who never
uses multi-server sees an unchanged product.

---

## 9. Icon & token quick-reference (for the FE agent)

| Element                             | lucide icon                  | Size                      | Color token                                        |
| ----------------------------------- | ---------------------------- | ------------------------- | -------------------------------------------------- |
| Server header / tab / create-select | `Server`                     | `size-3.5`                | `text-muted-foreground`                            |
| Org header (unchanged)              | `Building2`                  | `size-3.5`                | `text-muted-foreground`                            |
| Project header (unchanged)          | `Folder`                     | `size-3.5`                | `text-muted-foreground`                            |
| Collapse chevrons                   | `ChevronRight`/`ChevronDown` | `size-3`                  | `text-muted-foreground`                            |
| Add server / New session `＋`       | `Plus`                       | `size-3` / `size-3.5`     | `text-muted-foreground`                            |
| Remove server                       | `Trash2`                     | `size-3.5`                | `text-muted-foreground` → `hover:text-destructive` |
| Unreachable chip / pane overlay     | `Unplug`                     | `size-3` / `size-8`       | `text-muted-foreground`                            |
| Test-connection success             | `CircleCheck`                | `size-3.5`                | `text-chart-1`                                     |
| Test-connection / add failure       | `CircleAlert`                | `size-3.5`                | `text-destructive`                                 |
| Testing / adding spinner            | `Loader2 animate-spin`       | `size-3.5`                | `text-muted-foreground`                            |
| Reachable dot                       | —                            | `size-[7px] rounded-full` | `bg-chart-1`                                       |
| Unreachable dot                     | —                            | `size-[7px] rounded-full` | `bg-muted-foreground`                              |
| Checking dot                        | —                            | `size-[7px] rounded-full` | `bg-chart-2`                                       |

All strings above are the final user-facing copy. Active voice, specific, no
hex, tokens only.
