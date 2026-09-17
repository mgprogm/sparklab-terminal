/**
 * @vitest-environment node
 *
 * Covers the pure vscode-icons resolver plus the invariant the runtime relies
 * on: every slug the generated map names has a vendored SVG on disk, so
 * FileTypeIcon never has to handle a 404.
 */

import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_FILE_ICON,
  DEFAULT_FOLDER_ICON,
  iconMap,
  iconUrl,
  resolveFileIconName,
  resolveFolderIconName,
} from "../file-icons/resolve";

const PUBLIC_ICONS = path.resolve(
  __dirname,
  "../../../../public/icons/vscode-icons",
);

describe("resolveFileIconName", () => {
  it("matches an exact filename before any extension", () => {
    // `package.json` is npm, not the generic json icon.
    expect(resolveFileIconName("package.json")).toBe("file_type_npm");
    expect(resolveFileIconName("tsconfig.json")).toBe("file_type_tsconfig");
    expect(resolveFileIconName("other.json")).toBe("file_type_json");
  });

  it("resolves plain extensions", () => {
    expect(resolveFileIconName("server.ts")).toBe("file_type_typescript");
    expect(resolveFileIconName("app.tsx")).toBe("file_type_reactts");
    expect(resolveFileIconName("etl.py")).toBe("file_type_python");
    expect(resolveFileIconName("model.sql")).toBe("file_type_sql");
    expect(resolveFileIconName("notebook.ipynb")).toBe("file_type_jupyter");
    expect(resolveFileIconName("main.tf")).toBe("file_type_terraform");
  });

  it("prefers the longest dotted suffix", () => {
    // `d.ts` and `spec.ts` are registered keys; both must beat bare `ts`.
    expect(resolveFileIconName("index.d.ts")).toBe("file_type_typescriptdef");
    expect(resolveFileIconName("store.spec.ts")).toBe("file_type_testts");
    // An unregistered multi-part suffix falls through to the last segment.
    expect(resolveFileIconName("report.2026.q3.sql")).toBe("file_type_sql");
  });

  it("gives a contested extension to the language that names it", () => {
    // Several languages claim these extensions; flattening away VS Code's
    // languageId layer used to hand `.css` to tailwind. See the generator's
    // canonical-owner rule.
    expect(resolveFileIconName("styles.css")).toBe("file_type_css");
    expect(resolveFileIconName("theme.scss")).toBe("file_type_scss");
    expect(resolveFileIconName("old.less")).toBe("file_type_less");
    expect(resolveFileIconName("job.yaml")).toBe("file_type_yaml");
    expect(resolveFileIconName("page.html")).toBe("file_type_html");
    expect(resolveFileIconName("view.erb")).toBe("file_type_erb");
    expect(resolveFileIconName("main.hcl")).toBe("file_type_hashicorp");
  });

  it("resolves dotfiles through their single suffix", () => {
    expect(resolveFileIconName(".gitignore")).toBe("file_type_git");
    expect(resolveFileIconName(".env")).toBe("file_type_dotenv");
  });

  it("resolves a dotless name through the extension table", () => {
    // VS Code gets this via languageId; we allow the dotless fallback instead.
    expect(resolveFileIconName("Makefile")).toBe("file_type_gnu");
    expect(resolveFileIconName("Dockerfile")).toBe("file_type_docker");
  });

  it("is case-insensitive", () => {
    expect(resolveFileIconName("README.MD")).toBe(
      resolveFileIconName("readme.md"),
    );
    expect(resolveFileIconName("Server.TS")).toBe("file_type_typescript");
    expect(resolveFileIconName("PACKAGE.JSON")).toBe("file_type_npm");
  });

  it("strips a directory prefix if one is passed", () => {
    expect(resolveFileIconName("/srv/app/main.py")).toBe("file_type_python");
  });

  it("falls back to the default icon", () => {
    expect(resolveFileIconName("data.qqqqq")).toBe(DEFAULT_FILE_ICON);
    expect(resolveFileIconName("")).toBe(DEFAULT_FILE_ICON);
    expect(resolveFileIconName("noextension-here")).toBe(DEFAULT_FILE_ICON);
  });

  it("stays cheap on a pathological name", () => {
    const name = `${"a.".repeat(5000)}ts`;
    const started = performance.now();
    expect(resolveFileIconName(name)).toBe("file_type_typescript");
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe("resolveFolderIconName", () => {
  it("resolves known directory names", () => {
    expect(resolveFolderIconName("src")).toBe("folder_type_src");
    expect(resolveFolderIconName("node_modules")).toBe("folder_type_node");
    expect(resolveFolderIconName(".github")).toBe("folder_type_github");
  });

  it("is case-insensitive and falls back", () => {
    expect(resolveFolderIconName("SRC")).toBe("folder_type_src");
    expect(resolveFolderIconName("zzz-unknown")).toBe(DEFAULT_FOLDER_ICON);
    expect(resolveFolderIconName("")).toBe(DEFAULT_FOLDER_ICON);
  });

  it("does not resolve a folder through the file tables", () => {
    // `py` is a registered file extension but not a folder name upstream, so
    // the folder lookup must not reach into the extension table.
    expect(resolveFileIconName("x.py")).toBe("file_type_python");
    expect(resolveFolderIconName("py")).toBe(DEFAULT_FOLDER_ICON);
  });
});

describe("the generated map and the vendored assets agree", () => {
  it("names only icons that exist on disk", () => {
    const slugs = new Set<string>([
      DEFAULT_FILE_ICON,
      DEFAULT_FOLDER_ICON,
      ...Object.values(iconMap.fileExtensions).map((i) => `file_type_${i}`),
      ...Object.values(iconMap.fileNames).map((i) => `file_type_${i}`),
      ...Object.values(iconMap.folderNames).map((i) => `folder_type_${i}`),
    ]);

    const missing = [...slugs].filter(
      (slug) => !existsSync(path.join(PUBLIC_ICONS, `${slug}.svg`)),
    );
    expect(missing).toEqual([]);
    expect(slugs.size).toBeGreaterThan(500);
  });

  it("keys are lowercase, so lookups can lowercase once", () => {
    const keys = [
      ...Object.keys(iconMap.fileExtensions),
      ...Object.keys(iconMap.fileNames),
      ...Object.keys(iconMap.folderNames),
    ];
    expect(keys.filter((k) => k !== k.toLowerCase())).toEqual([]);
  });

  it("carries its provenance", () => {
    expect(iconMap.source).toContain("vscode-icons");
    expect(iconMap.license).toBe("MIT");
    expect(iconMap.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("iconUrl", () => {
  it("points at the vendored public path", () => {
    expect(iconUrl("file_type_typescript")).toBe(
      "/icons/vscode-icons/file_type_typescript.svg",
    );
  });
});
