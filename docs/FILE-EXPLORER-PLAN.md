# File Explorer Modal — Design & Implementation Plan

> Status: **implemented & QA-verified** (2026-07-16). Scope: **full read/write**
> file explorer, **no inline preview for binary files** (binaries are
> downloadable instead). Backend seam + 6 routes, shared Zod types, frontend
> hook + modal + header button all built; `apps/terminal-gateway/test/fs-endpoints.js`
> (18 checks) passes, cross-workspace typecheck + lint clean, and the modal was
> driven end-to-end in a real browser (login → open → cwd seed → breadcrumb →
> text preview → mkdir → delete-confirm, all round-tripping). Two backend bugs
> were found and fixed during QA (upload-413 socket race; binary `truncated`
> drift). This doc remains the decision record; the numbered sections below
> describe the shipped design.

A file explorer modal scoped to the **currently selected terminal**. A button
beside the terminal title in the header opens it. The explorer browses (and
manages) the filesystem of whatever server that session lives on — `local` or a
registered remote reached over SSH — starting at the session's current working
directory.

---

## 0. Grounding (verified against source)

- Header title span: `apps/terminal/src/features/terminal/components/terminal-shell.tsx:359-367`.
  `activeSessionId`, `activeServerId` (line 160), `activeMeta` (278),
  `activeServer` (283), and `activeServerUnreachable` (286-287) are **all already
  in scope right there** — the button's disabled logic is already computed.
- tmux exec seam: `serverExecArgv(server, tmuxArgs, {tty})` at `server.js:407-420`,
  wrapped by `serverExec` (423) / `serverExecStdin` (431). Local returns bare
  `[...tmuxCmd, ...tmuxArgs]` run via `execFile` (no shell); ssh `shellQuote`s
  every token (389-391), joins on spaces, prepends `sshOptsFor(server)` + host,
  runs with `childEnvFor(server)` (342-345, carries the SSH askpass env).
- Session refs: `parseSessionRef` splits on first `/` → `{serverId, tmuxName}`;
  `ID_RE = /^web-[A-Za-z0-9-]+$/` (server.js:227). Every `/api/sessions/:id/*`
  route runs the same guards: `ID_RE.test(tmuxName)` → `registry.get(serverId)` →
  `await sessionExists(server, tmuxName)`, all 404 on miss (scrollback 1089-1101,
  screen 1150-1156).
- Session cwd: `display-message -p -t <name> '#{pane_current_path}'` (server.js:1176-1181).
- Auth/origin gating: `handleApi` (837) runs an Origin check on **POST/DELETE/PATCH
  only** (840-850) — **GET is exempt** (scrollback comment, 1082) — then the
  `isAuthenticated` gate (871-873). There is **no general per-route rate limiter**;
  only `handleLogin` is rate-limited (655). Body cap is 64 KB (`BODY_LIMIT`, 631).
- Frontend patterns: `use-servers.ts` (Zod-parse at the fetch boundary,
  `UnauthorizedError` on 401, `refetchInterval: 3000`); `useUrlFlagSync("agent", …)`
  and `useSettingsUrlSync` in terminal-shell (125-131); dialog open-state lives in
  the Zustand store (`settingsOpen`/`setSettingsOpen`, store.ts:52-55); dialogs are
  mounted once near the end of `terminal-shell.tsx` (448-457). `SettingsDialog`
  uses `@sparklab/ui/components/ui/dialog`, lucide icons at `size-3.5/4`, theme
  tokens only.
- Gateway tests are standalone node scripts under `apps/terminal-gateway/test/`
  that `spawn` a real gateway on a private port + real tmux and assert by throwing
  (e.g. `agent-endpoints.js`).

---

## 1. Architectural decisions

- **D1 — Key by session id; nest routes under `/api/sessions/:id/fs/*`.** The
  explorer is scoped to the selected terminal, so the session id is the natural
  key. The gateway derives `server` + initial `cwd` server-side, reuses the exact
  `ID_RE → registry.get → sessionExists` guard chain, and inherits auth + origin
  handling. (Rejected alternative: explicit `serverId` + `path`, which duplicates
  the guards and exposes an fs surface untied to any live session.)
- **D2 — Full read/write in v1.** List + read (text preview) + **download**
  (incl. binaries) + **upload** + **mkdir** + **rename/move** + **delete**.
  State-changing ops are separate routes and, per `handleApi`, automatically get
  the Origin check that GETs skip. Destructive ops (delete, overwrite-on-rename)
  require an explicit confirm in the UI.
