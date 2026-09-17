#!/usr/bin/env node
/**
 * generate-file-icons.mjs — regenerate the vscode-icons file-type icon set.
 *
 * Reads a vscode-icons checkout (https://github.com/vscode-icons/vscode-icons,
 * MIT) and emits two things into apps/terminal:
 *
 *   public/icons/vscode-icons/<icon>.svg   the icon assets actually referenced
 *   src/features/terminal/file-icons/icon-map.json   name -> icon lookup tables
 *
 * The lookup tables are built by replaying upstream's own ManifestBuilder
 * semantics (src/iconsManifest/manifestBuilder.ts) so our resolution matches
 * what the extension does in VS Code:
 *
 *   - entries with `disabled: true` are alternates and are skipped
 *   - entries are processed sorted by icon name, so a later icon wins a key
 *   - `filename: true` entries populate fileNames (verbatim, incl. leading dot)
 *   - every other entry populates fileExtensions with the first dot removed
 *   - `filenamesGlob x extensionsGlob` are combined with "." and populated the
 *     same way
 *   - a `languages` entry additionally contributes its knownExtensions /
 *     knownFilenames, but explicit extensions/filenames override those
 *   - folder names are used verbatim
 *
 * Light-theme and "_opened" variants are deliberately not vendored: the
 * terminal UI is dark-only (DESIGN.md) and the file explorer has no expanded
 * folder state.
 *
 * Usage:
 *   node apps/terminal/scripts/generate-file-icons.mjs --src <vscode-icons checkout>
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..");
const ICON_OUT_DIR = path.join(APP_ROOT, "public", "icons", "vscode-icons");
const MAP_OUT_DIR = path.join(
  APP_ROOT,
  "src",
  "features",
  "terminal",
  "file-icons",
);

function parseArgs(argv) {
  const args = { src: process.env.VSCODE_ICONS_SRC ?? "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--src") args.src = argv[++i];
  }
  if (!args.src) {
    throw new Error(
      "--src <path to a vscode-icons checkout> is required (or set VSCODE_ICONS_SRC)",
    );
  }
  return args;
}

/**
 * Load upstream's three data modules. They are TypeScript, but the only TS
 * syntax they use is the `../models` import plus a single type annotation on
 * each `export const`, so a narrow, explicit rewrite is enough — and it throws
 * if upstream's shape changes rather than silently producing a wrong map.
 */
async function loadUpstreamData(srcDir) {
  const manifestDir = path.join(srcDir, "src", "iconsManifest");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vscode-icons-gen-"));

  const FILE_FORMAT_SHIM =
    "const FileFormat = { svg: 'svg', png: 'png', jpg: 'jpg', " +
    "gif: 'gif', bmp: 'bmp', tiff: 'tiff', ico: 'ico' };\n";

  const rewrite = (source, file) => {
    const importLine = /^import\s+\{[^}]*\}\s+from\s+'\.\.\/models';\s*$/m;
    if (!importLine.test(source)) {
      throw new Error(`${file}: expected a "from '../models'" import`);
    }
    let out = source.replace(importLine, "");
    out = out.replace(/from '\.\/languages'/g, "from './languages.mjs'");
    // `export const extensions: IFileCollection = {` -> drop the annotation.
    const annotated = /^(export const \w+)\s*:\s*I\w+\s*=/m;
    out = out.replace(annotated, "$1 =");
    // `} satisfies Record<string, ILanguage>;` -> `};`
    out = out.replace(/\s+satisfies\s+[^;]+;/g, ";");
    if (/:\s*I[A-Z]\w*\s*[=;]/.test(out) || /\bsatisfies\b/.test(out)) {
      throw new Error(`${file}: unexpected leftover TypeScript syntax`);
    }
    return FILE_FORMAT_SHIM + out;
  };

  for (const name of ["languages", "supportedExtensions", "supportedFolders"]) {
    const source = await fs.readFile(
      path.join(manifestDir, `${name}.ts`),
      "utf8",
    );
    await fs.writeFile(path.join(tmp, `${name}.mjs`), rewrite(source, name));
  }

  const files = await import(
    pathToFileURL(path.join(tmp, "supportedExtensions.mjs")).href
  );
  const folders = await import(
    pathToFileURL(path.join(tmp, "supportedFolders.mjs")).href
  );
  await fs.rm(tmp, { recursive: true, force: true });
  return { files: files.extensions, folders: folders.extensions };
}

