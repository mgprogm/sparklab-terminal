# File Explorer — In-place Editing & VSCode-style Change Display

> Status: **proposed design, not yet implemented.** Extends
> `docs/FILE-EXPLORER-PLAN.md`, whose §7 explicitly deferred "in-place text
> editing / save" and whose §8 open decision #5 left it unresolved ("a
> dedicated `fs/write` for edited text is a natural follow-up"). This doc picks
> that follow-up up and adds three more VSCode-parallel behaviors: git-baseline
> change highlighting, a dirty/unsaved indicator, and external-change
> detection. Everything below is additive to the shipped v1 explorer — no
> existing route, schema, or component behavior changes except where called
> out (`FsReadResponse` gains one field).

---

## 0. Grounding (verified against source, this pass)

- Preview today is a **read-only** `<pre>` (`file-explorer-dialog.tsx:790-792`)
  — no textarea, no edit button, no dirty state anywhere in that file.
- `useFsRead` (`use-file-explorer.ts:206-213`) is the only content fetch; it
  has `staleTime: 30_000` and **no poll** — nothing currently detects a file
  changing on disk while open.
- **No write-file-content route exists.** `fs/upload` (`server.js:6340-6414`)
  is the closest precedent: it bypasses the global 64 KB `BODY_LIMIT`
  route-locally, manually buffers up to `FS_UPLOAD_CAP` (8 MB) with
  early-drain-past-cap (so the client gets a clean 413, not `ECONNRESET`), then
  `serverCmdStdin(server, ["tee","--",path], buf)`. This is the exact shape a
  new "save my edit" route reuses.
- `fs/read` (`server.js:6194-6270`) already runs `find -maxdepth 0 -printf
'%y\t%s'` on the target to get true type/size before the capped `head -c`
  read. Adding `%T@` to that same `-printf` gets mtime for free, matching how
  `fs/list` already produces `FsEntry.mtime`.
- **Binary detection is NUL-byte-in-buffer** (`buf.includes(0)`,
  `server.js:6247`); `FS_READ_CAP = 256*1024` (`server.js:4881`). Files that
  are binary or truncated at the read cap have no safe round-trip today — that
  constraint carries into editing (see D11).
- **No editor or diff library exists anywhere in the monorepo**
  (`grep -ri "monaco|codemirror|jsdiff|diff-match-patch"` across every
  `package.json` returned zero matches). No documented policy restricts
  `apps/terminal` from adding one — the repo's "dependency-minimal" language
  is scoped to the gateway (backend) and to the sandboxed Kanban/PM/Agentic
  artifact HTML files, not the main Next.js app.
- The **footer git-status route** (`GET /api/sessions/:id/git`,
  `server.js:5878-5937`) is the existing git precedent: it resolves the
  session's pane cwd via `serverExec(tmux display-message ...)`, then runs
  `serverCmd(server, ["git","-C",dir,"status","--porcelain=v2","--branch"],
{timeout:8000})` — **no `rev-parse --show-toplevel`**, it just lets `git -C`
  walk up to find the work tree itself. There is no existing "raw git stdout"
  helper beyond the generic `serverCmd` seam; a new route calls it directly,
  same pattern.
- **All existing safety invariants stay intact and are reused as-is:** paths
  are always a single argv token through `serverCmdArgv`/`serverCmdStdin`,
  every destructive command uses `--`, and the Origin/CSRF check already
  covers **POST/DELETE/PATCH/PUT** (confirmed — no gateway change needed to
  cover a new `PUT` route).

---

## 1. Scope

**In scope** (the four behaviors confirmed with the user):

1. **In-place text editing** — replace the read-only `<pre>` with an actual
   editable code editor, with a Save action.
2. **Change highlighting, git-baseline** — colored gutter markers
   (added/modified/removed lines) diffed against `git show HEAD:<path>`,
   matching what VSCode's gutter bars actually are (a diff against the git
   baseline, not against "what you last loaded" — see D9). Persists after
   save, same as VSCode.
3. **Dirty / unsaved-changes indicator** — a marker when there are unsaved
   edits, plus a confirm before discarding them.
4. **External-change detection** — if the file changes on disk while open
   (another terminal command, the agent's `run_codex`/`run_command`, a second
   browser tab), show a non-destructive banner rather than silently
   reloading or silently letting Save clobber it.