- **D3 — No inline preview for binary files.** Detect binary via a NUL byte in the
  read buffer; the preview pane shows "Binary file — preview unavailable" plus a
  **Download** button (download is in scope, so binaries are still retrievable).
- **D4 — Portable listing via a single GNU `find` exec.** One process per
  directory (no per-entry round trips → scales to large dirs). Fields tab-delimited,
  **records NUL-delimited** so filenames with spaces/tabs/newlines can't corrupt
  parsing. Gateway host and remotes are Linux (coreutils) — commit to
  `find -printf` for v1; document a `stat`-loop / `python3` fallback as a v1.1
  concern.
- **D5 — The path is always one argv token.** It flows into the seam as a single
  element; on ssh it gets `shellQuote`d. **No string concatenation of paths into a
  command, ever.** Require absolute paths (`/…`). Every command uses `--` to
  terminate option parsing so filenames beginning with `-` are safe. This is the
  user's own shell — full-fs access is the feature, not a boundary to defend — so
  `..`/traversal is not a vuln here; we still normalize paths for predictable
  breadcrumbs.

---

## 2. New exec seams: `serverCmdArgv` / `serverCmd` / `serverCmdStdin`

Add as siblings of `serverExecArgv`, in the same block of `server.js` (~after 438).
They are `serverExecArgv` **without the tmux prefix**.

```
serverCmdArgv(server, argv, { tty = false } = {})
```

- `server.type === "local"` → return `argv` verbatim; caller runs
  `execFile(argv[0], argv.slice(1))` — no shell, each element already one literal
  argument (identical to the local tmux path).
- ssh → `["ssh", ...(tty?["-tt"]:[]), ...sshOptsFor(server), sshHost(server),
argv.map(shellQuote).join(" ")]`. Same re-split hazard as the tmux path — every
  token quoted so the remote shell reconstructs the exact argv.

Async wrappers mirroring `serverExec` / `serverExecStdin`:

```
serverCmd(server, argv, { maxBuffer, timeout } = {})
serverCmdStdin(server, argv, input, { maxBuffer, timeout } = {})   // for upload (tee)
```

Enforce in review:

- **Reuse `childEnvFor(server)`** so password-auth askpass env is present.
- Set a `timeout` (~15 s) and an explicit **`maxBuffer`** — execFile's default is
  1 MB; a big dir listing or file read will exceed it. Size `maxBuffer` to the read
  cap + slack; cap `find` output.
- Never build a shell string on the local path; never interpolate a path except as
  an argv element; always pass `--`.
- Difference vs `serverExecArgv`: no `server.tmuxCommand`, no tmux tokens.

---

## 3. Backend endpoints

All under the authenticated `/api/sessions/:id/…` dispatch in `handleApi`, after
the scrollback block (~1131). Each runs the standard `parseSessionRef` + `ID_RE` +
`registry.get` + `sessionExists` guard (404 on any miss). GETs are origin-exempt
(matching scrollback); POST/DELETE/PATCH get the Origin check automatically.

### Read routes (GET — origin-exempt)

**`GET /api/sessions/:id/fs/list?path=<abs>&showHidden=0`**

- `path` omitted → resolve session cwd via `serverExec(server, ["display-message",
"-p", "-t", tmuxName, "#{pane_current_path}"])` and list that.
- Validate `path`: non-empty absolute string, else 400.
- Command via `serverCmd`: a single `find`, conceptually
  `find <path> -maxdepth 1 -mindepth 1 [-name '.*' pruned unless showHidden]
 -printf '%y\t%s\t%T@\t%m\t%l\t%f\0'`
  (type char, size, mtime epoch, octal mode, symlink target, basename; NUL record
  separator). Also stat `<path>` itself to confirm it's a directory. Cap entries
  (~5000) → `truncated:true` if exceeded.
- Type map: `d`→`dir`, `f`→`file`, `l`→`symlink`, else `other`. Symlink target from
  `%l`; do **not** follow/recurse.
- Errors → HTTP: not-a-dir / no-such-file → 404; permission denied → 403; else 502
  with a sanitized message.
- Response: `{ path, entries: FsEntry[], truncated?: boolean }`.

**`GET /api/sessions/:id/fs/read?path=<abs>`** (text preview)