/** Upstream Utils.removeFirstDot. */
const removeFirstDot = (txt) => txt.replace(/^\./, "");

/** Upstream Utils.combine: every filenameGlob joined to every extensionGlob. */
const combine = (a, b) => a.flatMap((x) => b.map((y) => `${x}.${y}`));

function buildFileTables(files) {
  // Upstream sorts by icon name before reducing, so collisions resolve
  // deterministically in favour of the alphabetically-later icon.
  const supported = files.supported
    .filter((f) => !f.disabled && f.icon)
    .sort((a, b) => (a.icon < b.icon ? -1 : a.icon > b.icon ? 1 : 0));

  const langExtensions = {};
  // Extensions claimed by a language that NAMES them (`ids` contains the
  // extension). See the note below.
  const langExtensionsCanonical = new Set();
  const langFileNames = {};
  const fileExtensions = {};
  const fileNames = {};

  for (const entry of supported) {
    const icon = entry.icon;

    for (const lang of entry.languages ?? []) {
      const ids = Array.isArray(lang.ids) ? lang.ids : [lang.ids];
      for (const ext of lang.knownExtensions ?? []) {
        // Several languages can claim one extension -- `.css` is claimed by
        // both `css` and `tailwindcss`, `.yaml` by `yaml`, `esphome` and
        // `homeassistant`. VS Code settles this with the languageId it detects
        // for the file, which we have no equivalent of, and plain last-wins
        // would hand `.css` to tailwind.
        //
        // So: a language whose own id IS the extension is treated as its
        // canonical owner and is never overwritten by a later claimant. That
        // reproduces VS Code's choice for css/scss/less/yaml/html/erb/hcl; the
        // genuinely ambiguous leftovers (`.cls`, `.tpl`, `.es`) keep upstream's
        // alphabetical last-wins.
        const canonical = ids.includes(ext);
        if (langExtensionsCanonical.has(ext) && !canonical) continue;
        if (canonical) langExtensionsCanonical.add(ext);
        langExtensions[ext] = icon;
      }
      for (const name of lang.knownFilenames ?? []) langFileNames[name] = icon;
    }

    const populate = (extension) => {
      if (entry.filename) fileNames[extension] = icon;
      else fileExtensions[removeFirstDot(extension)] = icon;
    };

    for (const extension of entry.extensions ?? []) populate(extension);

    if (entry.filenamesGlob?.length && entry.extensionsGlob?.length) {
      for (const combined of combine(entry.filenamesGlob, entry.extensionsGlob))
        populate(combined);
    }
  }

  // Explicit names/extensions win over language-derived ones (manifestBuilder
  // spreads them in that order).
  return {
    fileExtensions: { ...langExtensions, ...fileExtensions },
    fileNames: { ...langFileNames, ...fileNames },
  };
}

function buildFolderTable(folders) {
  const supported = folders.supported
    .filter((f) => !f.disabled && f.icon)
    .sort((a, b) => (a.icon < b.icon ? -1 : a.icon > b.icon ? 1 : 0));

  const folderNames = {};
  for (const entry of supported) {
    for (const extension of entry.extensions ?? []) {
      folderNames[extension] = entry.icon;
    }
  }
  return folderNames;
}

/** Lowercase every key; upstream lookups are case-insensitive. */
function lowerKeys(table, label) {
  const out = {};
  for (const [key, value] of Object.entries(table)) {
    const lower = key.toLowerCase();
    if (lower in out && out[lower] !== value) {
      // Keep the alphabetically-later icon, matching the sort above.
      out[lower] = out[lower] < value ? value : out[lower];
      continue;
    }
    out[lower] = value;
  }
  if (Object.keys(out).length === 0) throw new Error(`${label}: empty table`);
  return sortObject(out);
}

const sortObject = (obj) =>
  Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : 1)));