**Explicitly out of scope / non-goals:** multi-file tabs (still one preview
pane per dialog instance, matching the existing single-selection model);
autocomplete/LSP/intellisense; a "New file" UI affordance; a general SCM
panel (stage/commit/diff-all-changed-files) — the footer git-status feature
already covers the summary-count case, this doc only adds a per-file gutter;
continuous git-baseline polling (see D9 — fetched once per open, not on the
mtime-poll cadence); non-UTF-8 encodings.

---

## 2. Architectural decisions

Continuing the numbering from `FILE-EXPLORER-PLAN.md` (D1–D5).

- **D6 — New `PUT /fs/write` route, modeled directly on `fs/upload`'s
  raw-body pattern, gated by mtime.** Body is the raw edited UTF-8 text (not
  JSON — keeps the same body-limit-bypass shape as upload). Query params
  `path` (required), `baseMtime` (the mtime the client loaded/last-saved at),
  `force` (`0`/`1`). Server re-stats the target immediately before writing;
  if `baseMtime` is present, non-forced, and doesn't match the current
  mtime **or the file is missing** (deleted externally since load) → **409**
  `{error:"stale", currentMtime, currentSize, exists}` instead of writing.
  `force=1` skips the check (used after the user explicitly resolves a
  conflict). `tee` creates the file if it's missing, so a "recreate after
  external delete" Save just works with no separate create path — no "New
  file" affordance is added anywhere in the UI.
- **D7 — New `GET /fs/stat` route for cheap external-change polling.**
  Polling via `fs/read` would re-fetch and re-transfer full file content
  every tick (wasteful, especially over SSH). `fs/stat?path=` returns just
  `{path, exists, type, size, mtime}` — same `find -maxdepth 0 -printf
'%y\t%s\t%T@'` computation `fs/read` already does, factored into a shared
  helper both routes call. This is what the frontend polls while a file is
  open; content is only re-fetched when the user acts on a change banner.
- **D8 — `FsReadResponse` gains `mtime`.** The only change to an existing
  schema. `fs/read`'s existing pre-read stat call already computes this once
  `%T@` is added to its `-printf` format — no new exec.