- `head -c <CAP+1>` into the buffer; true size from `find -printf '%s'` / `stat`.
- **Binary detection:** NUL byte in the buffer (and/or high non-text ratio) →
  `binary:true`.
- **Size cap:** `FS_READ_CAP = 256 * 1024`. Bytes read > CAP → `truncated:true`,
  content = first CAP bytes.
- Response: `{ path, size, binary, truncated, encoding: "utf-8"|null, content? }`.
  Binary → omit `content` (client offers Download). Text → `content` is the utf-8
  string. Keep CAP < execFile `maxBuffer`.

**`GET /api/sessions/:id/fs/download?path=<abs>`** (binary-safe, no cap)

- Streams `serverCmd`/`serverCmdArgv(server, ["cat", "--", path])` stdout **directly
  to the HTTP response** (do not buffer through `maxBuffer`). Set
  `Content-Disposition: attachment; filename="<basename>"` and
  `Content-Type: application/octet-stream`. This is how binaries are retrieved
  given D3.
- For remote servers this is the ssh child's stdout piped to `res`; guard against a
  hung stream with a timeout.

### Write routes (state-changing — Origin-checked)

**`POST /api/sessions/:id/fs/upload?path=<abs-dest-file>`**

- Streams the **raw request body** to `serverCmdStdin(server, ["tee", "--",
destPath], <body-stream>)` (stdout discarded). `tee` writes the file portably.
- **Bypass/raise `BODY_LIMIT` for this route only** — stream the body, don't buffer
  the 64 KB-capped JSON path. Enforce a separate configurable upload cap
  (e.g. `FS_UPLOAD_CAP`, default a few MB) and reject early past it.
- Overwrite semantics: `tee` truncates. If we want no-clobber, stat first and 409 on
  exists unless an `overwrite=1` flag is set (UI confirms). Response
  `{ path, size }`.

**`POST /api/sessions/:id/fs/mkdir`** — JSON `{ path }` → `mkdir -- <path>` (no
`-p`; fail-if-exists → 409). Response `{ path }`.

**`PATCH /api/sessions/:id/fs/entry`** — JSON `{ from, to }` → `mv -- <from> <to>`
(rename/move). If `to` exists → 409 unless `overwrite`. Response `{ from, to }`.

**`DELETE /api/sessions/:id/fs/entry?path=<abs>&recursive=0`** — file/empty-dir →
`rm -- <path>` / `rmdir -- <path>`; non-empty dir requires `recursive=1` →
`rm -r -- <path>`. **UI must show a strong confirm**, and `recursive` must be an
explicit client opt-in. Response `{ path }`.

Common error mapping for write routes: permission denied → 403, target-missing →
404, already-exists → 409, else 502.

### Zod schemas — add to `packages/shared-types/src/terminal.ts`

```
FsEntryTypeSchema = z.enum(["file","dir","symlink","other"])
FsEntrySchema     = z.object({ name, type: FsEntryTypeSchema, size: z.number(),
                               mtime: z.number().nullable(), mode: z.string(),
                               symlinkTarget: z.string().optional() })
FsListResponseSchema = z.object({ path: z.string(), entries: z.array(FsEntrySchema),
                                  truncated: z.boolean().optional() })
FsReadResponseSchema = z.object({ path, size, binary, truncated,
                                  encoding: z.enum(["utf-8"]).nullable(),
                                  content: z.string().optional() })
// request bodies for write ops: FsMkdirRequest {path}, FsRenameRequest {from,to,overwrite?}
```

Export the inferred TS types; reuse `ApiErrorSchema` for failures. Keep the gateway
JSON in sync by hand — the gateway is dependency-free JS and can't import this
module. Follow the file's "every field matches actual JSON, invent nothing"
convention.

**Rate/concurrency note:** these routes spawn a child process (and maybe an ssh
round trip) per call. Recommend a lightweight per-session in-flight cap or client
debounce rather than a new global limiter. (Open decision, §8.)

---

## 4. Frontend

### 4a. Store (`store.ts`)

Add `explorerOpen: boolean` + `setExplorerOpen`, mirroring `settingsOpen`
(52-55, 94-95). The current directory path is **local component state** seeded from
the list response's `path` (not global) unless we deep-link the path (§4e).

### 4b. Data hook — `apps/terminal/src/features/terminal/hooks/use-file-explorer.ts`