async function copyIcons(srcDir, fileIcons, folderIcons) {
  const iconsDir = path.join(srcDir, "icons");
  await fs.rm(ICON_OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(ICON_OUT_DIR, { recursive: true });

  const wanted = [
    ...[...fileIcons].map((i) => `file_type_${i}.svg`),
    ...[...folderIcons].map((i) => `folder_type_${i}.svg`),
    "default_file.svg",
    "default_folder.svg",
  ];

  const missing = [];
  let bytes = 0;
  for (const name of wanted) {
    const from = path.join(iconsDir, name);
    try {
      const svg = await fs.readFile(from);
      await fs.writeFile(path.join(ICON_OUT_DIR, name), svg);
      bytes += svg.length;
    } catch {
      missing.push(name);
    }
  }
  return { copied: wanted.length - missing.length, missing, bytes };
}

function optimizeIcons() {
  // svgo is optional: the icons are valid and usable without it, it just makes
  // them ~30% smaller. Never fail the generation over a missing optimizer.
  try {
    execFileSync(
      "npx",
      ["--yes", "svgo@3", "--quiet", "--recursive", "--folder", ICON_OUT_DIR],
      { stdio: "pipe", timeout: 10 * 60_000 },
    );
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const { src } = parseArgs(process.argv.slice(2));
  const srcDir = path.resolve(src);

  const pkg = JSON.parse(
    await fs.readFile(path.join(srcDir, "package.json"), "utf8"),
  );
  if (pkg.name !== "vscode-icons") {
    throw new Error(`${srcDir} is not a vscode-icons checkout (${pkg.name})`);
  }

  const { files, folders } = await loadUpstreamData(srcDir);
  const raw = buildFileTables(files);
  const fileExtensions = lowerKeys(raw.fileExtensions, "fileExtensions");
  const fileNames = lowerKeys(raw.fileNames, "fileNames");
  const folderNames = lowerKeys(buildFolderTable(folders), "folderNames");

  const fileIcons = new Set([
    ...Object.values(fileExtensions),
    ...Object.values(fileNames),
  ]);
  const folderIcons = new Set(Object.values(folderNames));

  const { copied, missing, bytes } = await copyIcons(
    srcDir,
    fileIcons,
    folderIcons,
  );

  // An icon named in the map but absent on disk would render as a broken
  // image, so drop it and fall back to the default rather than ship a 404.
  const present = new Set(
    (await fs.readdir(ICON_OUT_DIR)).map((f) => f.replace(/\.svg$/, "")),
  );
  const prune = (table, prefix) =>
    Object.fromEntries(
      Object.entries(table).filter(([, icon]) => present.has(prefix + icon)),
    );

  const manifest = {
    // Provenance, so a reader can tell exactly what produced this file.
    source: "https://github.com/vscode-icons/vscode-icons",
    license: "MIT",
    version: pkg.version,
    generatedBy: "apps/terminal/scripts/generate-file-icons.mjs",
    fileExtensions: prune(fileExtensions, "file_type_"),
    fileNames: prune(fileNames, "file_type_"),
    folderNames: prune(folderNames, "folder_type_"),
  };

  await fs.mkdir(MAP_OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(MAP_OUT_DIR, "icon-map.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );

  const optimized = optimizeIcons();
  const finalBytes = (
    await Promise.all(
      (await fs.readdir(ICON_OUT_DIR)).map(
        async (f) => (await fs.stat(path.join(ICON_OUT_DIR, f))).size,
      ),
    )
  ).reduce((a, b) => a + b, 0);

  const digest = createHash("sha256")
    .update(JSON.stringify(manifest))
    .digest("hex")
    .slice(0, 12);

  console.log(`vscode-icons v${pkg.version} (${digest})`);
  console.log(
    `  fileExtensions ${Object.keys(manifest.fileExtensions).length}`,
  );
  console.log(`  fileNames      ${Object.keys(manifest.fileNames).length}`);
  console.log(`  folderNames    ${Object.keys(manifest.folderNames).length}`);
  console.log(
    `  icons          ${copied} copied, ${missing.length} missing` +
      (missing.length ? ` (${missing.slice(0, 5).join(", ")}...)` : ""),
  );
  console.log(
    `  size           ${(bytes / 1e6).toFixed(2)} MB -> ` +
      `${(finalBytes / 1e6).toFixed(2)} MB` +
      (optimized ? " (svgo)" : " (svgo unavailable, left as-is)"),
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
