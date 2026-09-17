# File-type icons (vscode-icons)

The File Explorer renders per-entry file and folder glyphs from
[vscode-icons](https://github.com/vscode-icons/vscode-icons) (MIT) — the same
icon theme the VS Code extension ships. Vendored at **v12.19.0**
(`ce1f8ab24941efb409c4ef9202832a700b05728a`).

## Why this is an exception to "lucide-react only"

`CLAUDE.md` says lucide is the default icon library and not to introduce a
second set. That rule is about **UI affordance** icons — buttons, status, chrome
— where a single-stroke monochrome glyph tinted with a theme token is what the
design language wants.

File-**type** icons are a different job. They are identity marks (the Python
logo, the Docker whale, the TypeScript square), they are multi-colour by
definition, and their whole value is that a developer already recognises them
from their editor. lucide has no equivalent and never will. So the two sets
coexist with a clean split:

- entry **kind** and every other affordance -> lucide, tinted by theme tokens
- entry **type** (what a file or folder _is_) -> vscode-icons, full colour

## What is vendored, and what is not

`pnpm --filter @sparklab/terminal icons:generate -- --src <checkout>` writes:

| Path                                                           | Contents                                                  |
| -------------------------------------------------------------- | --------------------------------------------------------- |
| `apps/terminal/public/icons/vscode-icons/`                     | 1079 SVGs + upstream `LICENSE` + a provenance `README.md` |
| `apps/terminal/src/features/terminal/file-icons/icon-map.json` | the three lookup tables                                   |

Only icons the map actually references are copied. Deliberately excluded:

- **`*_light_*` variants.** The UI is dark-only (`DESIGN.md`). Upstream ships
  light variants precisely for icons that need adjusting on a light canvas,
  which means the defaults are already the dark-background artwork.
- **`*_opened` folder variants.** The explorer navigates into a directory; it
  has no expanded-folder state to draw.

That is ~2.6 MB of static SVG. It is **not** in the JS bundle: the icons are
plain `<img>` requests against `public/`, so the browser fetches only the
handful on screen and caches them. `public/` is passthrough in the service
worker (only `/_next/static/*` is cache-first), so they behave like any other
static asset.

The lookup map **is** bundled, at **~16.5 KB gzipped** in the page chunk. That
was judged worth it over lazy-loading it: an async map means either a flash of
default icons on first open or an extra loading state in the explorer, for a
one-time saving smaller than a single screenshot.

## How resolution works

`src/features/terminal/file-icons/resolve.ts` mirrors VS Code's own
`getIconClasses`:

1. exact filename — `package.json` -> npm, not the generic json icon
2. longest dotted suffix — `index.d.ts` -> `d.ts` before `ts`; `.env` splits to
   `["", "env"]` so `env` is its only candidate
3. the default icon

with **one deliberate addition**: a name with _no dot at all_ is also looked up
in the extension table. VS Code resolves `Makefile` through its language
service (languageId `makefile`); we have no language service, and upstream
registers `makefile` as an extension key, so this recovers it. It is restricted
to dotless names so it can never override a real extension match.

## The languageId collision, and the canonical-owner rule

Upstream's manifest has a `languageIds` layer that we cannot use — it needs
VS Code's language detection. Folding it into the extension table creates
collisions: **18 extensions are claimed by more than one language.** `.css` is
claimed by both `css` and `tailwindcss`; `.yaml` by `yaml`, `esphome` and
`homeassistant`; `.html` by `html` and `django`.

Upstream settles ties by alphabetical last-wins, which is fine inside VS Code
because languageId is consulted first. Replaying it naively gave `.css` the
**tailwind** icon — caught by a visual contact sheet, not by any test.

The generator therefore applies a canonical-owner rule: **a language whose own
`ids` contains the extension owns it, and no later claimant can take it.** That
reproduces VS Code's answer for css/scss/less/yaml/html/erb/hcl/v/mvt. The
genuinely ambiguous leftovers, where no language is named after the extension
(`.cls` apex vs vba, `.tpl` php vs smarty, `.es` elastic vs js), keep upstream's
last-wins. `.pyx` resolves to python rather than cython for the same reason —
a known, accepted difference.

## Which entries get which icon

| Entry type | Icon                                                   |
| ---------- | ------------------------------------------------------ |
| `dir`      | vscode-icons folder glyph, default folder when unknown |
| `file`     | vscode-icons file glyph, default file when unknown     |
| `symlink`  | lucide `FileSymlink` (unchanged)                       |
| `other`    | lucide `File` (unchanged)                              |

`symlink` and `other` stay on lucide on purpose: those are entry **kinds**, not
file types. A symlink's own name says nothing about its target (which may not
even exist), and the row already renders `→ target` beside it; `other` covers
sockets, FIFOs and devices, which have no file type at all.

## Regenerating

```bash
git clone --depth 1 https://github.com/vscode-icons/vscode-icons /tmp/vscode-icons
pnpm --filter @sparklab/terminal icons:generate -- --src /tmp/vscode-icons
```

The generator replays upstream's `ManifestBuilder` semantics from
`src/iconsManifest/*.ts` rather than shelling out to their build, and throws if
those files stop matching the shape it expects — a loud failure beats a
silently wrong map. `svgo` is applied when available and skipped when not.

It rewrites the icon directory and the map together, and prunes any map entry
whose SVG is missing, so the two can never drift. A unit test
(`__tests__/file-icons.test.ts`) asserts that invariant, which is why
`FileTypeIcon` has no runtime 404 fallback.

## Not done

- No icons in the sidebar session tree, the Notes/PM/Kanban artifacts, or the
  file editor tab strip — the explorer is the only surface wired up.
- No user setting to switch icon themes or turn the icons off.
- The `_opened` folder variants are available upstream if the explorer ever
  grows a tree view with expand/collapse.
