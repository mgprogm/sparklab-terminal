"use client";

/**
 * FileTypeIcon — a vscode-icons file/folder glyph for a directory entry.
 *
 * Rendered as a plain <img> pointing at the vendored SVG under
 * `public/icons/vscode-icons/`. That is deliberate:
 *
 *   - the icons are multi-colour brand marks, so they are never recoloured by
 *     theme tokens the way a lucide glyph is; there is nothing to inline for
 *   - the browser fetches only the handful of icons actually on screen and
 *     caches them, instead of us shipping ~2.6 MB of SVG in the JS bundle
 *   - `public/` is passthrough in the service worker (only `/_next/static/*`
 *     is cache-first), so these behave like any other static asset
 *
 * The map is generated with its icon set, and a unit test asserts every slug
 * it names exists on disk, so there is no runtime 404 path to handle.
 */

import {
  DEFAULT_FILE_ICON,
  DEFAULT_FOLDER_ICON,
  iconUrl,
  resolveFileIconName,
  resolveFolderIconName,
} from "./resolve";

export function FileTypeIcon({
  name,
  kind,
  className = "size-4 shrink-0",
}: {
  /** Entry basename, e.g. `server.ts`. */
  name: string;
  kind: "file" | "dir";
  className?: string;
}) {
  const icon =
    kind === "dir" ? resolveFolderIconName(name) : resolveFileIconName(name);
  const isDefault = icon === DEFAULT_FILE_ICON || icon === DEFAULT_FOLDER_ICON;

  return (
    // A static, already bounded 16px SVG: next/image would add a wrapper and
    // does not optimise SVG anyway.
    <img
      src={iconUrl(icon)}
      alt=""
      aria-hidden="true"
      width={16}
      height={16}
      loading="lazy"
      decoding="async"
      draggable={false}
      className={className}
      // Surfaced for tests and for anyone inspecting why an entry fell back.
      data-icon={icon}
      data-icon-default={isDefault ? "true" : undefined}
    />
  );
}
