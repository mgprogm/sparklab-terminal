// Copies xterm.js + addons from node_modules into public/vendor/ so the
// frontend loads them locally (no CDN — required for CSP/offline). Runs on
// `npm install` via the postinstall hook; also runnable with `npm run vendor`.
import { mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public", "vendor");

const assets = [
  ["@xterm/xterm/lib/xterm.js", "xterm.js"],
  ["@xterm/xterm/css/xterm.css", "xterm.css"],
  ["@xterm/addon-fit/lib/addon-fit.js", "addon-fit.js"],
  ["@xterm/addon-webgl/lib/addon-webgl.js", "addon-webgl.js"],
  ["@xterm/addon-web-links/lib/addon-web-links.js", "addon-web-links.js"],
];

// Fonts (Cursor-inspired theme): Inter for UI chrome, JetBrains Mono for the
// terminal + code surfaces. Variable (weight-axis) woff2, latin subset.
const fonts = [
  ["@fontsource-variable/inter/files/inter-latin-wght-normal.woff2", "inter-latin.woff2"],
  ["@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2", "jetbrains-mono-latin.woff2"],
];

mkdirSync(out, { recursive: true });
for (const [src, dest] of assets) {
  copyFileSync(join(root, "node_modules", src), join(out, dest));
}

const fontsOut = join(out, "fonts");
mkdirSync(fontsOut, { recursive: true });
for (const [src, dest] of fonts) {
  copyFileSync(join(root, "node_modules", src), join(fontsOut, dest));
}
console.log(`vendored ${assets.length} xterm assets + ${fonts.length} fonts into public/vendor/`);
