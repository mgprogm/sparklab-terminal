/**
 * Render-side cover for the file-type icons: which glyph an entry draws, and
 * that the Appearance "plain" setting really falls back to the pre-feature
 * lucide pair. The pure resolver is covered separately in file-icons.test.ts.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EntryIcon } from "../file-icons/entry-icon";
import { FileTypeIcon } from "../file-icons/file-type-icon";

/** The one <img> a FileTypeIcon renders, or null when lucide drew an <svg>. */
function iconImg(container: HTMLElement): HTMLImageElement | null {
  return container.querySelector("img");
}

describe("FileTypeIcon", () => {
  it("points at the resolved vendored SVG", () => {
    const { container } = render(<FileTypeIcon name="etl.py" kind="file" />);
    expect(iconImg(container)?.getAttribute("src")).toBe(
      "/icons/vscode-icons/file_type_python.svg",
    );
  });

  it("resolves folders against the folder table", () => {
    const { container } = render(<FileTypeIcon name="src" kind="dir" />);
    expect(iconImg(container)?.getAttribute("src")).toBe(
      "/icons/vscode-icons/folder_type_src.svg",
    );
  });

  it("marks a fallback so it is visible in the DOM", () => {
    const { container } = render(
      <FileTypeIcon name="mystery.qqq" kind="file" />,
    );
    const img = iconImg(container);
    expect(img?.getAttribute("src")).toBe(
      "/icons/vscode-icons/default_file.svg",
    );
    expect(img?.getAttribute("data-icon-default")).toBe("true");
    // A resolved icon must NOT carry the marker.
    const { container: ok } = render(<FileTypeIcon name="a.ts" kind="file" />);
    expect(iconImg(ok)?.getAttribute("data-icon-default")).toBeNull();
  });

  it("is decorative: empty alt, aria-hidden, lazy, not draggable", () => {
    const { container } = render(<FileTypeIcon name="a.ts" kind="file" />);
    const img = iconImg(container);
    expect(img?.getAttribute("alt")).toBe("");
    expect(img?.getAttribute("aria-hidden")).toBe("true");
    expect(img?.getAttribute("loading")).toBe("lazy");
    expect(img?.getAttribute("draggable")).toBe("false");
    // Decorative means it must not surface as an image to assistive tech.
    expect(screen.queryByRole("img")).toBeNull();
  });
});

describe("EntryIcon", () => {
  it("draws vscode-icons for files and dirs", () => {
    const { container: file } = render(
      <EntryIcon type="file" name="main.go" theme="vscode-icons" />,
    );
    expect(iconImg(file)?.getAttribute("src")).toBe(
      "/icons/vscode-icons/file_type_go.svg",
    );

    const { container: dir } = render(
      <EntryIcon type="dir" name="docs" theme="vscode-icons" />,
    );
    expect(iconImg(dir)?.getAttribute("src")).toBe(
      "/icons/vscode-icons/folder_type_docs.svg",
    );
  });

  it("keeps lucide for symlink and other, in BOTH themes", () => {
    // These are entry kinds, not file types -- the theme must not touch them.
    for (const theme of ["vscode-icons", "plain"] as const) {
      for (const type of ["symlink", "other"] as const) {
        const { container } = render(
          <EntryIcon type={type} name="link.ts" theme={theme} />,
        );
        expect(iconImg(container)).toBeNull();
        expect(container.querySelector("svg")).not.toBeNull();
      }
    }
  });

  it('"plain" falls back to lucide for files and dirs', () => {
    const { container: file } = render(
      <EntryIcon type="file" name="main.go" theme="plain" />,
    );
    expect(iconImg(file)).toBeNull();
    expect(file.querySelector("svg")).not.toBeNull();

    const { container: dir } = render(
      <EntryIcon type="dir" name="docs" theme="plain" />,
    );
    expect(iconImg(dir)).toBeNull();
    // The pre-feature folder glyph was chart-2 tinted; keep that exactly.
    expect(dir.querySelector("svg")?.getAttribute("class")).toContain(
      "text-chart-2",
    );
  });
});