Mirror `use-servers.ts`:

- Query-key factory `fsKeys = { all:["fs"], list:(id,path)=>…, read:(id,path)=>… }`.
- `fetchFsList` / `fetchFsRead` — `fetch` with `encodeURIComponent` on the qualified
  id + `path`; 401 → `throw new UnauthorizedError()`; non-ok → throw parsed
  `{error}`; then `FsListResponseSchema.parse` / `FsReadResponseSchema.parse`.
- `useFsList(sessionId, path)` — `enabled: open && !!sessionId && !unreachable`,
  **no `refetchInterval`** (fs isn't a live poll — add a manual refresh button),
  `keepPreviousData` so navigating dirs doesn't flash empty.
- `useFsRead(sessionId, path|null)` — `enabled: !!path`, lazy on file selection.
- **Mutations** (`useMutation`, invalidate `fsKeys.list(id, currentPath)` on success):
  `useFsMkdir`, `useFsRename`, `useFsDelete`, `useFsUpload` (POSTs the file stream).
  Download is a plain anchor/`fetch`-to-blob to the `/fs/download` URL, not a query.

### 4c. Modal — `apps/terminal/src/features/terminal/components/file-explorer-dialog.tsx`

- `@sparklab/ui` `Dialog`/`DialogContent`/`DialogHeader`/`DialogTitle`; theme
  tokens only; lucide icons `size-3.5/4`; styled to match `settings-dialog.tsx`.
- Layout: left = directory list; right = preview/detail pane. On mobile
  (`isMobile` already used in shell) collapse to single column with back-to-list.
- **Navigation:** breadcrumb (split `path` on `/`, each crumb navigates), up-dir
  button, double-click dir → navigate in, single-click file → preview via
  `useFsRead`. Rows: type icon (Folder / File / symlink arrow), human-readable
  size, mtime.
- **Toolbar** (write ops): **New folder** (mkdir), **Upload** (file input +
  optional drag-and-drop onto the list). Per-row actions (context menu or hover
  buttons): **Download**, **Rename**, **Delete**.
- **Confirms:** delete uses an `AlertDialog` (recursive delete calls it out
  explicitly); rename-over-existing / upload-overwrite confirm before sending
  `overwrite=1`.
- **Hidden files** toggle in the header, **default off** (`showHidden=0`).
- **States:** loading skeleton rows; empty → "This folder is empty"; errors
  distinguished from the thrown `{error}` — 403 "Permission denied", 404 "Not
  found", 409 "Already exists", 502/unreachable "Server unavailable"; truncated →
  "showing first N entries" footer. Preview: text in a mono `<pre>` (theme tokens,
  scroll); binary → "Binary file — preview unavailable" + Download button;
  truncated → banner.

### 4d. Header button (`terminal-shell.tsx`, right after the name span at line 367)

- `@sparklab/ui` `Button variant="ghost" size="icon"` (~`size-7`), lucide
  `FolderTree` / `FolderOpen` (`size-3.5`), wrapped in a `Tooltip` "Browse files".
- `disabled={!activeSessionId || activeServerUnreachable}` (both already computed,
  lines 160/287). `aria-label="Browse files"`. `onClick={() => setExplorerOpen(true)}`.
- Mount `<FileExplorerDialog open={explorerOpen} onOpenChange={setExplorerOpen}
sessionId={activeSessionId} serverName={…} unreachable={activeServerUnreachable} />`
  next to `<SettingsDialog>` (~448).

### 4e. URL deep-link (optional)

Add `useUrlFlagSync("explorer", explorerOpen, setExplorerOpen)` beside the `"agent"`
call (line 131). Path-in-URL (`?explorer=<encoded-path>`) is possible via a
value-carrying sync like `use-settings-url-sync.ts`, but is brittle across servers —
recommend the bare presence flag for v1.

---

## 5. Phased implementation checklist

1. **Seams** — add `serverCmdArgv` + `serverCmd` + `serverCmdStdin` to
   `apps/terminal-gateway/src/server.js` (~after 438). No change to existing routes.
2. **Read endpoints** — `fs/list`, `fs/read`, `fs/download` in `handleApi` after the
   scrollback block (~1131), reusing the guard chain; commands through
   `serverCmd`/`serverCmdArgv`, cwd seed through `serverExec`.
3. **Write endpoints** — `fs/upload` (streamed body → `serverCmdStdin` tee),
   `fs/mkdir`, `fs/entry` PATCH (rename), `fs/entry` DELETE. Confirm Origin check
   fires for these.
4. **Shared types** — Fs* Zod schemas/types in
   `packages/shared-types/src/terminal.ts` (+ `index.ts` re-export if present).
5. **Hook** — `use-file-explorer.ts` (queries + mutations + download helper).
6. **Modal** — `file-explorer-dialog.tsx`.
7. **Store + header button + mount** — `store.ts` (`explorerOpen`),
   `terminal-shell.tsx` (button after 367, dialog mount ~448, optional
   `useUrlFlagSync`).
8. **Tests** — §6.

Suggested build order to keep each step verifiable: 1 → 2 → (manual curl) → 4 →
(manual curl) → 3 → 5 → 6 → 7, tests interleaved.

---

## 6. Testing

**Gateway integration — `apps/terminal-gateway/test/fs-endpoints.js`** (model on
`agent-endpoints.js`: spawn a gateway on a private port + real tmux, assert-by-throw,
clean up sessions). The harness creates a scratch dir tree using raw `fs`/tmux as
other tests do.

- `list` with no `path` returns the session cwd's entries.
- `list` of the scratch dir returns correct `type`/`size`; dirs vs files.
- **Quoting proof (load-bearing):** create files named with a space, a single
  quote, and a newline; assert they appear intact (validates NUL-record parsing +
  `shellQuote`).
- Hidden-file filtering: `.dotfile` absent by default, present with `showHidden=1`.
- `read`: exact `content` for text; > CAP → `truncated:true`; file with a NUL byte →
  `binary:true`, no `content`.
- `download`: bytes round-trip exactly for a binary fixture.
- Write ops: `mkdir` creates (and 409s on re-create); `upload` (stdin) writes exact
  bytes incl. a name with a space; `rename` moves; `delete` removes a file, refuses a
  non-empty dir without `recursive`, succeeds with it.
- Guards: unknown/malformed session id → 404 on every route; missing/relative
  `path` → 400; nonexistent path → 404; no-permission path → 403 (best-effort; skip
  if run as root); write routes reject a cross-origin request (Origin check).
- Register the script in the gateway `package.json` test aggregation (match the
  existing scripts' invocation).

**Shared-types** — add valid/invalid parse cases to
`packages/shared-types/src/terminal.test.ts`.

**e2e / manual** — the ssh path can't run in the local-only harness; note it as a
manual check against a registered ssh server, plus the unreachable-server path
(button disabled; dialog shows "Server unavailable"). Frontend: verify button
disabled with no session and when `activeServerUnreachable`; verify the delete
confirm and the binary Download path.

---

## 7. Deliberately deferred (post-v1)

- Non-GNU (`find`-less) portability fallback (`stat` loop / `python3`).
- Path deep-linking in the URL.
- Multi-select / bulk operations; drag-to-move between folders.
- In-place text editing / save (v1 preview is read-only display; writing goes
  through upload). A dedicated `fs/write` for edited text is a natural follow-up.
- Server-side search / recursive find within the explorer.

## 8. Open decisions still worth confirming before build

1. **Upload cap** (`FS_UPLOAD_CAP`) value, and whether uploads stream or buffer.
2. **Overwrite policy** default: no-clobber + confirm (recommended) vs. silent
   overwrite.
3. **Rate/concurrency guard** on fs routes: per-session in-flight cap now, or defer.
4. **Read cap** (256 KB) and **entry cap** (5000) exact values.
5. Whether text preview should offer inline **edit + save** in v1 or stay
   read-only (currently deferred to §7).

---

## Critical files

- `apps/terminal-gateway/src/server.js` — new seams + endpoints
- `packages/shared-types/src/terminal.ts` — Fs* schemas/types
- `apps/terminal/src/features/terminal/components/terminal-shell.tsx` — header button + mount
- `apps/terminal/src/features/terminal/store.ts` — `explorerOpen`
- `apps/terminal/src/features/terminal/hooks/use-file-explorer.ts` — NEW hook (pattern: `use-servers.ts`)
- `apps/terminal/src/features/terminal/components/file-explorer-dialog.tsx` — NEW modal (pattern: `settings-dialog.tsx`)
- `apps/terminal-gateway/test/fs-endpoints.js` — NEW test (pattern: `agent-endpoints.js`)