- **D9 — Git-baseline diff is a one-shot fetch, not a poll.** New
  `GET /fs/git-base?path=` runs `git -C <dirname(path)> show
HEAD:./<basename(path)>` through the existing `serverCmd` seam (identical
  local/ssh dispatch to the footer git-status route — no new plumbing there).
  Using `HEAD:./<basename>` (git's cwd-relative revision syntax) avoids
  needing a separate `rev-parse --show-toplevel` + relative-path computation
  — git resolves it relative to whatever `-C` pointed at, however deep in the
  work tree that is. Three outcomes, distinguished by git's stderr: not
  inside a work tree → `{isRepo:false}` (no gutter, same as no repo at all in
  the footer feature); path not in `HEAD` (untracked, or a repo with no
  commits yet) → `{isRepo:true, tracked:false}` (frontend diffs against an
  empty string, so the whole file reads as added — matches how VSCode shows
  a brand-new/untracked file); success → `{isRepo:true, tracked:true,
content, binary?, truncated?}`, content capped at `FS_READ_CAP` same as
  `fs/read` (oversized committed blob → `truncated:true`, frontend skips the
  gutter and shows a small "diff unavailable — file too large" note rather
  than drawing a diff against partial content). **Fetched once when a file is
  opened**, refetched only when the user clicks "Refresh diff" or accepts a
  Reload from the external-change banner — not on the 5s stat-poll cadence,
  since the git baseline only changes on commit/checkout/branch-switch, far
  rarer than "someone edited the file."
- **D10 — Editor: CodeMirror 6 + `@codemirror/merge`, themed off existing CSS
  tokens.** Recommended over Monaco for bundle size and Next.js/webpack
  friendliness (no worker-bundling setup, tree-shakes per language). Two
  distinct pieces from the same package give both remaining behaviors for
  free instead of hand-rolling diff math:
  - `unifiedMergeView` (an extension attached to the single live editor) with
    `original` = the git-baseline content from D9 → this **is** the gutter
    decoration (added/changed/removed line markers), and it's re-pointed at a
    fresh baseline whenever D9 refetches. This is the actual mechanism, not a
    metaphor — VSCode's own gutter bars are conceptually the same
    "diff current buffer against a fixed reference doc" operation.
  - `MergeView` (the two-pane comparison widget) reused specifically for the
    conflict/external-change resolution UI in D14 — comparing the user's
    in-memory (possibly edited) content against the new on-disk content, not
    against git.
  - `@codemirror/language-data` for syntax highlighting auto-detected by file
    extension (async `.load()` per file open).
  - Theme: a custom `EditorView.theme()` built from the existing CSS
    variables (`--background`, `--foreground`, `--border`, `--accent`, …) —
    no canned CodeMirror theme import, consistent with how Kanban/PM
    hardcode the DESIGN.md palette rather than pulling in a mismatched one.
- **D11 — Editing is disabled exactly where preview already degrades: binary
  or truncated files.** D3 in the original doc already established "no
  inline preview for binary" with a Download fallback; this extends it to
  "no inline edit" for the same two cases (binary, or read-capped at 256 KB)
  — editing a partial view of a file can't safely round-trip, so the backend
  independently re-checks (400 if a write ever hit a >256 KB target,
  defense-in-depth against a stale client). For every other text file,
  editing is **always on** — no separate "Edit mode" toggle, matching VSCode
  where opening a text file makes it editable immediately.
- **D12 — Save is explicit, never autosave.** Ctrl/Cmd+S (bound via a
  CodeMirror keymap, `preventDefault()`'d so the browser's own save-page
  dialog never fires) or a toolbar Save button. This matches VSCode's
  default (no autosave-on-blur) and avoids writing to a remote/SSH
  filesystem on every keystroke or focus change.
- **D13 — Byte-exact round trip.** Preserve the file's original line endings
  and trailing-newline presence on save; send/receive raw UTF-8 bytes, never
  JSON-string-escaped. This repo already treats multibyte-safety as
  load-bearing (raw-bytes pty invariant, Thai-input tests) — CodeMirror
  normalizes to `\n` internally, so the original EOL style must be detected
  on load and re-applied to the buffer immediately before it's sent to
  `fs/write`, or a CRLF file would show as "changed on every line" the
  instant it's opened.
- **D14 — One conflict funnel, two triggers.** Both a passive external change
  (D7's stat poll notices the mtime moved while the file is merely open) and
  an active save conflict (D6's write returns 409) render the **same**
  banner/dialog: "This file changed on disk" with **Reload** (discard local
  edits, load the new version), **View diff** (open the `MergeView` from D10
  comparing local vs. on-disk, so the user can see and manually reconcile
  before choosing), and, for the save-conflict case specifically,
  **Overwrite anyway** (retries the write with `force=1`). Nothing ever
  auto-reloads or auto-overwrites.

---

## 3. Backend endpoints (new)

All nested under the existing authenticated `/api/sessions/:id/…` dispatch,
reusing the standard `parseSessionRef` → `ID_RE` → `registry.get` →
`sessionExists` guard chain (404 on any miss) and the existing Origin check
(already fires for `PUT`, no change needed).

**`GET /api/sessions/:id/fs/stat?path=<abs>`** (origin-exempt, like the other
GETs)

- One `find <path> -maxdepth 0 -printf '%y\t%s\t%T@'` via `serverCmd`.
- Missing path → `{path, exists:false}` (200 — a valid poll outcome, not an
  error).
- Response: `{path, exists:true, type, size, mtime}`.

**`PUT /api/sessions/:id/fs/write?path=<abs>&baseMtime=<epoch>&force=0|1`**
(Origin-checked)

- Re-stat first (reuses the D7 helper). Not-a-regular-file (dir/symlink) → 400. Existing size over `FS_READ_CAP` → 400 (defense-in-depth; the UI
  shouldn't reach this).
- `baseMtime` present, `force` not `1`, and (stat mismatch OR file now
  missing) → **409** `{error:"stale", currentMtime, currentSize, exists}`,
  no write performed.
- Otherwise buffer the raw body up to `FS_READ_CAP` (256 KB — text edits are
  bounded by what could ever have been loaded for editing), same
  early-drain-past-cap behavior as `fs/upload` → 413 on overflow.
- `serverCmdStdin(server, ["tee","--",path], buf)`, then re-stat for the new
  `mtime`/`size`.
- Response: `{path, size, mtime}`.

**`GET /api/sessions/:id/fs/git-base?path=<abs>`** (origin-exempt)

- `serverCmd(server, ["git","-C",dirname(path),"show",
`HEAD:./${basename(path)}`], {timeout:8000, encoding:"buffer"})` — same
  seam and timeout precedent as the footer git-status route.
- stderr matching `not a git repository` → `{isRepo:false}`.
- stderr matching `does not exist in 'HEAD'` (or `bad revision 'HEAD'` for a
  commit-less repo) → `{isRepo:true, tracked:false}`.
- Success, NUL byte in buffer → `{isRepo:true, tracked:true, binary:true}`
  (no gutter for a binary baseline).
- Success, over `FS_READ_CAP` → `{isRepo:true, tracked:true, truncated:true}`
  (no content).
- Success, else → `{isRepo:true, tracked:true, content}`.

**`fs/read` change:** add `%T@` to its existing pre-read `find -printf`
format; response gains `mtime` (see D8).

Error-mapping conventions (403/404/409/413/502) follow the existing table in
`FILE-EXPLORER-PLAN.md` §3 — nothing new there.

---

## 4. Shared types (`packages/shared-types/src/terminal.ts`)

```
FsReadResponseSchema          // ADD: mtime: z.number().nullable()

FsStatResponseSchema = z.union([
  z.object({ path: z.string(), exists: z.literal(false) }),
  z.object({ path: z.string(), exists: z.literal(true), type: FsEntryTypeSchema,
             size: z.number(), mtime: z.number().nullable() }),
])

FsWriteResponseSchema = z.object({ path: z.string(), size: z.number(),
                                    mtime: z.number().nullable() })
// 409 body reuses ApiErrorSchema plus ad-hoc fields (currentMtime, currentSize,
// exists) the same way rename's 409 already carries extra context — no schema
// needed for an error body per existing convention.

FsGitBaseResponseSchema = z.union([
  z.object({ isRepo: z.literal(false) }),
  z.object({ isRepo: z.literal(true), tracked: z.literal(false) }),
  z.object({ isRepo: z.literal(true), tracked: z.literal(true), binary: z.literal(true) }),
  z.object({ isRepo: z.literal(true), tracked: z.literal(true), truncated: z.literal(true) }),
  z.object({ isRepo: z.literal(true), tracked: z.literal(true), content: z.string() }),
])
```

No request-body schema for `fs/write` — it's a raw-body route like upload,
params travel in the query string.

---

## 5. Frontend

### 5a. New dependencies (`apps/terminal/package.json`)

`codemirror` (or the unbundled `@codemirror/state` + `@codemirror/view` +
`@codemirror/commands` + `@codemirror/language`), `@codemirror/language-data`,
`@codemirror/merge`. No other new packages.

### 5b. `use-file-explorer.ts` additions

- `useFsStat(sessionId, path, {enabled})` — `refetchInterval: 5000`; TanStack
  Query's default `refetchIntervalInBackground:false` already gives the
  visibility gating for free (no custom `document.visibilityState` code
  needed), consistent with how push notifications suppress work for
  backgrounded/hidden state elsewhere in this codebase.
- `useFsWrite(sessionId)` — `useMutation` posting to `fs/write`; a 409 is
  parsed into a distinct `FsConflictError` (carries `currentMtime`,
  `currentSize`, `exists`) rather than falling into the generic
  `fsErrorMessage` mapping, so the dialog can route it to the D14 conflict
  UI instead of a toast.
- `useFsGitBase(sessionId, path, {enabled})` — one-shot `useQuery`, no
  interval; manually `refetch()`-ed by the "Refresh diff" action and by
  accepting a Reload.

### 5c. New component — `components/file-editor.tsx`

Wraps a CodeMirror instance. Props: `content`, `gitBaseContent | null`,
`readOnly`, `language` (from extension), `onChange(content)`,
`onSave()` (bound to Ctrl/Cmd+S). Internally applies `unifiedMergeView`
(D10) when `gitBaseContent` is available, and detects/re-applies the
original EOL style (D13) around the CodeMirror boundary.

### 5d. `file-explorer-dialog.tsx` changes

- Swap the `<pre>` block (currently `:790-792`) for `<FileEditor>` when the
  file is text and not truncated; keep the existing binary/truncated
  fallback UI unchanged (D11).
- New local state: `draftContent`, `isDirty` (`draftContent !==
loadedContent`), `baseMtime`, `conflict: {currentMtime, currentSize, exists}
| null`.
- Preview header gains: a small dot next to the filename when `isDirty`;
  Save (disabled unless dirty) / Discard buttons; a "Refresh diff" icon
  button.
- Wire `useFsStat` while `previewPath` is set; on a returned `mtime` that
  differs from `baseMtime` (or `exists:false`), set the same `conflict`
  state D6's 409 path sets — one render path for both triggers (D14).
- Intercept file-row clicks, directory navigation, and dialog close while
  `isDirty` with a confirm ("Discard unsaved changes?") — mirrors the
  existing delete-confirm pattern already in this file, no new primitive.
- Conflict UI is a `MergeView` (D10) inside an `AlertDialog`-style panel with
  Reload / View diff / Overwrite anyway (only when the trigger was an
  attempted Save) actions.

---

## 6. Phased implementation checklist

1. Backend: add `%T@` to `fs/read`'s existing `-printf` + `mtime` in its
   response (smallest, fully backward-compatible change — ship and verify
   alone first).
2. Backend: `fs/stat` (factor the shared find-stat helper out of `fs/read`'s
   existing pre-read call).
3. Backend: `fs/write`, modeled on `fs/upload`'s buffering, with the mtime
   gate.
4. Backend: `fs/git-base`.
5. Shared types: the four schema changes in §4.
6. Frontend hooks: `useFsStat`, `useFsWrite`, `useFsGitBase`.
7. Frontend: `file-editor.tsx` (CodeMirror + `unifiedMergeView`, no merge/save
   wiring yet — just render + edit + local dirty tracking).
8. Frontend: wire Save/Discard/dirty-dot/navigate-away-confirm into
   `file-explorer-dialog.tsx`.
9. Frontend: external-change poll + conflict `MergeView` (D14) — the last
   piece, since it depends on everything above.
10. Tests (§7), interleaved per backend step as in the original doc's build
    order.

---

## 7. Testing

**Gateway (`apps/terminal-gateway/test/fs-endpoints.js`, extended):**

- `stat`: existing file matches `list`'s mtime convention; missing path →
  `{exists:false}`, 200.
- `write`: plain overwrite 200 + exact byte round-trip including a CRLF
  fixture; mtime-mismatch → 409 no write performed; `force=1` after a
  409 → 200; over-cap body → 413; target is a directory → 400; missing
  target → creates it (200).
- `git-base`: outside any repo → `isRepo:false`; inside a repo, file
  untracked → `tracked:false`; tracked + clean → content matches `git show`
  directly; tracked + working-tree-modified → content still matches `HEAD`
  (proving it's the baseline, not the working copy); oversized committed
  blob → `truncated:true`.
- Guards: bad session id → 404 on all three new routes; write's Origin/CSRF
  check → forbidden-origin write is rejected, no file mutation occurs.

**Shared-types:** valid/invalid parse cases for the four new/changed schemas
in `terminal.test.ts`.

**Manual/e2e (CodeMirror + poll timing aren't practical to script here):**

- Open a git-tracked file with pre-existing uncommitted changes → gutter
  shows those immediately (proves baseline-diff, not future-edits-only).
- Type a change → live gutter update; Ctrl/Cmd+S saves, no browser
  save-page dialog fires, dirty dot clears.
- From a second terminal in the same session, `echo >> <open file>` while
  the explorer is open → banner appears within one poll interval; Reload and
  View-diff both work; content is never silently replaced.
- Trigger a save conflict (edit locally, externally modify, then Save) →
  409 flow reaches the same conflict UI; Overwrite anyway succeeds.
- Binary and truncated (>256 KB) files: confirm editing stays disabled,
  today's Download-only behavior is unchanged.

---

## 8. Deliberately deferred

- "New file" creation UI (write creating a missing file is an implementation
  detail of Save-after-external-delete, not an exposed affordance).
- Any SCM panel beyond the per-file gutter (stage/commit/diff-all-files).
- Polling the git baseline on the same cadence as the mtime stat poll.
- Non-UTF-8 encodings, multi-file tabs, LSP/autocomplete.
- Monaco as an alternative editor (D10 picks CodeMirror 6; revisit only if a
  concrete gap in fidelity shows up in practice).

## 9. Open decisions still worth confirming before build

1. Exact poll interval for `fs/stat` (draft assumes 5s, matching the footer
   git-status poll already in the codebase).
2. Whether `git-base` should also be refetched automatically when `fs/stat`'s
   poll detects a change (currently: no, manual/on-reload only — D9).
3. Whether the write cap should be `FS_READ_CAP` (256 KB, symmetric with what
   can ever be loaded) or a distinct, possibly smaller, constant.

---

## Critical files

- `apps/terminal-gateway/src/server.js` — `fs/read` mtime addition, new
  `fs/stat`/`fs/write`/`fs/git-base` routes, shared stat helper.
- `packages/shared-types/src/terminal.ts` — schema changes in §4.
- `apps/terminal/src/features/terminal/hooks/use-file-explorer.ts` — new
  hooks in §5b.
- `apps/terminal/src/features/terminal/components/file-editor.tsx` — NEW.
- `apps/terminal/src/features/terminal/components/file-explorer-dialog.tsx` —
  wiring in §5d.
- `apps/terminal-gateway/test/fs-endpoints.js` — extended per §7.
