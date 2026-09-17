/**
 * File-type icon resolution, backed by the vscode-icons icon set.
 *
 * `icon-map.json` is GENERATED — see apps/terminal/scripts/generate-file-icons.mjs
 * and docs/FILE-ICONS.md. Don't hand-edit it; regenerate with `pnpm icons:generate`.
 *
 * The lookup order mirrors VS Code's own `getIconClasses`, so a file gets the
 * same icon here as it does in the editor:
 *
 *   1. an exact filename match (`package.json`, `Dockerfile`, `.gitignore`)
 *   2. the longest matching dotted suffix (`app.spec.ts` -> `spec.ts`, then `ts`)
 *   3. the default file icon
 *
 * Step 2 is what makes a dotfile work: `.env` splits to `["", "env"]`, so the
 * only candidate suffix is `env`.
 *
 * One deliberate addition to VS Code's algorithm, in step 2b: a name with NO
 * dot at all is also looked up in the extension table. VS Code resolves
 * `Makefile` through its language service (languageId `makefile`), which we
 * have no equivalent of; upstream registers `makefile` as an extension key, so
 * this recovers that icon. It is restricted to dotless names so it can never
 * override a real extension match.
 */

import rawIconMap from "./icon-map.json";

export interface FileIconMap {
  /** Upstream project the icons and mappings come from. */
  readonly source: string;
  readonly license: string;
  /** vscode-icons release the map was generated from. */
  readonly version: string;
  /** Extension (no leading dot, lowercase) -> icon slug. */
  readonly fileExtensions: Readonly<Record<string, string>>;
  /** Whole filename (lowercase) -> icon slug. */
  readonly fileNames: Readonly<Record<string, string>>;
  /** Directory name (lowercase) -> icon slug. */
  readonly folderNames: Readonly<Record<string, string>>;
}

export const iconMap: FileIconMap = rawIconMap;

/** Public path the generator vendors the SVGs to. */
export const ICON_BASE_PATH = "/icons/vscode-icons";

export const DEFAULT_FILE_ICON = "default_file";
export const DEFAULT_FOLDER_ICON = "default_folder";

/**
 * Longest dotted suffix any extension key uses (`buf.gen.yaml` -> 2). Bounds
 * the candidate loop so a pathological name full of dots stays cheap.
 */
const maxExtensionDots = Object.keys(iconMap.fileExtensions).reduce(
  (max, key) => Math.max(max, key.split(".").length - 1),
  0,
);

/** Strip any directory part; the explorer passes bare names, but be defensive. */
function basename(name: string): string {
  const cut = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  return cut === -1 ? name : name.slice(cut + 1);
}

/** Resolve a file name to a vscode-icons slug (without the `file_type_` prefix). */
export function resolveFileIconName(name: string): string {
  const lower = basename(name).toLowerCase();
  if (!lower) return DEFAULT_FILE_ICON;

  const byName = iconMap.fileNames[lower];
  if (byName) return `file_type_${byName}`;

  const segments = lower.split(".");
  if (segments.length === 1) {
    // Dotless name (see the module comment): `Makefile`, `Gemfile`.
    const dotless = iconMap.fileExtensions[lower];
    return dotless ? `file_type_${dotless}` : DEFAULT_FILE_ICON;
  }

  // Longest suffix first, bounded by the longest key the map actually holds.
  const first = Math.max(1, segments.length - 1 - maxExtensionDots);
  for (let i = first; i < segments.length; i++) {
    const candidate = iconMap.fileExtensions[segments.slice(i).join(".")];
    if (candidate) return `file_type_${candidate}`;
  }

  return DEFAULT_FILE_ICON;
}

/** Resolve a directory name to a vscode-icons slug. */
export function resolveFolderIconName(name: string): string {
  const lower = basename(name).toLowerCase();
  if (!lower) return DEFAULT_FOLDER_ICON;
  const byName = iconMap.folderNames[lower];
  return byName ? `folder_type_${byName}` : DEFAULT_FOLDER_ICON;
}

/** Public URL of a resolved icon slug. */
export function iconUrl(iconName: string): string {
  return `${ICON_BASE_PATH}/${iconName}.svg`;
}
